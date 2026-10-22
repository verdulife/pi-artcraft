/**
 * Per-app descriptors for the ArtCraft suite.
 *
 * A spec is pure data: the control port, the flags that open the app, and how its automation CLI is
 * attached. Where those binaries live is decided at runtime by `discover.ts`, so the same package
 * works on Windows, macOS and Linux.
 */

import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type CraftAppId = "vectorcraft" | "figcraft";

export interface CraftAppSpec {
	readonly id: CraftAppId;
	readonly label: string;
	/** Executable name without its extension, looked up on PATH and in the platform's install folders. */
	readonly binary: string;
	/** Automation CLI name without its extension. */
	readonly cliBinary: string;
	/** Environment variables that point straight at the two binaries. */
	readonly env: { readonly app: string; readonly cli: string };
	/** Control port used unless `/app port` changes it; one per app so both can run at once. */
	readonly defaultPort: number;
	/** App flags that open a control server confined to the root. */
	launchArgs(port: number, root: string): string[];
	/** MCP flags that attach to the app listening on that port. */
	attachArgs(port: number): string[];
}

/** The two binaries of one app, already found on this machine. */
export interface AppInstall {
	readonly app: string;
	readonly cli: string;
}

export interface CraftServerConfig {
	command: string;
	args: string[];
	exposure: "codemode";
	description: string;
}

export interface CraftLaunch {
	command: string;
	args: string[];
}

export const CRAFT_APPS: Record<CraftAppId, CraftAppSpec> = {
	vectorcraft: {
		id: "vectorcraft",
		label: "VectorCraft",
		binary: "vectorcraft",
		cliBinary: "vectorcraft-cli",
		env: { app: "CRAFT_VECTORCRAFT_APP", cli: "CRAFT_VECTORCRAFT_CLI" },
		defaultPort: 7979,
		launchArgs: (port, root) => controlArgs(port, root),
		attachArgs: (port) => ["mcp", "--connect", `127.0.0.1:${port}`],
	},
	figcraft: {
		id: "figcraft",
		label: "FigCraft",
		binary: "figcraft",
		cliBinary: "figcraft-cli",
		env: { app: "CRAFT_FIGCRAFT_APP", cli: "CRAFT_FIGCRAFT_CLI" },
		defaultPort: 7980,
		launchArgs: (port, root) => controlArgs(port, root),
		attachArgs: (port) => ["mcp", "--attach", String(port)],
	},
};

/**
 * Both apps document the same launch shape: `--control <port>` opens the control server and the two
 * automation roots confine every path its commands touch. Repeating the root keeps reads and writes
 * inside the session folder, so a call outside it fails with a readable tool error.
 */
function controlArgs(port: number, root: string): string[] {
	return ["--control", String(port), "--automation-read-root", root, "--automation-write-root", root];
}

/** The command that opens one app confined to `root`. */
export function buildLaunch(app: CraftAppSpec, install: AppInstall, port: number, root: string): CraftLaunch {
	const validatedPort = assertPort(port);
	const validatedRoot = assertExistingDirectory(root, platformPath());

	return { command: install.app, args: app.launchArgs(validatedPort, validatedRoot) };
}

/** The MCP server entry that attaches to one app already listening on `port`. */
export function buildAttachConfig(app: CraftAppSpec, install: AppInstall, port: number): CraftServerConfig {
	const validatedPort = assertPort(port);

	return {
		command: install.cli,
		args: app.attachArgs(validatedPort),
		exposure: "codemode",
		description: `${app.label} MCP: drive the running app on port ${validatedPort}`,
	};
}

/** Validates a port from a command line or a table entry. */
export function assertPort(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`port must be an integer between 1 and 65535: ${value}`);
	}

	return value;
}

/** Resolves the automation root: the session directory, or an override relative to it. */
export function resolveSessionRoot(override: string | undefined, cwd: string, path = platformPath()): string {
	return override ? path.resolve(cwd, override) : cwd;
}

/** The automation root for a session, after refusing one that does not exist. */
export function resolveAutomationRoot(override: string | undefined, cwd: string, path = platformPath()): string {
	return assertExistingDirectory(resolveSessionRoot(override, cwd, path), path);
}

export function assertExistingDirectory(path: string, pathApi = platformPath()): string {
	if (!pathApi.isAbsolute(path)) {
		throw new Error(`automation root must be an absolute path: ${path}`);
	}

	let isDirectory = false;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		isDirectory = false;
	}

	if (!isDirectory) {
		throw new Error(`automation root must be an existing folder: ${path}`);
	}

	return path;
}

/** The path API of the running platform, so Windows separators are never guessed on POSIX. */
export function platformPath(platform: string = process.platform) {
	return platform === "win32" ? win32 : posix;
}
