/**
 * The toggle: off opens the app with its control server confined to the session and registers the
 * MCP server; on releases both, closing only the app this controller opened.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CRAFT_APPS, type AppInstall } from "../src/apps";
import { createController, type CraftApp, type CraftHost } from "../src/controller";

const INSTALL: AppInstall = { app: "/apps/figcraft", cli: "/apps/figcraft-cli" };

interface FakeHost {
	host: CraftHost;
	notifications: Array<{ message: string; type?: string }>;
	registered: Array<{ name: string; command: string; args: string[] }>;
	unregistered: string[];
	launched: Array<{ command: string; args: string[]; closed: boolean }>;
	setListening(value: boolean): void;
	holdListening(): () => void;
}

interface FakeOptions {
	/** Whether the launched app answers on its port right away. */
	listenOnLaunch?: boolean;
	/** Makes install discovery fail, as it does when the app is not installed. */
	missing?: boolean;
}

function fakeHost(options: FakeOptions = {}): FakeHost {
	const cwd = mkdtempSync(join(tmpdir(), "artcraft-session-"));
	const notifications: FakeHost["notifications"] = [];
	const registered: FakeHost["registered"] = [];
	const unregistered: string[] = [];
	const launched: FakeHost["launched"] = [];
	let listening = false;
	let gate: (() => void) | undefined;

	const host: CraftHost = {
		app: CRAFT_APPS.figcraft,
		cwd,
		notify: (message, type) => notifications.push({ message, type }),
		registerMcpServer: (name, config) =>
			registered.push({ name, command: config.command, args: config.args }),
		unregisterMcpServer: (name) => {
			unregistered.push(name);
		},
		resolveInstall: () => {
			if (options.missing) throw new Error("FigCraft: figcraft not found.");
			return INSTALL;
		},
		launchApp: (command: string, args: string[]): CraftApp => {
			const record = { command, args, closed: false };
			launched.push(record);
			if (options.listenOnLaunch !== false) listening = true;
			return {
				pid: 4242,
				close: () => {
					record.closed = true;
					// A closed app releases its port, so the next toggle opens a new one.
					listening = false;
				},
			};
		},
		isListening: async () => {
			if (gate) await new Promise<void>((resolve) => (gate = resolve));
			return listening;
		},
		delay: async () => {},
	};

	return {
		host,
		notifications,
		registered,
		unregistered,
		launched,
		setListening: (value) => {
			listening = value;
		},
		holdListening: () => {
			let release: () => void = () => {};
			const blocked = new Promise<void>((resolve) => (release = resolve));
			return () => {
				gate = undefined;
				void blocked;
				release();
			};
		},
	};
}

function lastMessage(fake: FakeHost): string {
	return fake.notifications.at(-1)?.message ?? "";
}

