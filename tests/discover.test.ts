/**
 * Discovery is the part that has to work on a machine the author never sees, so every platform is
 * exercised with an injected filesystem instead of the real one.
 */

import { describe, expect, test } from "bun:test";
import { CRAFT_APPS } from "../src/apps";
import { candidatePaths, findInstall, InstallNotFoundError, type DiscoveryContext } from "../src/discover";

const figcraft = CRAFT_APPS.figcraft;

function context(platform: string, env: Record<string, string | undefined>, present: string[]): DiscoveryContext {
	const known = new Set(present.map((path) => path.replaceAll("\\", "/")));
	return {
		platform,
		env,
		exists: (path) => known.has(path.replaceAll("\\", "/")),
	};
}

describe("findInstall", () => {
	test("finds a Windows install under Program Files", () => {
		const ctx = context(
			"win32",
			{ ProgramFiles: "C:\\Program Files", PATH: "" },
			["C:\\Program Files\\FigCraft\\figcraft.exe", "C:\\Program Files\\FigCraft\\figcraft-cli.exe"],
		);

		expect(findInstall(figcraft, ctx)).toEqual({
			app: "C:\\Program Files\\FigCraft\\figcraft.exe",
			cli: "C:\\Program Files\\FigCraft\\figcraft-cli.exe",
		});
	});

	test("finds a Windows install under LOCALAPPDATA\\Programs", () => {
		const ctx = context(
			"win32",
			{ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "" },
			[
				"C:\\Users\\me\\AppData\\Local\\Programs\\FigCraft\\figcraft.exe",
				"C:\\Users\\me\\AppData\\Local\\Programs\\FigCraft\\figcraft-cli.exe",
			],
		);

		expect(findInstall(figcraft, ctx).app).toContain("Programs\\FigCraft");
	});

	test("prefers the environment override over every other candidate", () => {
		const ctx = context(
			"linux",
			{
				PATH: "/usr/bin",
				CRAFT_FIGCRAFT_APP: "/custom/figcraft",
				CRAFT_FIGCRAFT_CLI: "/custom/figcraft-cli",
			},
			["/usr/bin/figcraft", "/usr/bin/figcraft-cli", "/custom/figcraft", "/custom/figcraft-cli"],
		);

		expect(findInstall(figcraft, ctx)).toEqual({ app: "/custom/figcraft", cli: "/custom/figcraft-cli" });
	});

	test("finds a Linux install on PATH", () => {
		const ctx = context("linux", { PATH: "/usr/bin:/usr/local/bin" }, ["/usr/local/bin/figcraft", "/usr/local/bin/figcraft-cli"]);

		expect(findInstall(figcraft, ctx)).toEqual({ app: "/usr/local/bin/figcraft", cli: "/usr/local/bin/figcraft-cli" });
	});

	test("finds a macOS bundle", () => {
		const ctx = context(
			"darwin",
			{ PATH: "", HOME: "/Users/me" },
			["/Applications/FigCraft.app/Contents/MacOS/figcraft", "/Applications/FigCraft.app/Contents/MacOS/figcraft-cli"],
		);

		expect(findInstall(figcraft, ctx).app).toBe("/Applications/FigCraft.app/Contents/MacOS/figcraft");
	});

	test("reports the environment variables and the paths it tried", () => {
		const ctx = context("linux", { PATH: "" }, []);

		try {
			findInstall(figcraft, ctx);
			throw new Error("expected findInstall to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(InstallNotFoundError);
			const message = (error as Error).message;
			expect(message).toContain("CRAFT_FIGCRAFT_APP");
			expect(message).toContain("figcraft-cli");
			expect(message).toContain("/opt/FigCraft/figcraft");
		}
	});

	test("says which of the two binaries is missing", () => {
		const ctx = context("linux", { PATH: "" }, ["/usr/local/bin/figcraft"]);

		try {
			findInstall(figcraft, ctx);
			throw new Error("expected findInstall to throw");
		} catch (error) {
			expect((error as InstallNotFoundError).missing).toEqual({ app: false, cli: true });
			expect((error as Error).message).toContain("figcraft-cli not found");
		}
	});
});

describe("candidatePaths", () => {
	test("puts the overrides first and keeps separators of the declared platform", () => {
		const ctx = context("win32", { PATH: "C:\\tools", CRAFT_FIGCRAFT_APP: "D:\\apps\\figcraft.exe" }, []);
		const candidates = candidatePaths(figcraft, ctx);

		expect(candidates.app[0]).toBe("D:\\apps\\figcraft.exe");
		expect(candidates.app).toContain("C:\\tools\\figcraft.exe");
		expect(candidates.cli.every((candidate) => candidate.endsWith("figcraft-cli.exe"))).toBe(true);
	});
});
