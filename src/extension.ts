/**
 * ArtCraft suite on demand: one app plus its MCP server per app, for this session only.
 *
 * `/<app>` is a toggle. Turning it on opens the app with a control server confined to the session
 * folder and registers the MCP server that attaches to it; turning it off releases the server and
 * closes only the app this session opened. Nothing is written to `mcp.json`.
 *
 * The package also publishes its operating rules: they are appended to the system prompt on every
 * model call, so a fresh session does not have to rediscover that the live app is the only way to
 * draw.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CRAFT_APPS, type CraftAppId } from "./apps";
import { createController } from "./controller";
import { createSystemHost } from "./host";

export const RULES_SECTION = "artcraft";

const GUI = "ArtCraft suite (FigCraft, VectorCraft)";

const GUIDELINE =
	`${GUI}: draw only through the MCP tools of the live app opened by /figcraft or /vectorcraft; ` +
	"never run their headless generation, conversion or export CLIs unless the user asks for it explicitly.";

export default function craftExtension(pi: ExtensionAPI): void {
	let sessionContext: ExtensionCommandContext | undefined;

	const hooks = {
		getCwd: () => sessionContext?.cwd ?? process.cwd(),
		notify: (message: string, type?: "info" | "warning" | "error") => sessionContext?.ui.notify(message, type),
		registerMcpServer: (name: string, config: Parameters<ExtensionAPI["registerMcpServer"]>[1]) =>
			pi.registerMcpServer(name, config),
		unregisterMcpServer: (name: string) => pi.unregisterMcpServer(name),
	};

	for (const id of Object.keys(CRAFT_APPS) as CraftAppId[]) {
		const app = CRAFT_APPS[id];
		const controller = createController(createSystemHost(app, hooks));

		pi.registerCommand(app.id, {
			description: `Toggle the ${app.label} app and its MCP server for this session only`,
			getArgumentCompletions: (prefix) => {
				const verbs = ["on", "off", "status", "root", "port"].filter((verb) => verb.startsWith(prefix));
				return verbs.length > 0 ? verbs.map((verb) => ({ value: verb, label: verb })) : null;
			},
			handler: async (args, ctx) => {
				sessionContext = ctx;
				await controller.handle(args);
			},
		});

		pi.on("session_shutdown", () => {
			controller.shutdown();
		});
	}

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		options.sections[RULES_SECTION] = rules();
		if (!options.promptGuidelines.includes(GUIDELINE)) options.promptGuidelines.push(GUIDELINE);
		return undefined;
	});
}

/** The section this package contributes, generated from the app table so ports cannot drift. */
export function rules(): string {
	const ports = Object.values(CRAFT_APPS)
		.map((app) => `${app.label} ${app.defaultPort}`)
		.join(", ");

	return [
		`## ${GUI}`,
		"",
		"`/figcraft` and `/vectorcraft` are toggles: they open the app with a control server confined to the session folder and register that app's MCP server for this session only. Nothing is written to `mcp.json`.",
		"",
		"- Draw through the MCP tools of the live app the toggle opened.",
		"- Never generate, convert or export through the apps' headless CLIs (`figcraft-cli run|convert|export`, `vectorcraft-cli run|convert`, any `--headless`) unless the user explicitly asks for it.",
		"- Saving and exporting write files: ask before doing either.",
		`- Ports: ${ports}, so both apps can run at once. \`/<app> root <dir>\` and \`/<app> port <n>\` are refused while that app is on, because both are fixed when it starts.`,
	].join("\n");
}
