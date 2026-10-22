# pi-artcraft

Pi package for the [Pi coding agent](https://pi.dev) that turns the ArtCraft suite into one command
per app. `figcraft` and `vectorcraft` are toggles: turning one on opens the app with a **control
server confined to the session folder** and registers that app's **MCP server for this session only**;
turning it off releases both, closing only the app this session opened.

Every other action is its own flat command: `/<app>:on`, `/<app>:off`, `/<app>:open`, `/<app>:sync`,
`/<app>:status`, `/<app>:root <dir>` and `/<app>:port <n>`. Pi reads a command name up to the first
space, so a `:` in the name is enough and no command parses a verb.

Nothing is written to `mcp.json`, so no server is ever on by default and none leaks into another
project.

## Install

```bash
pi install git:github.com/verdulife/pi-artcraft@v0.2.0
```

npm is not published yet; the package is ready for `npm publish` when it is.

## Usage

| Command | Effect |
| --- | --- |
| `/figcraft` | Toggle: off opens the app confined to `cwd` and attaches its MCP server; on releases both |
| `/figcraft:on` | Start: open the app and attach its MCP server; says so when it is already on |
| `/figcraft:off` | Stop: release the MCP server, closing only the app this session opened |
| `/figcraft:open` | Make the app answer on the configured port and root, then attach: attach if the port answers, launch if it does not |
| `/figcraft:sync` | Reconcile this session with the running app (see below) |
| `/figcraft:status` | State, port, root and the two binaries in use |
| `/figcraft:root <dir>` | Automation root for the next start (refused while the app is on) |
| `/figcraft:port <n>` | Control port for the next start (refused while the app is on) |
| `/vectorcraft…` | The same eight commands for VectorCraft |

Only the bare toggle accepts no arguments in a special way: it is the only command whose label
changes. Every flat command takes the arguments its description names, and a stray argument is
refused with a one-line usage note.

`/<app>:sync` covers the four states a session can drift into:

| What answers on the configured port | What this session has registered | What `:sync` does |
| --- | --- | --- |
| Yes | Nothing | Registers it and reports a reconnection |
| Yes | A server | Re-registers it unchanged and reports that it is already in sync |
| Nothing | A server | Releases the stale server and reports that the app is not running, suggesting `/<app>:open` |
| Nothing | Nothing | Reports that the app is not running, suggesting `/<app>:open` |

A registration never outlives the port it points at, so `active` is the single source of truth and
no stale server survives a crashed app.

The toggle menu label states the action, not the state: `Start FigCraft: open the app confined to this
folder and attach its MCP server` while it is off, `Stop FigCraft: …` while it is on. The label is
re-registered after every toggle; the flat commands carry static descriptions.

Each session opens the app with:

```
<app> --control <port> --automation-read-root <root> --automation-write-root <root>
```

The roots are fixed when the app starts, which is why `:root` and `:port` are refused while it is on,
and why opening the app from the file explorer is not equivalent: its control server would have no
confinement.

Ports: **FigCraft 7980**, **VectorCraft 7979**, so both can run at once. A port already answering is
attached to instead of launching a second instance, and an app this session did not open is never
closed.

## Where the binaries come from

Nothing is hardcoded. For each app the package looks for the GUI executable and its automation CLI in
this order:

1. `CRAFT_FIGCRAFT_APP` / `CRAFT_FIGCRAFT_CLI` (and the `CRAFT_VECTORCRAFT_*` equivalents).
2. `PATH`.
3. Standard install folders: `%ProgramFiles%\<App>`, `%ProgramFiles(x86)%\<App>`,
   `%LOCALAPPDATA%\Programs\<App>` on Windows; the `.app` bundle plus `/usr/local/bin`,
   `/opt/homebrew/bin` on macOS; `/usr/local/bin`, `/usr/bin`, `/opt/<App>`, `/snap/bin` on Linux.

When something is missing the error names the environment variables and every path it tried.

Set the overrides from your own shell:

```nu
# nushell
$env.CRAFT_FIGCRAFT_APP = "C:/Program Files/FigCraft/figcraft.exe"
```

```powershell
# PowerShell
$env:CRAFT_FIGCRAFT_APP = "C:\Program Files\FigCraft\figcraft.exe"
```

```bash
# bash / zsh
export CRAFT_FIGCRAFT_APP="/Applications/FigCraft.app/Contents/MacOS/figcraft"
```

## Operating rules this package publishes

A Pi package can carry instructions, not just code. On every model call the extension appends this
section to the system prompt, so the workflow holds even in a fresh session:

- Draw through the MCP tools of the live app the toggle opened.
- Never generate, convert or export through the apps' headless CLIs (`figcraft-cli run|convert|export`,
  `vectorcraft-cli run|convert`, any `--headless`) unless the user asks for it explicitly.
- Saving and exporting write files: ask first.

## Develop

```bash
bun test
```

The suite covers the launch/attach command lines, install discovery per platform, the toggle state
machine (launch, attach to an existing app, readiness failure, double toggle, shutdown), the flat
commands behind `:on`/`:off`/`:open`/`:sync`/`:status`/`:root`/`:port` and the prompt rules.

## License

MIT.
