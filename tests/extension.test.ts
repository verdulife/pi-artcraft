/**
 * What the package registers, the action its command label states, and the rules it publishes.
 * The handlers are captured instead of run against real binaries, so no window opens during the
 * suite.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CRAFT_APPS } from "../src/apps";
import type { CraftController } from "../src/controller";
import craftExtension, { RULES_SECTION, registerToggle, rules } from "../src/extension";

interface CommandDefinition {
	description: string;
	getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, context: unknown) => Promise<void>;
}

interface Captured {
	commands: Map<string, CommandDefinition>;
	servers: Map<string, unknown>;
	handlers: Map<string, Array<(event: unknown, context?: unknown) => unknown>>;
}

/**
 * Mirrors Pi: `extension.commands.set(name, { name, sourceInfo, ...options })` spreads the
 * definition, so `description` is read once at registration time and a new action needs a new
 * registration.
 */
function fakePi(): { api: ExtensionAPI; captured: Captured } {
	const captured: Captured = { commands: new Map(), servers: new Map(), handlers: new Map() };

	const api = {
		registerCommand: (name: string, definition: CommandDefinition) => {
			captured.commands.set(name, {
				description: definition.description,
				getArgumentCompletions: definition.getArgumentCompletions,
				handler: definition.handler,
			});
		},
		registerMcpServer: (name: string, config: unknown) => {
			captured.servers.set(name, config);
		},
		unregisterMcpServer: (name: string) => {
			captured.servers.delete(name);
		},
		on: (event: string, handler: (payload: unknown, context?: unknown) => unknown) => {
			captured.handlers.set(event, [...(captured.handlers.get(event) ?? []), handler]);
			return () => {};
		},
	};

	return { api: api as unknown as ExtensionAPI, captured };
}

/** A controller whose state flips on the first handle(), so the label change is observable. */
function stubController(): CraftController {
	let active = false;
	return {
		async handle() {
			active = !active;
		},
		shutdown() {},
		status: () => (active ? "on" : "off"),
		describe: () => (active ? "Stop FigCraft: release and close" : "Start FigCraft: open and attach"),
	};
}

function promptOptions(): { sections: Record<string, string>; promptGuidelines: string[] } {
	return { sections: {}, promptGuidelines: [] };
}

function emitBeforeAgentStart(captured: Captured, options: ReturnType<typeof promptOptions>) {
	const handlers = captured.handlers.get("before_agent_start") ?? [];
	let result: unknown;
	for (const handler of handlers) {
		result = handler({ type: "before_agent_start", messageType: "user", prompt: "hi", systemPromptOptions: options });
	}
	return result;
}

describe("the package registration", () => {
	test("registers one toggle command per app", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		expect([...captured.commands.keys()]).toEqual(["vectorcraft", "figcraft"]);
	});

	test("the command label states the action it will take, not the current state", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		expect(captured.commands.get("figcraft")?.description).toStartWith("Start FigCraft:");
		expect(captured.commands.get("vectorcraft")?.description).toStartWith("Start VectorCraft:");
	});

	test("registers no MCP server until a toggle runs", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		expect(captured.servers.size).toBe(0);
	});

	test("releases the app it opened on session shutdown, once per app", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		expect(captured.handlers.get("session_shutdown")).toHaveLength(2);
	});
});

describe("the command label", () => {
	test("switches to the stop action after a toggle", async () => {
		const { api, captured } = fakePi();
		const controller = stubController();
		registerToggle(api, CRAFT_APPS.figcraft, controller, () => {});

		expect(captured.commands.get("figcraft")?.description).toStartWith("Start FigCraft:");

		await captured.commands.get("figcraft")?.handler("", {});

		expect(captured.commands.get("figcraft")?.description).toStartWith("Stop FigCraft:");
	});

	test("switches back to the start action after turning the app off", async () => {
		const { api, captured } = fakePi();
		const controller = stubController();
		registerToggle(api, CRAFT_APPS.figcraft, controller, () => {});

		await captured.commands.get("figcraft")?.handler("", {});
		await captured.commands.get("figcraft")?.handler("", {});

		expect(captured.commands.get("figcraft")?.description).toStartWith("Start FigCraft:");
	});

	test("offers the verbs as argument completions", () => {
		const { api, captured } = fakePi();
		registerToggle(api, CRAFT_APPS.figcraft, stubController(), () => {});

		const completions = captured.commands.get("figcraft")?.getArgumentCompletions("o");

		expect(completions?.map((item) => item.value)).toEqual(["on", "off"]);
	});
});

describe("the published rules", () => {
	test("appends its own section and guideline without replacing the prompt", () => {
		const { api, captured } = fakePi();
		craftExtension(api);
		const options = promptOptions();

		const result = emitBeforeAgentStart(captured, options);

		expect(result).toBeUndefined();
		expect(options.sections[RULES_SECTION]).toContain("ArtCraft suite");
		expect(options.promptGuidelines).toHaveLength(1);
		expect(options.promptGuidelines[0]).toContain("never run their headless");
	});

	test("does not duplicate the guideline when the same options are reused", () => {
		const { api, captured } = fakePi();
		craftExtension(api);
		const options = promptOptions();

		emitBeforeAgentStart(captured, options);
		emitBeforeAgentStart(captured, options);

		expect(options.promptGuidelines).toHaveLength(1);
	});

	test("names both ports and the live-app rule", () => {
		const text = rules();

		expect(text).toContain("FigCraft 7980");
		expect(text).toContain("VectorCraft 7979");
		expect(text).toContain("Never generate");
		expect(text).toContain("`--headless`");
		expect(text).toContain("ask before");
	});
});
