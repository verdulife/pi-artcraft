/**
 * One app of the ArtCraft suite: its MCP server plus the app process that serves it.
 *
 * `/app` is the toggle. The flat commands around it (`:on`, `:off`, `:open`, `:sync`, `:status`,
 * `:root`, `:port`) are separate Pi commands, each mapped to one operation here, so nothing has to
 * parse a verb out of an argument string.
 *
 * The automation roots of a running app are fixed when it starts, so the controller opens the app
 * through `buildLaunch` and closes only the app it opened itself. `active` is the single source of
 * truth for registration: a registration never outlives the port it points at, except while a launch
 * is in flight.
 *
 * Everything the process and the network need sits behind a small host interface, so the logic runs
 * in tests with no window, no port and no Pi session.
 */

import {
	assertPort,
	buildAttachConfig,
	buildLaunch,
	resolveAutomationRoot,
	resolveSessionRoot,
	type AppInstall,
	type CraftAppSpec,
	type CraftServerConfig,
} from "./apps";

export type { CraftServerConfig };

export type NotifyType = "info" | "warning" | "error";

/** An app process opened by this controller. */
export interface CraftApp {
	readonly pid: number | undefined;
	close(): void;
}

export interface CraftHost {
	readonly app: CraftAppSpec;
	/** Directory the automation root defaults to. */
	readonly cwd: string;
	notify(message: string, type?: NotifyType): void;
	registerMcpServer(name: string, config: CraftServerConfig): void;
	unregisterMcpServer(name: string): void;
	/** Locates the two binaries, throwing a readable error when the app is not installed. */
	resolveInstall(): AppInstall;
	/** Opens the app detached from this session. */
	launchApp(command: string, args: string[]): CraftApp;
	/** Resolves true when something accepts connections on the loopback port. */
	isListening(port: number): Promise<boolean>;
	/** Waits between two readiness attempts. */
	delay(milliseconds: number): Promise<void>;
}

export interface CraftController {
	/** `/app` with no arguments: the toggle. Anything else is refused with a usage note. */
	handle(args: string): Promise<void>;
	/** `/app:on`: start and attach, or report that it is already on. */
	start(): Promise<void>;
	/** `/app:off`: release the server and close only the app this session opened. */
	off(): Promise<void>;
	/** `/app:open`: make the configured port and root answer, then attach. */
	ensureRunning(): Promise<void>;
	/** `/app:sync`: reconcile this session with what is actually running. */
	resync(): Promise<void>;
	/** `/app:status`: state, port, root and the two binaries in use. */
	status(): string;
	/** `/app:root <dir>`: the automation root for the next start. */
	setRoot(argument: string | undefined): Promise<void>;
	/** `/app:port <n>`: the control port for the next start. */
	setPort(argument: string | undefined): Promise<void>;
	/** What `/app` will do right now, for the command menu. */
	describe(): string;
	shutdown(): void;
}

/** Readiness budget: 60 attempts of 500 ms, far above the half second both apps need here. */
const READINESS_ATTEMPTS = 60;
const READINESS_DELAY_MS = 500;

interface ActiveServer {
	port: number;
	root: string;
	/** The app this controller opened; absent when we attached to one the user had open. */
	launched?: CraftApp;
}

