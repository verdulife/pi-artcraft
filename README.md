# pi-artcraft

Pi package for the [Pi coding agent](https://pi.dev) that turns the ArtCraft suite into one command
per app. `figcraft` and `vectorcraft` are toggles: turning one on opens the app with a **control
server confined to the session folder** and registers that app's **MCP server for this session only**;
turning it off releases both, closing only the app this session opened.

Nothing is written to `mcp.json`, so no server is ever on by default and none leaks into another
project.

## Install

```bash
pi install git:github.com/verdulife/pi-artcraft@v0.1.0
```

npm is not published yet; the package is ready for `npm publish` when it is.

## Usage

| Command | Effect |
| --- | --- |
| `/figcraft` | Toggle: off opens the app confined to `cwd` and attaches its MCP server; on releases both |
| `/vectorcraft` | Same for VectorCraft |
| `/<app> on` · `/<app> off` | Explicit forms of the toggle |
| `/<app> status` | Whether the app and its MCP server are on, and for which folder |
| `/<app> root <dir>` | Automation root for the next start (refused while the app is on) |
| `/<app> port <n>` | Control port for the next start (refused while the app is on) |

Each session opens the app with:

```
<app> --control <port> --automation-read-root <root> --automation-write-root <root>
```

The roots are fixed when the app starts, which is why `root` and `port` are refused while it is on,
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
machine (launch, attach to an existing app, readiness failure, double toggle, shutdown) and the prompt
rules.

## License

MIT.
