/**
 * The per-app controller: the toggle opens the app with its control server confined to the session
 * and registers the MCP server; the flat operations behind `:on`, `:off`, `:open`, `:sync`,
 * `:status`, `:root` and `:port` each do one thing and report their own outcome.
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
	let gate: Promise<void> | undefined;
	let openGate: (() => void) | undefined;

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
			// A launched app answers only once the held readiness probe is released.
			if (gate && launched.length > 0) await gate;
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
		/** Holds the readiness probes of a launched app, as a control server that has not opened yet does. */
		holdListening: () => {
			gate = new Promise<void>((resolve) => {
				openGate = resolve;
			});
			return () => {
				gate = undefined;
				openGate?.();
			};
		},
	};
}

function lastMessage(fake: FakeHost): string {
	return fake.notifications.at(-1)?.message ?? "";
}

function root(): string {
	return mkdtempSync(join(tmpdir(), "artcraft-root-"));
}

describe("the toggle /figcraft", () => {
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

		await controller.off();

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

	test("arguments typed after the toggle are refused with a usage note", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("on");

		expect(lastMessage(fake)).toStartWith("Usage: /figcraft");
		expect(lastMessage(fake)).toContain("/figcraft:on");
		expect(fake.notifications.at(-1)?.type).toBe("warning");
		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(0);
	});
});

describe(":on and :off", () => {
	test(":on twice reports the running server instead of opening a second app", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.start();
		await controller.start();

		expect(fake.launched).toHaveLength(1);
		expect(fake.registered).toHaveLength(1);
		expect(lastMessage(fake)).toContain("already on");
	});

	test(":off releases the server and closes only the app this session opened", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.start();
		await controller.off();

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(fake.launched[0]?.closed).toBe(true);
		expect(lastMessage(fake)).toContain("was closed");
	});

	test(":off while nothing is on reports that it was already off", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.off();

		expect(fake.unregistered).toEqual([]);
		expect(lastMessage(fake)).toContain("already off");
	});

	test("shutdown releases the server and closes the app it opened", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.handle("");
		controller.shutdown();

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(fake.launched[0]?.closed).toBe(true);
	});
});

describe(":open", () => {
	test("relaunches the app with the configured port and root after it died", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);
		const configuredRoot = root();

		await controller.setRoot(configuredRoot);
		await controller.setPort("7999");
		await controller.start();

		expect(fake.launched[0]?.args).toContain(configuredRoot);

		// The app we opened went away: its port answers nothing but the registration is still there.
		fake.setListening(false);
		await controller.ensureRunning();

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(fake.launched).toHaveLength(2);
		expect(fake.launched[1]?.args).toEqual([
			"--control",
			"7999",
			"--automation-read-root",
			configuredRoot,
			"--automation-write-root",
			configuredRoot,
		]);
		expect(fake.launched[1]?.closed).toBe(false);
		expect(fake.registered).toHaveLength(2);
		expect(fake.registered[1]?.args).toEqual(["mcp", "--attach", "7999"]);
		expect(lastMessage(fake)).toContain("opened the app on port 7999");
	});

	test("registers the app that already answers without launching or closing it", async () => {
		const fake = fakeHost();
		fake.setListening(true);
		const controller = createController(fake.host);

		await controller.ensureRunning();

		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(1);
		expect(fake.registered[0]?.args).toEqual(["mcp", "--attach", "7980"]);
		expect(lastMessage(fake)).toContain("attached to the app already listening on port 7980");
	});

	test("reports that it is already up when the app answers and is registered", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.start();
		await controller.ensureRunning();

		expect(fake.launched).toHaveLength(1);
		expect(fake.registered).toHaveLength(1);
		expect(fake.unregistered).toEqual([]);
		expect(lastMessage(fake)).toContain("already up");
	});

	test("reports the readiness failure without leaving a registration behind", async () => {
		const fake = fakeHost({ listenOnLaunch: false });
		const controller = createController(fake.host);

		await controller.ensureRunning();

		expect(fake.registered).toHaveLength(0);
		expect(fake.launched[0]?.closed).toBe(true);
		expect(fake.notifications.at(-1)?.type).toBe("error");
	});
});

