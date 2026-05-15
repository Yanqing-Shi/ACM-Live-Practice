# ICPC Live VS Code Extension

VS Code client for ICPC Live rooms.

## Development

```powershell
cd vscode-extension
npm install
npm.cmd run compile
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Current MVP

- Join an ICPC Live room
- Show room workspace and members
- Show current room/controller status in the status bar
- Open room files through the `icpc-room://` virtual file system
- Sync edits back to the backend when the user is the current controller
- Create, rename, and delete room files/folders
- Request / approve / reject control
- Set console input and stdin mode
- Run the active room file through the backend runner
- Show run history and open saved run output

## Manual Smoke Test

1. Start the backend from the repo root:

   ```powershell
   cd backend
   npm.cmd run build
   npm.cmd start
   ```

2. In another terminal:

   ```powershell
   code vscode-extension
   ```

3. In the VS Code window for this extension, run:

   ```powershell
   npm install
   npm.cmd run compile
   ```

4. Press `F5` to open the Extension Development Host.
5. Run `ICPC Live: Join Room`.
6. Use `http://localhost:3001`, a room id, and a user name.
7. Use the ICPC Live activity bar to create a file, open it, edit it, and run it.
