# ICPC Live: project status

Last updated: 2026-11-14

## Where things stand

The project was restarted in November 2026 to turn the May prototype into something a team can use: open a URL, enter a team code, start a contest. The web app is the primary client.

| Area | State |
| --- | --- |
| Team codes and session tokens | Done. Names cannot be taken over; a refresh or reconnect resumes the seat. |
| Server lock-down | Done. HTTP export needs a member token, import needs the controller, listing and deletion need an admin token; messages are validated and size-capped; joins and room creation are rate limited. |
| Sync protocol | Done. Edits go to other members only, with per-connection acknowledgements so the typist's text is never rolled back. |
| Web app | Done. React + Vite, replaces the old `frontend/` test page. Files and folders are created and renamed inline in the tree. |
| Contest clock | Done. Any length from 1 minute to 30 days; any member can set, start, end and reset it. |
| Runner | Reworked behind an executor interface with output caps, a run queue, and verdicts. |
| Sandbox (nsjail) | **Written, not yet run.** See below. |
| Deployment | Docker Compose + Caddy files written. **Never built.** |
| VS Code extension | Rebuilt (0.2.0): the room opens as the window's folder in the Explorer. Tested automatically inside a real VS Code on Linux. Packaged as a `.vsix`; not on the Marketplace. |

## Not verified yet

These are the things to check before relying on them:

1. **The sandbox and the Docker image.** Docker was not available where this was built. Follow the checklist in [docs/sandbox.md](./docs/sandbox.md). Until it passes, code execution is effectively unsandboxed.
2. **Parts of the VS Code extension.** File operations, typing, hand-over, Run and Join Room are tested inside VS Code 1.146 on Linux. Not covered: the input prompts and menus, Windows and macOS, VS Code connected to WSL or SSH, and the installed `.vsix` outside a development host.
3. **Tunnels.** Cloudflare Quick Tunnel and Tailscale Funnel are documented as free hosting options but have not been tried with this app.
4. **Java and Kotlin runs.** Their tests are skipped on machines without `javac` / `kotlinc`, including the one this was built on.
5. **CI.** `.github/workflows/ci.yml` has not run on GitHub yet.

## Decisions on record

- Web first, then the VS Code extension as an equal client (rebuilt 2026-11-14). Members can mix both in one room.
- In VS Code the room is the window's folder, served by a file system provider, so the Explorer is VS Code's own. Code still runs on the server.
- No accounts: a team code plus a per-seat token issued by the server.
- Problems and judging stay on the external judge. The app times a contest; it knows nothing about problems and does not judge.
- No problem board. A list of problems with status and assignees was built and then removed (2026-11-14): without importing a contest it was a template to fill in by hand, and the team only needs an empty workspace. Rooms saved with a board still load; the board is dropped.
- A new room is an empty workspace. Nothing is pre-created.
- Any member may set, start, end and reset the contest clock. Only the controller touches the workspace.
- Editing is paused while a client is disconnected, so nothing can be typed and then lost if control moved on.
- Hosting: no spend for now. Own PC plus a free tunnel; a paid host is chosen later.
- The extension stays outside the npm workspace (it has its own `package-lock.json`) because VS Code packaging does not handle hoisted dependencies.

## Possible next steps

- Run the sandbox checklist and fix whatever it finds.
- Show the controller's cursor and selection to observers.
- Sample tests per problem (paste input and expected output, run all, show diffs).
- Accounts and saved team history, if the tool gets regular use.
- Publishing the extension to the Marketplace.
- Importing a contest (for example from a Codeforces link), if a problem list is wanted again.

## Working on it

Commands are in the [README](./README.md). The invariant to protect in any change: the controller rule is enforced by the server (`backend/src/permissions.ts`, checked for every message in `backend/src/roomWebSocket.ts`), never only by the clients.
