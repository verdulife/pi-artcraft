/**
 * What the package registers, and the rules it publishes. The handlers are captured instead of run,
 * so no window opens during the suite.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import craftExtension, { RULES_SECTION, rules } from "../src/extension";

interface Captured {
	commands: Map<string, { description?: string; handler: (args: string, context: unknown) => Promise<void> }>;
	servers: Map<string, unknown>;
	handlers: Map<string, Array<(event: unknown, context?: unknown) => unknown>>;
}

function fakePi(): { api: ExtensionAPI; captured: Captured } {
	const captured: Captured = { commands: new Map(), servers: new Map(), handlers: new Map() };

	const api = {
		registerCommand: (name: string, definition: Captured["commands"] extends Map<string, infer V> ? V : never) => {
			captured.commands.set(name, definition);
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
		for (const definition of captured.commands.values()) {
			expect(definition.description).toContain("Toggle");
		}
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
