import * as vscode from "vscode";
import { controlRequestNotificationDecision } from "./controlRequestNotifications";
import { createRoom as createRoomOnServer } from "./createRoom";
import { MembersTreeProvider } from "./membersTreeProvider";
import {
  READONLY_ROOM_SCHEME,
  replacementModeForControlChange,
  roomUriStringForController,
  WRITABLE_ROOM_SCHEME,
} from "./permissionModes";
import { RoomClient } from "./roomClient";
import {
  RoomFileSystemProvider,
  uriToWorkspacePath,
  workspacePathToUri,
} from "./roomFileSystemProvider";
import {
  RoomReadonlyDocumentProvider,
  workspacePathToReadonlyUri,
} from "./roomReadonlyDocumentProvider";
import { RoomActionsViewProvider } from "./roomActionsViewProvider";
import { RunHistoryNode, RunHistoryTreeProvider } from "./runHistoryTreeProvider";
import { RoomTreeProvider } from "./roomTreeProvider";
import type { RoomTreeNode } from "./roomTreeModel";
import { createStatusBar } from "./statusBar";

const client = new RoomClient();
type PendingDocumentSync = {
  document: vscode.TextDocument;
  timer: ReturnType<typeof setTimeout>;
};
const pendingDocumentSync = new Map<string, PendingDocumentSync>();
let isRevertingReadonlyEdit = false;
let lastControllerState = false;
let lastControlRequestNotificationKey: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceTree = new RoomTreeProvider(client);
  const membersTree = new MembersTreeProvider(client);
  const runHistoryTree = new RunHistoryTreeProvider(client);
  const roomActionsView = new RoomActionsViewProvider(client);
  const fileSystemProvider = new RoomFileSystemProvider(client);
  const readonlyDocumentProvider = new RoomReadonlyDocumentProvider(client);
  const output = vscode.window.createOutputChannel("ICPC Live");
  const statusBar = createStatusBar(client);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("icpc-room", fileSystemProvider, {
      isCaseSensitive: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      "icpc-room-readonly",
      readonlyDocumentProvider
    ),
    vscode.window.registerTreeDataProvider("icpcLive.workspace", workspaceTree),
    vscode.window.registerTreeDataProvider("icpcLive.members", membersTree),
    vscode.window.registerTreeDataProvider("icpcLive.runHistory", runHistoryTree),
    vscode.window.registerWebviewViewProvider("icpcLive.actions", roomActionsView),
    output,
    statusBar,
    vscode.workspace.onDidChangeTextDocument((event) => {
      syncRoomDocumentSoon(event.document);
    }),
    client.onDidReceiveOutput((message) => {
      output.appendLine(message);
      output.show(true);
    }),
    client.onDidChangeState(() => {
      void reconcileControllerDocumentMode();
      notifyPendingControlRequest();
    }),
    vscode.commands.registerCommand("icpcLive.setServerUrl", setServerUrl),
    vscode.commands.registerCommand("icpcLive.createRoom", createRoom),
    vscode.commands.registerCommand("icpcLive.joinRoom", joinRoom),
    vscode.commands.registerCommand("icpcLive.copyRoomId", copyRoomId),
    vscode.commands.registerCommand("icpcLive.leaveRoom", () => {
      client.disconnect();
      vscode.window.showInformationMessage("Left ICPC Live room");
    }),
    vscode.commands.registerCommand("icpcLive.requestControl", () =>
      safeSend({ type: "request_control" })
    ),
    vscode.commands.registerCommand("icpcLive.approveControl", approveControl),
    vscode.commands.registerCommand("icpcLive.rejectControl", rejectControl),
    vscode.commands.registerCommand("icpcLive.runCode", runCode),
    vscode.commands.registerCommand("icpcLive.createFile", createFile),
    vscode.commands.registerCommand("icpcLive.createFolder", createFolder),
    vscode.commands.registerCommand("icpcLive.renameItem", renameItem),
    vscode.commands.registerCommand("icpcLive.deleteItem", deleteItem),
    vscode.commands.registerCommand("icpcLive.setConsoleInput", setConsoleInput),
    vscode.commands.registerCommand("icpcLive.setStdinMode", setStdinMode),
    vscode.commands.registerCommand("icpcLive.openRunOutput", (node?: RunHistoryNode) => {
      const run = node?.run;
      if (!run) return;
      output.appendLine(run.output || "(No saved output)");
      output.show(true);
    }),
    vscode.commands.registerCommand("icpcLive.openRoomFile", openRoomFile),
    vscode.commands.registerCommand("icpcLive.refresh", () => {
      workspaceTree.refresh();
      membersTree.refresh();
      runHistoryTree.refresh();
    })
  );
}

