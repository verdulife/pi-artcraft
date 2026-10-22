/**
 * What the package registers, the action its toggle label states, and the rules it publishes.
 * The handlers are captured instead of run against real binaries, so no window opens during the
 * suite.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CRAFT_APPS } from "../src/apps";
import type { CraftController } from "../src/controller";
import craftExtension, { RULES_SECTION, registerCommands, rules } from "../src/extension";

interface CommandDefinition {
	description: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, context: unknown) => Promise<void>;
}

interface Captured {
	commands: Map<string, CommandDefinition>;
	servers: Map<string, unknown>;
	handlers: Map<string, Array<(event: unknown, context?: unknown) => unknown>>;
}

interface Ui {
	notifications: Array<{ message: string; type?: string }>;
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
		async start() {
			active = true;
		},
		async off() {
			active = false;
		},
		async ensureRunning() {
			active = true;
		},
		async resync() {},
		async setRoot() {},
		async setPort() {},
		shutdown() {},
		status: () => (active ? "on" : "off"),
		describe: () => (active ? "Stop FigCraft: release and close" : "Start FigCraft: open and attach"),
	};
}

/** Records which controller operation each command reached, and with what. */
function recordingController(): { controller: CraftController; calls: string[] } {
	const calls: string[] = [];

	return {
		calls,
		controller: {
			handle: async (args) => void calls.push(`handle:${args}`),
			start: async () => void calls.push("start"),
			off: async () => void calls.push("off"),
			ensureRunning: async () => void calls.push("open"),
			resync: async () => void calls.push("sync"),
			setRoot: async (argument) => void calls.push(`root:${argument ?? ""}`),
			setPort: async (argument) => void calls.push(`port:${argument ?? ""}`),
			shutdown() {},
			status: () => "FigCraft MCP is off\ndone",
			describe: () => "Start FigCraft: open and attach",
		},
	};
}

/** The context a command handler receives, limited to the notification surface it uses. */
function commandContext(ui: Ui): unknown {
	return { cwd: process.cwd(), ui: { notify: (message: string, type?: string) => ui.notifications.push({ message, type }) } };
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

const COMMAND_SUFFIXES = ["", ":on", ":off", ":open", ":sync", ":status", ":root", ":port"];

describe("the package registration", () => {
	test("registers eight flat commands per app", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		const expected = Object.keys(CRAFT_APPS).flatMap((id) =>
			COMMAND_SUFFIXES.map((suffix) => `${id}${suffix}`),
		);
		expect([...captured.commands.keys()]).toEqual(expected);
	});

	test("every command carries a description naming its action", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		for (const [name, definition] of captured.commands) {
			expect(definition.description.length).toBeGreaterThan(0);
			expect(name.length).toBeGreaterThan(0);
		}

		expect(captured.commands.get("figcraft:open")?.description).toContain("Open FigCraft");
		expect(captured.commands.get("figcraft:sync")?.description).toContain("Sync FigCraft");
		expect(captured.commands.get("figcraft:status")?.description).toContain("Status FigCraft");
		expect(captured.commands.get("vectorcraft:on")?.description).toContain("Start VectorCraft");
	});

	test("the toggle label states the action it will take, not the current state", () => {
		const { api, captured } = fakePi();

		craftExtension(api);

		expect(captured.commands.get("figcraft")?.description).toStartWith("Start FigCraft:");
		expect(captured.commands.get("vectorcraft")?.description).toStartWith("Start VectorCraft:");
	});

	test("registers no MCP server until a command runs", () => {
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

describe("the flat command handlers", () => {
	test("routes each command to its own controller operation", async () => {
		const { api, captured } = fakePi();
		const { controller, calls } = recordingController();
		registerCommands(api, CRAFT_APPS.figcraft, controller, () => {});
		const context = commandContext({ notifications: [] });

		await captured.commands.get("figcraft")?.handler("", context);
		await captured.commands.get("figcraft:on")?.handler("", context);
		await captured.commands.get("figcraft:off")?.handler("", context);
		await captured.commands.get("figcraft:open")?.handler("", context);
		await captured.commands.get("figcraft:sync")?.handler("", context);

		expect(calls).toEqual(["handle:", "start", "off", "open", "sync"]);
	});

	test("passes the directory and the port through, and reports the status", async () => {
		const { api, captured } = fakePi();
		const { controller, calls } = recordingController();
		registerCommands(api, CRAFT_APPS.figcraft, controller, () => {});
		const ui: Ui = { notifications: [] };
		const context = commandContext(ui);

		await captured.commands.get("figcraft:root")?.handler("  C:/work/drawings  ", context);
		await captured.commands.get("figcraft:port")?.handler(" 7999 ", context);
		await captured.commands.get("figcraft:status")?.handler("", context);

		expect(calls).toEqual(["root:C:/work/drawings", "port:7999"]);
		expect(ui.notifications).toEqual([{ message: "FigCraft MCP is off\ndone", type: "info" }]);
	});

	test("refuses arguments after the commands that take none", async () => {
		const { api, captured } = fakePi();
		const { controller, calls } = recordingController();
		registerCommands(api, CRAFT_APPS.figcraft, controller, () => {});
		const ui: Ui = { notifications: [] };

		await captured.commands.get("figcraft:status")?.handler("now please", commandContext(ui));

		expect(calls).toEqual([]);
		expect(ui.notifications[0]?.type).toBe("warning");
		expect(ui.notifications[0]?.message).toContain("/figcraft:status takes no arguments");
	});
});

describe("the toggle label", () => {
	test("switches to the stop action after a toggle", async () => {
		const { api, captured } = fakePi();
		const controller = stubController();
		registerCommands(api, CRAFT_APPS.figcraft, controller, () => {});

		expect(captured.commands.get("figcraft")?.description).toStartWith("Start FigCraft:");

		await captured.commands.get("figcraft")?.handler("", {});

		expect(captured.commands.get("figcraft")?.description).toStartWith("Stop FigCraft:");
	});

	test("switches back to the start action after turning the app off", async () => {
		const { api, captured } = fakePi();
		const controller = stubController();
		registerCommands(api, CRAFT_APPS.figcraft, controller, () => {});

		await captured.commands.get("figcraft")?.handler("", {});
		await captured.commands.get("figcraft")?.handler("", {});

		expect(captured.commands.get("figcraft")?.description).toStartWith("Start FigCraft:");
	});

	test("keeps the flat command descriptions static", async () => {
		const { api, captured } = fakePi();
		const controller = stubController();
		registerCommands(api, CRAFT_APPS.figcraft, controller, () => {});

		const before = captured.commands.get("figcraft:on")?.description;

		await captured.commands.get("figcraft")?.handler("", {});

		expect(captured.commands.get("figcraft:on")?.description).toBe(before);
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

	test("names both ports, the flat root and port commands, and the live-app rule", () => {
		const text = rules();

		expect(text).toContain("FigCraft 7980");
		expect(text).toContain("VectorCraft 7979");
		expect(text).toContain("`/<app>:root <dir>`");
		expect(text).toContain("`/<app>:port <n>`");
		expect(text).toContain("Never generate");
		expect(text).toContain("`--headless`");
		expect(text).toContain("ask before");
	});
});
