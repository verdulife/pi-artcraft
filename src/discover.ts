/**
 * Finds the two binaries of one app on this machine.
 *
 * The package ships no absolute paths: every candidate comes from an environment override, `PATH`,
 * or the standard install folder of the platform. A miss reports exactly what was tried, so the fix
 * is one environment variable away.
 */

import { statSync } from "node:fs";
import { platformPath, type AppInstall, type CraftAppSpec } from "./apps";

export interface DiscoveryContext {
	/** `process.platform`. */
	readonly platform: string;
	/** Environment variables, normally `process.env`. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether a path exists, injectable so discovery is testable without a filesystem. */
	exists(path: string): boolean;
}

export interface Candidates {
	readonly app: string[];
	readonly cli: string[];
}

/** Raised when an app is installed in a place the package does not know. */
export class InstallNotFoundError extends Error {
	constructor(
		readonly spec: CraftAppSpec,
		readonly missing: { readonly app: boolean; readonly cli: boolean },
		readonly tried: Candidates,
	) {
		super(describe(spec, missing, tried));
		this.name = "InstallNotFoundError";
	}
}

/** Every path that could hold one app's two binaries, in search order. */
export function candidatePaths(spec: CraftAppSpec, context: DiscoveryContext): Candidates {
	const path = platformPath(context.platform);
	const suffix = context.platform === "win32" ? ".exe" : "";
	const app: string[] = [];
	const cli: string[] = [];

	const push = (list: string[], value: string | undefined) => {
		if (value && !list.includes(value)) list.push(value);
	};

	push(app, context.env[spec.env.app]);
	push(cli, context.env[spec.env.cli]);

	const separator = context.platform === "win32" ? ";" : ":";
	for (const directory of (context.env.PATH ?? context.env.Path ?? "").split(separator)) {
		if (!directory) continue;
		push(app, path.join(directory, `${spec.binary}${suffix}`));
		push(cli, path.join(directory, `${spec.cliBinary}${suffix}`));
	}

	for (const directory of installDirectories(spec, context, path)) {
		push(app, path.join(directory, `${spec.binary}${suffix}`));
		push(cli, path.join(directory, `${spec.cliBinary}${suffix}`));
	}

	if (context.platform === "darwin") {
		const bundles = ["/Applications", path.join(context.env.HOME ?? "", "Applications")];
		for (const base of bundles) {
			const contents = path.join(base, `${spec.label}.app`, "Contents");
			push(app, path.join(contents, "MacOS", spec.binary));
			push(cli, path.join(contents, "MacOS", spec.cliBinary));
			push(cli, path.join(contents, "Resources", spec.cliBinary));
		}
	}

	return { app, cli };
}

/** Resolves one app, or throws an error naming the overrides and every path tried. */
export function findInstall(spec: CraftAppSpec, context: DiscoveryContext = systemDiscovery()): AppInstall {
	const candidates = candidatePaths(spec, context);
	const app = candidates.app.find((candidate) => context.exists(candidate));
	const cli = candidates.cli.find((candidate) => context.exists(candidate));

	if (!app || !cli) {
		throw new InstallNotFoundError(spec, { app: app === undefined, cli: cli === undefined }, candidates);
	}

	return { app, cli };
}

/** Discovery against the running machine. */
export function systemDiscovery(): DiscoveryContext {
	return {
		platform: process.platform,
		env: process.env,
		exists: (path) => {
			try {
				statSync(path);
				return true;
			} catch {
				return false;
			}
		},
	};
}

function installDirectories(spec: CraftAppSpec, context: DiscoveryContext, path: ReturnType<typeof platformPath>): string[] {
	const home = context.env.HOME ?? context.env.USERPROFILE ?? "";

	if (context.platform === "win32") {
		return [
			context.env.ProgramFiles ? path.join(context.env.ProgramFiles, spec.label) : "",
			context.env["ProgramFiles(x86)"] ? path.join(context.env["ProgramFiles(x86)"]!, spec.label) : "",
			context.env.LOCALAPPDATA ? path.join(context.env.LOCALAPPDATA, "Programs", spec.label) : "",
		].filter(Boolean);
	}

	const shared = ["/usr/local/bin", "/usr/bin"];
	if (context.platform === "darwin") {
		return [...shared, "/opt/homebrew/bin", home ? path.join(home, ".local", "bin") : ""].filter(Boolean);
	}

	return [
		...shared,
		"/snap/bin",
		path.join("/opt", spec.label),
		path.join("/opt", spec.id),
		home ? path.join(home, ".local", "bin") : "",
	].filter(Boolean);
}

function describe(spec: CraftAppSpec, missing: { app: boolean; cli: boolean }, tried: Candidates): string {
	const wanted = [missing.app ? spec.binary : undefined, missing.cli ? spec.cliBinary : undefined]
		.filter(Boolean)
		.join(" and ");

	const attempted = [...(missing.app ? tried.app : []), ...(missing.cli ? tried.cli : [])];
	const shown = attempted.slice(0, 6).map((candidate) => `\n  ${candidate}`).join("");
	const rest = attempted.length > 6 ? `\n  …and ${attempted.length - 6} more` : "";

	return [
		`${spec.label}: ${wanted} not found.`,
		`Set ${spec.env.app} and ${spec.env.cli} to the two binaries, or install ${spec.label} in a standard folder.`,
		`Looked in:${shown}${rest}`,
	].join("\n");
}