async function reconcileControllerDocumentMode(): Promise<void> {
  const isController = client.isController;

  if (isController === lastControllerState) {
    return;
  }

  lastControllerState = isController;
  const obsoleteScheme = isController ? READONLY_ROOM_SCHEME : WRITABLE_ROOM_SCHEME;
  const replacements: Promise<void>[] = [];

  for (const editor of vscode.window.visibleTextEditors) {
    const replacementMode = replacementModeForControlChange(
      isController,
      editor.document.uri.scheme
    );

    if (replacementMode) {
      replacements.push(
        replaceVisibleRoomDocument(editor, replacementMode === "writable")
      );
    }
  }

  await Promise.all(replacements);
  await closeRoomTabsWithScheme(obsoleteScheme);
}

async function replaceVisibleRoomDocument(
  editor: vscode.TextEditor,
  writable: boolean
): Promise<void> {
  const path = uriToWorkspacePath(editor.document.uri);
  const uri = writable
    ? workspacePathToUri(client.roomId, path)
    : workspacePathToReadonlyUri(client.roomId, path);
  const document = await vscode.workspace.openTextDocument(uri);

  await vscode.window.showTextDocument(document, {
    viewColumn: editor.viewColumn,
    preserveFocus: true,
    preview: false,
  });
}

async function closeRoomTabsWithScheme(scheme: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) =>
      tabInputUris(tab.input).some(
        (uri) => uri.scheme === scheme && uri.authority === client.roomId
      )
    )
  );

  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

function tabInputUris(input: unknown): vscode.Uri[] {
  if (input instanceof vscode.TabInputText) {
    return [input.uri];
  }

  if (input instanceof vscode.TabInputTextDiff) {
    return [input.original, input.modified];
  }

  return [];
}

