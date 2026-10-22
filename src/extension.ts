/**
 * ArtCraft suite on demand: one app plus its MCP server per app, for this session only.
 *
 * Every app exposes eight flat commands: `/<app>` is the toggle, and `/<app>:on`, `:off`, `:open`,
 * `:sync`, `:status`, `:root` and `:port` each do exactly one thing. Pi reads a command name up to
 * the first space, so a name may carry `:` and no command needs a verb parser.
 *
 * Turning an app on opens it with a control server confined to the session folder and registers the
 * MCP server that attaches to it; turning it off releases the server and closes only the app this
 * session opened. Nothing is written to `mcp.json`.
 *
 * The toggle label states the action it will perform next ("Start …" / "Stop …"), and it is
 * re-registered after every run so the menu never describes a state instead of an action. The flat
 * commands have static descriptions and need no re-registration.
 *
 * The package also publishes its operating rules: they are appended to the system prompt on every
 * model call, so a fresh session does not have to rediscover that the live app is the only way to
 * draw.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CRAFT_APPS, type CraftAppId, type CraftAppSpec } from "./apps";
import { createController, type CraftController } from "./controller";
import { createSystemHost } from "./host";

export const RULES_SECTION = "artcraft";

const GUI = "ArtCraft suite (FigCraft, VectorCraft)";

const GUIDELINE =
	`${GUI}: draw only through the MCP tools of the live app opened by /figcraft or /vectorcraft; ` +
	"never run their headless generation, conversion or export CLIs unless the user asks for it explicitly.";

/** One flat command: the suffix after the colon, its menu label, and the operation it runs. */
interface FlatCommand {
	readonly suffix: string;
	readonly description: string;
	run(args: string, context: ExtensionCommandContext): Promise<void> | void;
}

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

		registerCommands(pi, app, controller, (context) => {
			sessionContext = context;
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

/**
 * Registers `/app` and its seven flat commands.
 *
 * `registerCommand` overwrites the entry and the command list is rebuilt per request, so the toggle
 * is re-registered after each run and the menu shows the new label without a reload. The flat
 * commands keep their static description, so they are registered once.
 */
export function registerCommands(
	pi: ExtensionAPI,
	app: CraftAppSpec,
	controller: CraftController,
	rememberContext: (context: ExtensionCommandContext) => void,
): void {
	const definition = {
		get description() {
			return controller.describe();
		},
		handler: async (args: string, context: ExtensionCommandContext) => {
			rememberContext(context);
			await controller.handle(args);
			pi.registerCommand(app.id, definition);
		},
	};

	pi.registerCommand(app.id, definition);

	for (const command of flatCommands(app, controller)) {
		pi.registerCommand(`${app.id}:${command.suffix}`, {
			description: command.description,
			handler: async (args: string, context: ExtensionCommandContext) => {
				rememberContext(context);
				await command.run(args, context);
			},
		});
	}
}

function flatCommands(app: CraftAppSpec, controller: CraftController): FlatCommand[] {
	const argument = (args: string): string | undefined => args.trim() || undefined;

	return [
		{
			suffix: "on",
			description: `Start ${app.label}: open the app confined to this folder and attach its MCP server`,
			run: () => controller.start(),
		},
		{
			suffix: "off",
			description: `Stop ${app.label}: release its MCP server, closing only the app this session opened`,
			run: () => controller.off(),
		},
		{
			suffix: "open",
			description: `Open ${app.label}: make sure the app answers on the configured port and root, then attach its MCP server`,
			run: () => controller.ensureRunning(),
		},
		{
			suffix: "sync",
			description: `Sync ${app.label}: register, refresh or release its MCP server to match the app that is actually running`,
			run: () => controller.resync(),
		},
		{
			suffix: "status",
			description: `Status ${app.label}: state, port, root and the two binaries in use`,
			run: (args, context) => {
				if (args.trim()) {
					context.ui.notify(`/${app.id}:status takes no arguments`, "warning");
					return;
				}

				context.ui.notify(controller.status(), "info");
			},
		},
		{
			suffix: "root",
			description: `Root ${app.label}: set the automation root for the next start (/${app.id}:root <dir>)`,
			run: (args) => controller.setRoot(argument(args)),
		},
		{
			suffix: "port",
			description: `Port ${app.label}: set the control port for the next start (/${app.id}:port <n>)`,
			run: (args) => controller.setPort(argument(args)),
		},
	];
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
		"Each app also has one flat command per action: `/<app>:on`, `/<app>:off`, `/<app>:open`, `/<app>:sync`, `/<app>:status`, `/<app>:root <dir>` and `/<app>:port <n>`. When the app may already be running, `/<app>:open` attaches to it instead of opening a second instance.",
		"",
		"- Draw through the MCP tools of the live app the toggle opened.",
		"- Never generate, convert or export through the apps' headless CLIs (`figcraft-cli run|convert|export`, `vectorcraft-cli run|convert`, any `--headless`) unless the user explicitly asks for it.",
		"- Saving and exporting write files: ask before doing either.",
		`- Ports: ${ports}, so both apps can run at once. \`/<app>:root <dir>\` and \`/<app>:port <n>\` are refused while that app is on, because both are fixed when it starts.`,
	].join("\n");
}