export function createController(host: CraftHost): CraftController {
	const app = host.app;
	let active: ActiveServer | undefined;
	let rootOverride: string | undefined;
	let port = app.defaultPort;
	let starting = false;

	const usage =
		`Usage: /${app.id} takes no arguments; use /${app.id}:on, /${app.id}:off, ` +
		`/${app.id}:open, /${app.id}:sync, /${app.id}:status, /${app.id}:root <dir> or /${app.id}:port <n>`;

	/**
	 * Records the registration for `target`. A registration that cannot be made closes the app we
	 * just opened, so `active` never describes a server Pi does not know about.
	 */
	function attach(install: AppInstall, target: number, root: string, launched?: CraftApp): void {
		try {
			host.registerMcpServer(app.id, buildAttachConfig(app, install, target));
		} catch (error) {
			launched?.close();
			throw error;
		}

		active = { port: target, root, launched };
	}

	/** Drops the registration for a port nothing answers, closing the app if we opened it. */
	function release(): ActiveServer | undefined {
		const current = active;
		if (!current) return undefined;

		try {
			host.unregisterMcpServer(app.id);
		} catch {
			// Already released by session teardown.
		}

		active = undefined;
		current.launched?.close();
		return current;
	}

	async function waitForPort(target: number): Promise<boolean> {
		for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
			if (await host.isListening(target)) return true;
			await host.delay(READINESS_DELAY_MS);
		}

		return false;
	}

	/** Opens the app with `root` and `target`, waits for its control server, then registers it. */
	async function launchAndAttach(root: string, target: number): Promise<void> {
		const install = host.resolveInstall();
		const launch = buildLaunch(app, install, target, root);
		const launched = host.launchApp(launch.command, launch.args);

		if (!(await waitForPort(target))) {
			launched.close();
			throw new Error(
				`${app.label} did not open its control server on port ${target} within ${(READINESS_ATTEMPTS * READINESS_DELAY_MS) / 1000}s (close an instance you opened by hand and try again)`,
			);
		}

		attach(install, target, root, launched);
		host.notify(
			`${app.label} MCP on: opened the app on port ${target}, confined to ${root}`,
			"info",
		);
	}

	function attachText(target: number): string {
		return `${app.label} MCP on: attached to the app already listening on port ${target} (its automation roots were fixed when it started)`;
	}

	async function start(): Promise<void> {
		if (starting) {
			host.notify(`${app.label} is still starting; try again in a moment`, "warning");
			return;
		}

		if (active) {
			host.notify(`${app.label} MCP is already on (/${app.id}:off turns it off)`, "info");
			return;
		}

		starting = true;
		try {
			const root = resolveAutomationRoot(rootOverride, host.cwd);
			const target = port;

			if (await host.isListening(target)) {
				attach(host.resolveInstall(), target, root);
				host.notify(attachText(target), "info");
				return;
			}

			await launchAndAttach(root, target);
		} finally {
			starting = false;
		}
	}

	/**
	 * `/app:open` guarantees a running app on the configured port and root: it attaches to whatever
	 * already answers there, and otherwise drops any stale registration and launches a new one.
	 */
	async function ensureRunning(): Promise<void> {
		if (starting) {
			host.notify(`${app.label} is still starting; try again in a moment`, "warning");
			return;
		}

		const root = resolveAutomationRoot(rootOverride, host.cwd);
		const target = port;

		if (await host.isListening(target)) {
			if (active) {
				host.notify(
					`${app.label} is already up on port ${target} and registered; nothing to reopen (/${app.id}:sync reconciles it)`,
					"info",
				);
				return;
			}

			attach(host.resolveInstall(), target, root);
			host.notify(attachText(target), "info");
			return;
		}

		release();
		starting = true;
		try {
			await launchAndAttach(root, target);
		} finally {
			starting = false;
		}
	}

	/**
	 * `/app:sync` makes this session match reality: the registration follows the app that actually
	 * answers, and a port nothing answers never keeps a server registered.
	 */
	async function resync(): Promise<void> {
		if (starting) {
			host.notify(`${app.label} is still starting; try again in a moment`, "warning");
			return;
		}

		const target = port;

		if (await host.isListening(target)) {
			const current = active;
			if (!current) {
				attach(host.resolveInstall(), target, resolveAutomationRoot(rootOverride, host.cwd));
				host.notify(
					`${app.label} MCP reconnected: registered the app already listening on port ${target}`,
					"info",
				);
				return;
			}

			attach(host.resolveInstall(), current.port, current.root, current.launched);
			host.notify(
				`${app.label} MCP is already in sync on port ${current.port}; the registration was refreshed`,
				"info",
			);
			return;
		}

		if (release()) {
			host.notify(
				`${app.label} MCP released: it is not running on port ${target} any more, so this session is no longer attached (/${app.id}:open opens the app again)`,
				"warning",
			);
			return;
		}

		host.notify(
			`${app.label} is not running on port ${target} (/${app.id}:open opens the app confined to this folder)`,
			"info",
		);
	}

	function stop(): string {
		const current = release();
		if (!current) return `${app.label} MCP was already off`;

		if (!current.launched) {
			return `${app.label} MCP off; the app keeps running because we did not open it`;
		}

		return `${app.label} MCP off, and the app we opened was closed`;
	}

	/** One line per fact: state, the settings the next start uses, and where the binaries are. */
	function status(): string {
		const lines = [
			active
				? active.launched
					? `${app.label} MCP is on: app opened on port ${active.port}, confined to ${active.root}`
					: `${app.label} MCP is on: attached to the app on port ${active.port}`
				: `${app.label} MCP is off (/${app.id}:open opens it confined to this folder)`,
			`Port ${port} · root ${resolveSessionRoot(rootOverride, host.cwd)}`,
		];

		try {
			const install = host.resolveInstall();
			lines.push(`App ${install.app}`, `CLI ${install.cli}`);
		} catch (error) {
			lines.push(errorMessage(error).split("\n")[0] ?? "app not found");
		}

		return lines.join("\n");
	}

	/** The menu label states the action, so `/app` never reads like a report of the current state. */
	function describe(): string {
		if (!active) return `Start ${app.label}: open the app confined to this folder and attach its MCP server`;

		return active.launched
			? `Stop ${app.label}: release its MCP server and close the app this session opened`
			: `Stop ${app.label}: release its MCP server and leave the app you opened running`;
	}

	function setRoot(argument: string | undefined): void {
		if (argument === undefined) {
			host.notify(`Usage: /${app.id}:root <dir>`, "warning");
			return;
		}

		if (active) {
			host.notify(`${app.label} was fixed when it started: turn it off (/${app.id}:off) before changing the root`, "error");
			return;
		}

		const previous = rootOverride;
		rootOverride = argument;

		try {
			resolveAutomationRoot(rootOverride, host.cwd);
		} catch (error) {
			rootOverride = previous;
			throw error;
		}

		host.notify(`Automation root set to ${resolveSessionRoot(rootOverride, host.cwd)}`, "info");
	}

	function setPort(argument: string | undefined): void {
		if (argument === undefined) {
			host.notify(`Usage: /${app.id}:port <n>`, "warning");
			return;
		}

		if (active) {
			host.notify(`${app.label} was fixed when it started: turn it off (/${app.id}:off) before changing the port`, "error");
			return;
		}

		port = assertPort(Number(argument));
		host.notify(`App port set to ${port}`, "info");
	}

	/** Every operation reports through `host.notify`, so a failure is a message, never a throw. */
	async function guard(operation: () => Promise<void> | void): Promise<void> {
		try {
			await operation();
		} catch (error) {
			host.notify(errorMessage(error), "error");
		}
	}

	return {
		handle: (args) =>
			guard(async () => {
				if (args.trim()) {
					host.notify(usage, "warning");
					return;
				}

				if (active) {
					host.notify(stop(), "info");
					return;
				}

				await start();
			}),
		start: () => guard(() => start()),
		off: () => guard(() => void host.notify(stop(), "info")),
		ensureRunning: () => guard(() => ensureRunning()),
		resync: () => guard(() => resync()),
		setRoot: (argument) => guard(() => setRoot(argument)),
		setPort: (argument) => guard(() => setPort(argument)),
		status,
		describe,
		shutdown: () => void stop(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
