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
frontend/test.html
```

The backend defaults to:

```text
http://localhost:3001
ws://localhost:3001
```

## Two-User Test

1. Open `frontend/test.html` in two browser tabs.
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

```powershell
cd backend
npm test
```

This builds TypeScript and runs backend unit tests for room actions, runner behavior, and runner health.

## Persistence

Rooms are saved locally in:

```text
backend/data/rooms
```

That folder is ignored by git. Deleting files there removes saved local rooms.

## Notes

New rooms intentionally start with a blank `main.cpp`. The platform should not pre-fill contest templates because official contests should match the team's real workflow.
