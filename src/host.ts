/**
 * The real host behind a controller: process, network, discovery and the Pi registrations.
 *
 * Kept apart from `extension.ts` so the wiring can be exercised without a Pi session, and so the
 * controller stays free of `node:child_process` and `node:net`.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import type { CraftAppSpec } from "./apps";
import type { CraftApp, CraftHost, CraftServerConfig, NotifyType } from "./controller";
import { findInstall, systemDiscovery, type DiscoveryContext } from "./discover";

export interface HostHooks {
	getCwd(): string;
	notify(message: string, type?: NotifyType): void;
	registerMcpServer(name: string, config: CraftServerConfig): void;
	unregisterMcpServer(name: string): void;
}

/** A controller host bound to this machine. */
export function createSystemHost(
	app: CraftAppSpec,
	hooks: HostHooks,
	discovery: DiscoveryContext = systemDiscovery(),
): CraftHost {
	return {
		app,
		get cwd() {
			return hooks.getCwd();
		},
		notify: (message, type) => hooks.notify(message, type),
		registerMcpServer: (name, config) => hooks.registerMcpServer(name, config),
		unregisterMcpServer: (name) => hooks.unregisterMcpServer(name),
		resolveInstall: () => findInstall(app, discovery),
		launchApp,
		isListening,
		delay,
	};
}

/** Opens the app detached, so it survives this session and its stdio never reaches the terminal. */
export function launchApp(command: string, args: string[]): CraftApp {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();

	return {
		pid: child.pid,
		close: () => {
			if (child.pid === undefined) return;
			try {
				process.kill(child.pid);
			} catch {
				// Exited on its own.
			}
		},
	};
}

/** Resolves true when the loopback port accepts a connection. */
export function isListening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		const settle = (listening: boolean) => {
			socket.destroy();
			resolve(listening);
		};

		socket.setTimeout(500);
		socket.once("connect", () => settle(true));
		socket.once("timeout", () => settle(false));
		socket.once("error", () => settle(false));
	});
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
