# ICPC Live Collab

Local-first ICPC/UCup collaboration prototype. A team shares one workspace, one active controller edits/runs code, and other members can watch or request control.

## Current Scope

- Shared room over WebSocket
- One active controller at a time
- Shared files/folders
- Monaco editor frontend
- Console stdin or `input.in` file stdin
- Run C, C++, Python, Java, and Kotlin
- Room snapshot export/import
- Workspace ZIP export for post-contest archive
- Local room persistence under `backend/data/rooms`

## Start Locally

From the repo root:

```powershell
cd backend
npm install
npm run dev
```

Then open:

```text
http://localhost:3001
```

The backend defaults to:

```text
http://localhost:3001
ws://localhost:3001
```

## Two-User Test

1. Open `http://localhost:3001` in two browser tabs.
2. In tab 1, enter a user name and click `Create Room`.
3. Copy the share link or room id.
4. In tab 2, use the same room id with a different user name and click `Join Room`.
5. Tab 2 can request control; the current controller can approve it.

Only the current controller can edit files, create/delete files, change stdin, or run code.

## Runner Health

Check local compiler/interpreter availability:

```powershell
Invoke-RestMethod http://localhost:3001/health/runners
```

The endpoint checks:

- `g++` for C++
- `gcc` for C
- `python` or `python3`
- `javac`
- `kotlinc.bat` or `kotlinc`

## Tests

Backend:

```powershell
cd backend
npm.cmd test
```

This builds TypeScript and runs backend unit/static tests for permissions, room actions, runner behavior, runner health endpoints, deployment config, snapshots, persistence, and workspace export.

VS Code extension:

```powershell
cd vscode-extension
npm.cmd test
```

Frontend:

```powershell
npm.cmd run test:frontend
```

## Persistence

Rooms are saved locally in:

```text
backend/data/rooms
```

That folder is ignored by git. Deleting files there removes saved local rooms.

## Public Deployment

See [PUBLIC_DEPLOY.md](./PUBLIC_DEPLOY.md). The repo can be deployed as one Docker Web Service, so users only need a public URL.

## VS Code Extension

The first VS Code client lives in:

```text
vscode-extension
```

Development:

```powershell
cd vscode-extension
npm.cmd install
npm.cmd run compile
npm.cmd test
```

Open `vscode-extension` in VS Code and press `F5` to launch an Extension Development Host.

## Notes

New rooms intentionally start with an empty workspace. Teams create their own contest files and folders just like they would on a real contest machine.
