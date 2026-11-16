# ICPC Live for VS Code

Join an ICPC Live team room from VS Code. The room opens as the window's folder, so the shared workspace is in the normal Explorer and behaves like any other folder.

One member at a time holds control and can edit and run code. Everyone else sees the text as it is typed and can ask for control.

## Using it

1. Install the extension (see below) and click the **ICPC Live** icon in the activity bar.
2. Choose **Join Room** (or **Create Room**), enter the server address, the team code, and your name.
3. The room opens in a new window. If the current window has no folder open, it is reused.

The window says who you are: its folder is named after the team code and your name, for example `ZNA-MR7 (Alice)`, and the status bar starts with your name.

To try a room with several members on one computer, run **Join Room** again with the same team code and a different name. Each name gets its own window. A browser tab on the web app works as another member too.

In the room window:

| To do this | Do this |
| --- | --- |
| Create, rename, delete files and folders | Use the Explorer as usual: New File, New Folder, F2, Delete. Only possible while you hold control. |
| See what the controller types | Just watch: open files update as they type, and your editor follows the file they switch to (`icpcLive.followController`). |
| Ask for control | Click **Request Control** in the **ICPC Live** section under the file tree, the key button in the Explorer's folder header, or the **Request Control** button at the top right of a read-only editor. |
| Give control away | Answer the notification, or use the buttons on the request in the **ICPC Live** section under the file tree. |
| Run the open file | `Ctrl+Enter`, the ▶ button in the editor title, or **ICPC Live: Run File**. Output appears in the **ICPC Live** output panel. |
| Type the program's input | **ICPC Live: Edit Program Input** opens it as a tab beside the code. |
| Use `input.in` instead | **ICPC Live: Choose Input Source**. |
| Set or start the contest clock | Click the clock in the status bar. Lengths like `5h`, `2h30m`, `2:30` or `150` (minutes) are accepted. |
| Invite teammates | **ICPC Live: Copy Invite Link**. They can join from a browser or from VS Code. |

While you do not hold control, the room is read-only: VS Code greys out New File, New Folder, Rename and Delete in the Explorer and locks the editors, and the server refuses changes in any case.

Typing is shared live, without saving. `Ctrl+S` works as usual and only clears the unsaved marker. Editing is paused while the connection is down; your seat is kept and editing resumes when it is back.

## Install

There is no Marketplace listing yet. Build the package and install it from the file:

```sh
cd vscode-extension
npm install
npm run package          # writes icpc-live-vscode-<version>.vsix
code --install-extension icpc-live-vscode-0.2.3.vsix
```

Teammates can install the same `.vsix` file with **Extensions: Install from VSIX…**.

If you use VS Code connected to WSL or SSH, install the extension on the local side (run the command from a Windows or macOS terminal, or use **Install from VSIX…** in a local window). A room window is a local window, so an extension installed only inside WSL is not available to it.

## Development

```sh
npm install
npm test                 # unit tests, including the client against the real server
npm run test:vscode      # starts a real VS Code and drives the extension in it
```

`npm test` and `npm run test:vscode` need the backend built first (`npm run build -w backend` in the repository root); `npm run test:vscode` from the root does that for you. The VS Code test downloads VS Code on first use and runs under `xvfb-run` on Linux, so no window appears. Set `ICPC_LIVE_TEST_HEADFUL=1` to watch it.

Press `F5` in this folder to start an Extension Development Host. Use `npm run watch` to rebuild on change.

### How it works

| File | Role |
| --- | --- |
| `src/roomClient.ts` | The connection: join with a saved seat token, reconnect, acknowledged edits. No VS Code dependency. |
| `src/roomFileSystemProvider.ts` | Serves the room as the `icpc-room://` file system behind the Explorer, and the program input as a one-file file system. |
| `src/extension.ts` | Commands, live typing sync, following the controller, control hand-over. |
| `src/views.ts` | Side-bar views and status bar. |
| `src/protocol.ts` | Copy of `backend/src/protocol.ts`; a test fails if they differ. |

## Not verified

Automated tests cover the Explorer-level file operations, live typing, saving, control hand-over, read-only locking, following, Run, and Join Room opening a new window, including two members joining one room from the same VS Code, all in VS Code 1.146 on Linux. These have not been tried by hand or tested automatically:

- the input prompts of **Join Room** and **Create Room**, the clock menu, and the room menu;
- VS Code on Windows or macOS, and VS Code connected to WSL or SSH;
- the installed `.vsix` in a normal (non-development) VS Code window.