function syncRoomDocumentSoon(document: vscode.TextDocument): void {
  if (document.uri.scheme !== WRITABLE_ROOM_SCHEME) return;
  if (isRevertingReadonlyEdit) return;
  if (!client.isController) {
    revertReadonlyEdit(document);
    return;
  }

  const path = uriToWorkspacePath(document.uri);
  const existingTimer = pendingDocumentSync.get(path);

  if (existingTimer) {
    clearTimeout(existingTimer.timer);
  }

  const timer = setTimeout(() => {
    pendingDocumentSync.delete(path);
    saveRoomDocument(document).catch((error) => {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }, 250);

  pendingDocumentSync.set(path, { document, timer });
}

async function saveRoomDocument(document: vscode.TextDocument): Promise<void> {
  if (!client.isController || !document.isDirty) {
    return;
  }

  const saved = await document.save();

  if (!saved) {
    throw new Error("Could not save ICPC Live room file before syncing");
  }
}

async function flushPendingDocumentSyncs(): Promise<boolean> {
  const pending = Array.from(pendingDocumentSync.values());
  pendingDocumentSync.clear();

  for (const entry of pending) {
    clearTimeout(entry.timer);
  }

  const documentsToSave = new Map<string, vscode.TextDocument>();

  for (const entry of pending) {
    documentsToSave.set(entry.document.uri.toString(), entry.document);
  }

  for (const document of vscode.workspace.textDocuments) {
    if (
      document.uri.scheme === WRITABLE_ROOM_SCHEME &&
      document.uri.authority === client.roomId
    ) {
      documentsToSave.set(document.uri.toString(), document);
    }
  }

  try {
    await Promise.all(
      Array.from(documentsToSave.values()).map((document) =>
        saveRoomDocument(document)
      )
    );
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

async function revertReadonlyEdit(document: vscode.TextDocument): Promise<void> {
  const path = uriToWorkspacePath(document.uri);
  const file = client.findFile(path);

  if (!file || document.getText() === file.content) {
    return;
  }

  isRevertingReadonlyEdit = true;

  try {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );

    edit.replace(document.uri, fullRange, file.content);
    await vscode.workspace.applyEdit(edit);
  } finally {
    isRevertingReadonlyEdit = false;
  }
}

function safeSend(message: Parameters<RoomClient["send"]>[0]): void {
  try {
    client.send(message);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function notifyPendingControlRequest(): void {
  const decision = controlRequestNotificationDecision(
    client.state,
    client.userName,
    lastControlRequestNotificationKey
  );

  lastControlRequestNotificationKey = decision.nextNotificationKey;

  if (!decision.requester) {
    return;
  }

  void showControlRequestNotification(decision.requester);
}

async function showControlRequestNotification(requester: string): Promise<void> {
  const accept = "Accept";
  const reject = "Reject";
  const choice = await vscode.window.showInformationMessage(
    `${requester} requested control of this ICPC Live room.`,
    accept,
    reject
  );

  if (choice === accept) {
    await approveControlForUser(requester);
  }

  if (choice === reject) {
    safeSend({
      type: "reject_control",
      targetUserName: requester,
    });
  }
}

async function createFile(node?: RoomTreeNode): Promise<void> {
  if (!client.state) {
    vscode.window.showErrorMessage("Join an ICPC Live room first");
    return;
  }

  if (!client.isController) {
    return;
  }

  const path = await vscode.window.showInputBox({
    title: "Create Room File",
    prompt: node?.type === "folder" ? `Create file inside ${node.path}` : "Example: A/main.cpp or notes.txt",
    value: node?.type === "folder" ? `${node.path}/` : undefined,
  });

  if (!path) return;

  safeSend({
    type: "create_file",
    path: path.trim(),
  });
}

async function createFolder(node?: RoomTreeNode): Promise<void> {
  if (!client.state) {
    vscode.window.showErrorMessage("Join an ICPC Live room first");
    return;
  }

  if (!client.isController) {
    return;
  }

  const path = await vscode.window.showInputBox({
    title: "Create Room Folder",
    prompt: node?.type === "folder" ? `Create folder inside ${node.path}` : "Example: A or A/tests",
    value: node?.type === "folder" ? `${node.path}/` : undefined,
  });

  if (!path) return;

  safeSend({
    type: "create_folder",
    path: path.trim(),
  });
}

async function renameItem(node?: RoomTreeNode): Promise<void> {
  if (!node) return;
  if (node.type === "empty") return;

  if (!client.isController) {
    return;
  }

  const newPath = await vscode.window.showInputBox({
    title: `Rename ${node.path}`,
    value: node.path,
  });

  if (!newPath || newPath === node.path) return;

  safeSend({
    type: "rename_item",
    itemType: node.type,
    oldPath: node.path,
    newPath: newPath.trim(),
  });
}

async function deleteItem(node?: RoomTreeNode): Promise<void> {
  if (!node) return;
  if (node.type === "empty") return;

  if (!client.isController) {
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete ${node.type} "${node.path}"?`,
    { modal: true },
    "Delete"
  );

  if (confirmed !== "Delete") return;

  safeSend({
    type: "delete_item",
    itemType: node.type,
    path: node.path,
  });
}

async function setConsoleInput(): Promise<void> {
  if (!client.state) {
    vscode.window.showErrorMessage("Join an ICPC Live room first");
    return;
  }

  if (!client.isController) {
    vscode.window.showErrorMessage("Only the current controller can update console input");
    return;
  }

  const value = await vscode.window.showInputBox({
    title: "Console Input",
    value: client.state.consoleInput,
    prompt: "Use \\n for line breaks in this quick input.",
  });

  if (value === undefined) return;

  safeSend({
    type: "update_console_input",
    consoleInput: value.replace(/\\n/g, "\n"),
  });
}

async function setStdinMode(): Promise<void> {
  if (!client.state) {
    vscode.window.showErrorMessage("Join an ICPC Live room first");
    return;
  }

  if (!client.isController) {
    vscode.window.showErrorMessage("Only the current controller can update stdin mode");
    return;
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: "console", description: "Use shared console input" },
      { label: "file", description: "Use input.in next to active file" },
    ],
    {
      title: "Stdin Mode",
      placeHolder: client.state.stdinMode,
    }
  );

  if (!mode) return;

  safeSend({
    type: "update_stdin_mode",
    stdinMode: mode.label as "console" | "file",
  });
}

export function deactivate(): void {
  client.disconnect();
}

async function setServerUrl(): Promise<void> {
  const config = vscode.workspace.getConfiguration("icpcLive");
  const current = config.get<string>("serverUrl") || "http://localhost:3001";
  const value = await vscode.window.showInputBox({
    title: "ICPC Live Server URL",
    value: current,
    prompt: "Example: http://localhost:3001 or https://your-app.onrender.com",
  });

  if (!value) return;

  await config.update("serverUrl", value, vscode.ConfigurationTarget.Global);
}

async function joinRoom(): Promise<void> {
  const config = vscode.workspace.getConfiguration("icpcLive");
  const defaultServerUrl = config.get<string>("serverUrl") || "http://localhost:3001";

  const serverUrl = await vscode.window.showInputBox({
    title: "ICPC Live Server URL",
    value: defaultServerUrl,
  });
  if (!serverUrl) return;

  const roomId = await vscode.window.showInputBox({
    title: "Room ID",
    prompt: "Enter the room id from the web app",
  });
  if (!roomId) return;

  const userName = await vscode.window.showInputBox({
    title: "User Name",
    prompt: "Enter the same display name you want in this room",
  });
  if (!userName) return;

  await config.update("serverUrl", serverUrl, vscode.ConfigurationTarget.Global);
  try {
    const trimmedRoomId = roomId.trim();
    await client.join(serverUrl, trimmedRoomId, userName.trim());
    await showRoomReadyMessage(`Joined ICPC Live room ${trimmedRoomId}`, trimmedRoomId);
  } catch (error) {
    vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function createRoom(): Promise<void> {
  const config = vscode.workspace.getConfiguration("icpcLive");
  const defaultServerUrl = config.get<string>("serverUrl") || "http://localhost:3001";

  const serverUrlInput = await vscode.window.showInputBox({
    title: "ICPC Live Server URL",
    value: defaultServerUrl,
  });
  if (!serverUrlInput) return;

  const userNameInput = await vscode.window.showInputBox({
    title: "User Name",
    prompt: "Enter the display name you want in this room",
  });
  if (!userNameInput) return;

  const serverUrl = serverUrlInput.trim();
  const userName = userNameInput.trim();

  if (!userName) {
    vscode.window.showErrorMessage("Enter a user name before creating an ICPC Live room");
    return;
  }

  await config.update("serverUrl", serverUrl, vscode.ConfigurationTarget.Global);

  try {
    const room = await createRoomOnServer(serverUrl, userName);
    await client.join(serverUrl, room.roomId, userName);
    await showRoomReadyMessage(
      `Created and joined ICPC Live room ${room.roomId}`,
      room.roomId
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function copyRoomId(): Promise<void> {
  const roomId = client.roomId || client.state?.roomId || "";

  if (!roomId) {
    vscode.window.showErrorMessage("Join an ICPC Live room before copying a room ID");
    return;
  }

  await copyRoomIdToClipboard(roomId);
}

async function showRoomReadyMessage(
  message: string,
  roomId: string
): Promise<void> {
  const copyAction = "Copy Room ID";
  const choice = await vscode.window.showInformationMessage(message, copyAction);

  if (choice === copyAction) {
    await copyRoomIdToClipboard(roomId);
  }
}

async function copyRoomIdToClipboard(roomId: string): Promise<void> {
  await vscode.env.clipboard.writeText(roomId);
  vscode.window.showInformationMessage(`Copied ICPC Live room ID ${roomId}`);
}

async function openRoomFile(input?: string | RoomTreeNode): Promise<void> {
  if (!client.state) {
    vscode.window.showErrorMessage("Join an ICPC Live room first");
    return;
  }

  const inputPath = typeof input === "string" ? input : input?.path;
  const targetPath =
    inputPath ||
    (await vscode.window.showQuickPick(
      client.state.files.map((file) => file.path),
      { title: "Open Room File" }
    ));

  if (!targetPath) return;

  client.switchFile(targetPath).catch((error) => {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  });

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.parse(
      roomUriStringForController(client.roomId, targetPath, client.isController)
    )
  );
  await vscode.window.showTextDocument(document);
}

async function approveControl(): Promise<void> {
  const target = await pickControlRequest("Approve Control Request");
  if (!target) return;

  await approveControlForUser(target);
}

async function approveControlForUser(target: string): Promise<void> {
  const synced = await flushPendingDocumentSyncs();

  if (!synced) {
    return;
  }

  safeSend({
    type: "approve_control",
    targetUserName: target,
  });
}

async function rejectControl(): Promise<void> {
  const target = await pickControlRequest("Reject Control Request");
  if (!target) return;

  safeSend({
    type: "reject_control",
    targetUserName: target,
  });
}

async function pickControlRequest(title: string): Promise<string | undefined> {
  const requests = client.state?.controlRequests || [];

  if (requests.length === 0) {
    vscode.window.showInformationMessage("No pending control requests");
    return undefined;
  }

  return vscode.window.showQuickPick(requests, { title });
}

async function runCode(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const state = client.state;

  if (!state) {
    vscode.window.showErrorMessage("Join an ICPC Live room first");
    return;
  }

  if (!client.isController) {
    vscode.window.showErrorMessage("Only the current controller can run code");
    return;
  }

  const activeFilePath =
    editor?.document.uri.scheme === WRITABLE_ROOM_SCHEME
      ? decodeURIComponent(editor.document.uri.path.replace(/^\/+/, ""))
      : state.activeFilePath;

  if (!activeFilePath) {
    vscode.window.showErrorMessage("No active room file to run");
    return;
  }

  safeSend({
    type: "run_code",
    activeFilePath,
    activeFileContent:
      editor?.document.uri.scheme === WRITABLE_ROOM_SCHEME
        ? editor.document.getText()
        : undefined,
  });
}
