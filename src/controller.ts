/**
 * Session-scoped toggle for one app: its MCP server plus the app process that serves it.
 *
 * The automation roots of a running app are fixed when it starts, so turning the toggle on opens the
 * app through `buildLaunch` and turning it off closes only the app this controller opened. Everything
 * the process and the network need sits behind a small host interface, so the logic runs in tests with
 * no window, no port and no Pi session.
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
	handle(args: string): Promise<void>;
	shutdown(): void;
	status(): string;
	/** What `/app` will do right now, for the command menu. */
	describe(): string;
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

	const usage = `Usage: /${app.id} [on | off | status | root <dir> | port <n>] — no argument toggles`;

	function register(install: AppInstall, target: number, root: string, launched?: CraftApp): void {
		try {
			host.registerMcpServer(app.id, buildAttachConfig(app, install, target));
		} catch (error) {
			launched?.close();
			throw error;
		}

		active = { port: target, root, launched };
		host.notify(
			launched
				? `${app.label} MCP on: opened the app on port ${target}, confined to ${root}`
				: `${app.label} MCP on: attached to the app already listening on port ${target} (its automation roots were fixed when it started)`,
			"info",
		);
	}

	async function waitForPort(target: number): Promise<boolean> {
		for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
			if (await host.isListening(target)) return true;
			await host.delay(READINESS_DELAY_MS);
		}

		return false;
	}

	async function start(): Promise<void> {
		if (starting) {
			host.notify(`${app.label} is still starting; try again in a moment`, "warning");
			return;
		}

		starting = true;
		try {
			const root = resolveAutomationRoot(rootOverride, host.cwd);
			const target = port;

			if (await host.isListening(target)) {
				register(host.resolveInstall(), target, root);
				return;
			}

			const install = host.resolveInstall();
			const launch = buildLaunch(app, install, target, root);
			const launched = host.launchApp(launch.command, launch.args);

			if (!(await waitForPort(target))) {
				launched.close();
				throw new Error(
					`${app.label} did not open its control server on port ${target} within ${(READINESS_ATTEMPTS * READINESS_DELAY_MS) / 1000}s (close an instance you opened by hand and try again)`,
				);
			}

			register(install, target, root, launched);
		} finally {
			starting = false;
		}
	}

	function stop(): string {
		const current = active;
		if (!current) return `${app.label} MCP was already off`;

		try {
			host.unregisterMcpServer(app.id);
		} catch {
			// Already released by session teardown.
		}

		active = undefined;

		if (!current.launched) {
			return `${app.label} MCP off; the app keeps running because we did not open it`;
		}

		current.launched.close();
		return `${app.label} MCP off, and the app we opened was closed`;
	}

	function status(): string {
		if (!active) return `${app.label} MCP is off (/${app.id} opens it confined to this folder)`;

		return active.launched
			? `${app.label} MCP is on: app opened on port ${active.port}, confined to ${active.root}`
			: `${app.label} MCP is on: attached to the app on port ${active.port}`;
	}

	/** The menu label states the action, so `/app` never reads like a report of the current state. */
	function describe(): string {
		if (!active) return `Start ${app.label}: open the app confined to this folder and attach its MCP server`;

		return active.launched
			? `Stop ${app.label}: release its MCP server and close the app this session opened`
			: `Stop ${app.label}: release its MCP server and leave the app you opened running`;
	}

	function setRoot(parameters: string[]): void {
		if (parameters.length === 0) {
			host.notify(`Automation root: ${resolveSessionRoot(rootOverride, host.cwd)}`, "info");
			return;
		}

		if (active) {
			host.notify(`${app.label} was fixed when it started: turn it off (/${app.id} off) before changing the root`, "error");
			return;
		}

		const next = parameters.join(" ");
		const previous = rootOverride;
		rootOverride = next;

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
			host.notify(`App port: ${port}`, "info");
			return;
		}

		if (active) {
			host.notify(`${app.label} was fixed when it started: turn it off (/${app.id} off) before changing the port`, "error");
			return;
		}

		port = assertPort(Number(argument));
		host.notify(`App port set to ${port}`, "info");
	}

	async function handle(args: string): Promise<void> {
		const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);

		try {
			switch (verb) {
				case undefined:
					if (active) {
						host.notify(stop(), "info");
						return;
					}
					await start();
					return;

				case "on":
					if (active) {
						host.notify(`${app.label} MCP is already on (/${app.id} off turns it off)`, "info");
						return;
					}
					await start();
					return;

				case "off":
					host.notify(stop(), "info");
					return;

				case "status":
					host.notify(status(), "info");
					return;

				case "root":
					setRoot(rest);
					return;

				case "port":
					setPort(rest[0]);
					return;

				default:
					host.notify(usage, "warning");
			}
		} catch (error) {
			host.notify(errorMessage(error), "error");
		}
	}

	return {
		handle,
		shutdown: () => void stop(),
		status,
		describe,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