describe(":sync", () => {
	test("registers and reports a reconnection when the app answers and nothing is registered", async () => {
		const fake = fakeHost();
		fake.setListening(true);
		const controller = createController(fake.host);

		await controller.resync();

		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(1);
		expect(fake.registered[0]?.args).toEqual(["mcp", "--attach", "7980"]);
		expect(fake.unregistered).toEqual([]);
		expect(lastMessage(fake)).toContain("reconnected");
	});

	test("re-registers idempotently and reports it is already in sync", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.start();
		await controller.resync();

		expect(fake.launched).toHaveLength(1);
		expect(fake.registered).toHaveLength(2);
		expect(fake.registered[1]?.args).toEqual(["mcp", "--attach", "7980"]);
		expect(fake.unregistered).toEqual([]);
		expect(lastMessage(fake)).toContain("already in sync");
	});

	test("releases the stale server and suggests :open when nothing answers but a registration exists", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.start();
		fake.setListening(false);
		await controller.resync();

		expect(fake.unregistered).toEqual(["figcraft"]);
		expect(fake.launched[0]?.closed).toBe(true);
		expect(fake.registered).toHaveLength(1);
		expect(lastMessage(fake)).toContain("not running");
		expect(lastMessage(fake)).toContain("/figcraft:open");
		expect(lastMessage(fake)).not.toContain("reconnected");
		expect(controller.status()).toContain("is off");
	});

	test("reports that the app is not running and suggests :open when nothing answers and nothing is registered", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.resync();

		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(0);
		expect(fake.unregistered).toEqual([]);
		expect(lastMessage(fake)).toContain("not running");
		expect(lastMessage(fake)).toContain("/figcraft:open");
	});
});

describe(":root and :port", () => {
	test("root is used by the next launch and refused while the app is on", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);
		const configured = root();

		await controller.setRoot(configured);
		await controller.start();

		expect(fake.launched[0]?.args).toContain(configured);

		await controller.setRoot(root());

		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("was fixed when it started");
		expect(lastMessage(fake)).toContain("/figcraft:off");
	});

	test("root without a directory prints its own usage and changes nothing", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.setRoot(undefined);

		expect(lastMessage(fake)).toContain("Usage: /figcraft:root <dir>");
		expect(fake.notifications.at(-1)?.type).toBe("warning");
		expect(fake.launched).toHaveLength(0);
	});

	test("root refuses a folder that does not exist", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.setRoot(join(fake.host.cwd, "missing-folder"));

		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("existing folder");
	});

	test("port is validated, refused while on, and used by the next launch when off", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.setPort("70000");

		expect(fake.notifications.at(-1)?.type).toBe("error");
		expect(lastMessage(fake)).toContain("between 1 and 65535");
		expect(fake.launched).toHaveLength(0);

		await controller.start();
		await controller.setPort("7999");

		expect(lastMessage(fake)).toContain("was fixed when it started");

		await controller.off();
		await controller.setPort("7999");
		await controller.start();

		expect(fake.launched[1]?.args).toContain("7999");
		expect(fake.registered[1]?.args).toEqual(["mcp", "--attach", "7999"]);
	});

	test("port without a number prints its own usage", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		await controller.setPort(undefined);

		expect(lastMessage(fake)).toContain("Usage: /figcraft:port <n>");
		expect(fake.notifications.at(-1)?.type).toBe("warning");
	});
});

describe(":status", () => {
	test("reports state, settings and the binaries in use", async () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		const message = controller.status();

		expect(message).toContain("is off");
		expect(message).toContain("Port 7980");
		expect(message).toContain(`root ${fake.host.cwd}`);
		expect(message).toContain(INSTALL.app);
		expect(message).toContain(INSTALL.cli);
		expect(fake.registered).toHaveLength(0);
	});

	test("still reports the settings when the app is not installed", async () => {
		const fake = fakeHost({ missing: true });
		const controller = createController(fake.host);

		const message = controller.status();

		expect(message).toContain("Port 7980");
		expect(message).toContain("not found");
	});

	test("describes the off state without touching the server", () => {
		const fake = fakeHost();
		const controller = createController(fake.host);

		expect(controller.status()).toContain("is off");
		expect(fake.launched).toHaveLength(0);
		expect(fake.registered).toHaveLength(0);
	});
});

describe("the toggle label", () => {
	test("names the action the next toggle takes in each state", async () => {
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

	test("says the app keeps running when we did not open it", async () => {
		const fake = fakeHost();
		fake.setListening(true);
		const controller = createController(fake.host);

		await controller.handle("");

		expect(controller.describe()).toStartWith("Stop FigCraft:");
		expect(controller.describe()).toContain("leave the app you opened running");
	});
});
