# ICPC Live

A shared "one computer" for an ICPC or UCup team practising remotely.

Three people open the same link, enter a team code, and work in one workspace. Only one of them at a time, the **controller**, can edit files and run code. Everyone else sees every keystroke live and can ask for control. A shared clock counts down the contest.

## What it does

- **Team code, no accounts.** Create a room, share the 6-character code or the invite link.
- **One controller.** The server enforces it: observers cannot edit, run, or change input.
- **Shared editing.** Monaco editor, live for everyone.
- **Run code.** C, C++, Python, Java, and optionally Kotlin, with typed input or an `input.in` file. Results show time and memory when the sandbox is on.
- **Empty workspace.** A new room has no files. The team creates the files and folders it wants, as on a contest machine. The file tree works like an editor's explorer: New File and New Folder buttons, names typed in place, nested entries indented.
- **Contest clock.** A countdown of any length, from 1 minute to 30 days, shown to everyone. Any member can set it, start it, end it, or reset it.
- **Resilient seats.** Refreshing or briefly losing the connection keeps your name and, for 20 seconds, your control.
- **Export.** Download the workspace as a ZIP, or a JSON snapshot that can be imported again.

Problem statements and judging stay on Codeforces, QOJ, or wherever the contest lives. This app does not know about problems and does not judge submissions.

## Run it locally

Requires Node.js 22 and, for running code, the compilers you want (`g++`, `gcc`, `python3`, `javac`, `kotlinc`).

```sh
npm install
npm run build
npm start
```

Open http://localhost:3001, enter a name, and create a room. Open the invite link in two more browser windows to try it with three members.

In this mode submitted code runs **directly on your machine with no sandbox**. That is fine for yourself and people you trust. See [PUBLIC_DEPLOY.md](./PUBLIC_DEPLOY.md) before letting anyone else in.

### Development

```sh
npm run dev        # backend on :3001, restarts on change
npm run dev:web    # web app on :5173 with hot reload, proxied to the backend
```

Open http://localhost:5173.

### Tests

```sh
npm test                               # backend, web app, VS Code extension (unit)
npx playwright install chromium        # once
npm run test:e2e                       # real browsers against the built app
npm run test:vscode                    # the extension inside a real VS Code
```

The extension has its own dependencies: run `npm ci --prefix vscode-extension` once before `npm test`.

| Suite | Where | What it covers |
| --- | --- | --- |
| Backend | `backend/src/**/*.test.ts` | Rooms, seats and tokens, permissions, HTTP authorisation, contest clock, runner, limits, persistence |
| Web | `web/src/lib/lib.test.ts` | File tree, permissions, room state merging, contest clock, session storage |
| Extension | `vscode-extension/src/test` | URI mapping, file-change diffing, clock, and the client against the real server |
| Extension in VS Code | `vscode-extension/src/test-host` | A real VS Code with a room as its folder: Explorer file operations, live typing, saving, hand-over, read-only, Run, Join Room |
| End-to-end | `e2e/` | Real browsers: join by code, edit, run, hand over control, contest clock, file tree, refresh, typing under load, server restart |
| Sandbox | `backend/src/sandbox/sandbox.integration.test.ts` | Hostile programs against the real sandbox. Skipped unless run inside the container. |

## Layout

```text
backend/           Node + Express + ws server (TypeScript)
  src/protocol.ts  Wire protocol, shared with the web app and the extension
  src/sandbox/     How submitted code is executed (direct or nsjail)
  sandbox/         nsjail config, seccomp policy, container entrypoint
web/               React + Vite web app
vscode-extension/  VS Code client for the same rooms
e2e/               Playwright tests
deploy/            Docker Compose and Caddy files
docs/              Design notes
```

## Configuration

All settings are environment variables read by the backend.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | HTTP and WebSocket port |
| `ICPC_DATA_DIR` | `backend/data` | Where rooms are saved (`rooms/<code>.json`) |
| `RUNNER_MODE` | `direct`, or `nsjail` when `NODE_ENV=production` | How code runs. `direct` has no isolation and is refused in production unless `RUNNER_ALLOW_UNSANDBOXED=1`. |
| `RUN_TIME_LIMIT_MS` | `3000` | CPU time per run (1000 to 10000) |
| `RUN_MEMORY_LIMIT_MB` | `256` | Memory per run (sandbox only) |
| `RUN_OUTPUT_LIMIT_BYTES` | `65536` | Output kept per stream before the run is stopped |
| `RUN_MAX_CONCURRENT` | `2` | Runs at once across all rooms; others queue |
| `ENABLE_KOTLIN` | off | Allow Kotlin in the sandbox (needs about 1 GB to compile) |
| `ICPC_MAX_ROOM_MEMBERS` | `6` | Seats per room |
| `ICPC_CONTROLLER_GRACE_MS` | `20000` | How long a disconnected controller keeps control |
| `ICPC_ROOM_MAX_IDLE_DAYS` | `30` | Saved rooms untouched for longer are deleted |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy or tunnel so rate limits see client addresses |
| `ADMIN_TOKEN` | unset | Enables `GET /rooms` and `DELETE /rooms/:id` for requests carrying this bearer token |
| `CORS_ALLOWED_ORIGINS` | none | Extra browser origins allowed to call the HTTP API |

## VS Code extension

`vscode-extension/` joins the same rooms from inside VS Code. The room opens as the window's folder, so files are in the normal Explorer; teammates can mix browser and VS Code freely. See [vscode-extension/README.md](./vscode-extension/README.md).

```sh
npm ci --prefix vscode-extension
npm run package:extension     # builds vscode-extension/icpc-live-vscode-<version>.vsix
npm run test:vscode           # drives the extension inside a real VS Code
```

## Status

See [PROJECT_STATUS_AND_UPDATES.md](./PROJECT_STATUS_AND_UPDATES.md), in particular the list of what has **not** been verified yet.
