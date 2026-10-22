/**
 * The app table and the two command lines each app needs: one to open it with a confined control
 * server, one to attach the MCP server to that port.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	CRAFT_APPS,
	buildAttachConfig,
	buildLaunch,
	resolveAutomationRoot,
	resolveSessionRoot,
	type AppInstall,
} from "../src/apps";

const INSTALL: AppInstall = { app: "/opt/figcraft/figcraft", cli: "/opt/figcraft/figcraft-cli" };

function temporaryDirectory(): string {
	return mkdtempSync(join(tmpdir(), "artcraft-test-"));
}

describe("CRAFT_APPS", () => {
	test("lists both apps with their own binaries and a distinct control port", () => {
		const apps = Object.values(CRAFT_APPS);

		expect(apps.map((app) => app.id)).toEqual(["vectorcraft", "figcraft"]);
		expect(CRAFT_APPS.vectorcraft.binary).toBe("vectorcraft");
		expect(CRAFT_APPS.figcraft.cliBinary).toBe("figcraft-cli");
		expect(CRAFT_APPS.vectorcraft.env.app).toContain("VECTORCRAFT");
		expect(CRAFT_APPS.figcraft.env.cli).toContain("FIGCRAFT");
		expect(CRAFT_APPS.vectorcraft.defaultPort).not.toBe(CRAFT_APPS.figcraft.defaultPort);
	});
});

describe("buildLaunch", () => {
	test("opens each app with a control server confined to the root", () => {
		const root = temporaryDirectory();

		for (const app of Object.values(CRAFT_APPS)) {
			const launch = buildLaunch(app, INSTALL, app.defaultPort, root);

			expect(launch.command).toBe(INSTALL.app);
			expect(launch.args).toEqual([
				"--control",
				String(app.defaultPort),
				"--automation-read-root",
				root,
				"--automation-write-root",
				root,
			]);
		}
	});

	test("refuses a root that does not exist", () => {
		expect(() => buildLaunch(CRAFT_APPS.figcraft, INSTALL, 7980, join(temporaryDirectory(), "missing"))).toThrow(
			/existing folder/,
		);
	});
});

describe("buildAttachConfig", () => {
	test("vectorcraft connects to the app address with its own flag", () => {
		const config = buildAttachConfig(CRAFT_APPS.vectorcraft, INSTALL, 7979);

		expect(config.command).toBe(INSTALL.cli);
		expect(config.args).toEqual(["mcp", "--connect", "127.0.0.1:7979"]);
		expect(config.exposure).toBe("codemode");
	});

	test("figcraft attaches with a bare port and its own flag", () => {
		const config = buildAttachConfig(CRAFT_APPS.figcraft, INSTALL, 7980);

		expect(config.args).toEqual(["mcp", "--attach", "7980"]);
	});

	test("rejects a port outside 1-65535", () => {
		expect(() => buildAttachConfig(CRAFT_APPS.figcraft, INSTALL, 70000)).toThrow(/between 1 and 65535/);
	});
});

describe("resolveAutomationRoot", () => {
	test("returns the session directory when there is no override", () => {
		const cwd = temporaryDirectory();

		expect(resolveAutomationRoot(undefined, cwd)).toBe(cwd);
	});

	test("resolves an override against the session directory", () => {
		const cwd = temporaryDirectory();

		expect(resolveSessionRoot("art", cwd)).toBe(join(cwd, "art"));
	});

	test("refuses an override that is not an existing folder", () => {
		expect(() => resolveAutomationRoot("missing", temporaryDirectory())).toThrow(/existing folder/);
	});
});