describe("per-app controller toggle", () => {
	test("a bare toggle opens the app confined to the session and registers the MCP server", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("");

		expect(fake.launched).toHaveLength(1);
		expect(fake.launched[0]?.command).toBe(INSTALL.app);
		expect(fake.launched[0]?.args).toEqual([
			"--control",
			"7980",
			"--automation-read-root",
			fake.host.cwd,
			"--automation-write-root",
			fake.host.cwd,
		]);
		expect(fake.registered).toEqual([
			{ name: "figcraft", command: INSTALL.cli, args: ["mcp", "--attach", "7980"] },
		]);
		expect(lastMessage(fake)).toContain("opened the app on port 7980");
	});

	test("a second bare toggle releases the server and closes the app we opened", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("");
		await controller.handle("");

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(fake.launched[0]?.closed).toBe(true);
		expect(lastMessage(fake)).toContain("was closed");
		expect(controller.status()).toContain("is off");
	});

	test("an app that already listens is attached to, never launched, and left running", async () => {
		const fake = fakeHost();
		fake.setListening(true);
		const controller = createController(fake.host);

		await controller.handle("");

		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(1);
		expect(lastMessage(fake)).toContain("attached to the app already listening on port 7980");

		await controller.handle("off");

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(lastMessage(fake)).toContain("keeps running");
	});

	test("a port that never answers closes the app it opened, registers nothing and reports it", async () => {
		const fake = fakeHost({ listenOnLaunch: false });
		const controller = createController(fake.host);

		await controller.handle("");

		expect(fake.registered).toHaveLength(0);
		expect(fake.launched[0]?.closed).toBe(true);
		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("port 7980");
		expect(controller.status()).toContain("is off");
	});

	test("a missing install reports the discovery error and launches nothing", async () => {
		const fake = fakeHost({ missing: true });
		const controller = createController(fake.host);

		await controller.handle("");

		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(0);
		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("not found");
	});

	test("on twice reports the running server instead of opening a second app", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("on");
		await controller.handle("on");

		expect(fake.launched).toHaveLength(1);
		expect(fake.registered).toHaveLength(1);
		expect(lastMessage(fake)).toContain("already on");
	});

	test("a toggle while the first app is still starting does not open a second one", async () => {
		const fake = fakeHost();
		const release = fake.holdListening();
		const controller = createController(fake.host);

		const starting = controller.handle("");
		await controller.handle("");

		expect(fake.launched).toHaveLength(1);
		expect(lastMessage(fake)).toContain("still starting");

		release();
		await starting;

		expect(fake.registered).toHaveLength(1);
	});

	test("root is refused while the app is on and used by the next launch when off", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);
		const root = mkdtempSync(join(tmpdir(), "artcraft-root-"));

		await controller.handle(`config root ${root}`);
		await controller.handle("");

		expect(fake.launched[0]?.args).toContain(root);

		await controller.handle(`config root ${mkdtempSync(join(tmpdir(), "artcraft-other-"))}`);

		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("was fixed when it started");
	});

	test("port is validated, refused while on, and used by the next launch when off", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("config port 70000");

		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("between 1 and 65535");
		expect(fake.launched).toHaveLength(0);

		await controller.handle("");
		await controller.handle("config port 7999");

		expect(lastMessage(fake)).toContain("was fixed when it started");

		await controller.handle("off");
		await controller.handle("config port 7999");
		await controller.handle("");

		expect(fake.launched[1]?.args).toContain("7999");
		expect(fake.registered[1]?.args).toEqual(["mcp", "--attach", "7999"]);
	});

	test("config alone reports state, settings and the binaries in use", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("config");

		const message = lastMessage(fake);
		expect(message).toContain("is off");
		expect(message).toContain("Port 7980");
		expect(message).toContain(`root ${fake.host.cwd}`);
		expect(message).toContain(INSTALL.app);
		expect(message).toContain(INSTALL.cli);
		expect(fake.registered).toHaveLength(0);
	});

	test("config still reports settings when the app is not installed", async () => {
		const fake = fakeHost({ missing: true });
		const controller = createController(fake.host);

		await controller.handle("config");

		expect(lastMessage(fake)).toContain("Port 7980");
		expect(lastMessage(fake)).toContain("not found");
		expect(fake.notifications.at(-1)?.type).toBe("info");
	});

	test("an unknown config key prints its own usage", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("config nope");

		expect(lastMessage(fake)).toContain("Usage: /figcraft config");
		expect(fake.notifications.at(-1)?.type).toBe("warning");
	});

	test("an unknown verb prints the usage lines and changes nothing", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("nonsense");

		expect(lastMessage(fake)).toContain("Usage: /figcraft");
		expect(fake.notifications.at(-1)?.type).toBe("warning");
		expect(fake.registered).toHaveLength(0);
	});

	test("shutdown releases the server and closes the app it opened", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("");
		controller.shutdown();

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(fake.launched[0]?.closed).toBe(true);
	});

	test("status describes the off state without touching the server", () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		expect(controller.status()).toContain("is off");
		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(0);
	});

	test("describe names the action the next toggle takes in each state", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		expect(controller.describe()).toStartWith("Start FigCraft:");
		expect(controller.describe()).toContain("confined to this folder");

		await controller.handle("");

		expect(controller.describe()).toStartWith("Stop FigCraft:");
		expect(controller.describe()).toContain("close the app this session opened");

		await controller.handle("");

		expect(controller.describe()).toStartWith("Start FigCraft:");
	});

	test("describe says the app keeps running when we did not open it", async () => {
		const fake = fakeHost();
		fake.setListening(true);
		const controller = createController(fake.host);

		await controller.handle("");

		expect(controller.describe()).toStartWith("Stop FigCraft:");
		expect(controller.describe()).toContain("leave the app you opened running");
	});
});
