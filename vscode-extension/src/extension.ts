import * as vscode from "vscode";
import {
  formatClock,
  formatDuration,
  getContestClock,
  parseLengthInput,
} from "./contestClock";
import { controlRequestNotificationDecision } from "./controlRequestNotifications";
import { createRoom as createRoomOnServer } from "./createRoom";
import type { RunRecord } from "./protocol";
import { JoinError, RoomClient } from "./roomClient";
import {
  inputUri,
  InputFileSystemProvider,
  RoomFileSystemProvider,
  roomUri,
} from "./roomFileSystemProvider";
import { findFile } from "./roomModel";
import {
  formatRoomCode,
  INPUT_SCHEME,
  parseRoomUri,
  ROOM_SCHEME,
  roomKey,
  roomRootUriString,
  seatFolderName,
} from "./roomUris";
import {
  createSessionRegistry,
  type RoomIdentity,
  type SessionRegistry,
} from "./sessionRegistry";
import {
  ControlViewProvider,
  createStatusBar,
  MembersViewProvider,
  RoomViewProvider,
  RunHistoryViewProvider,
  type MemberNode,
} from "./views";

const TYPING_SYNC_DELAY_MS = 80;
const RUNNABLE = /\.(cpp|c|py|java|kt)$/;

let client: RoomClient;
let registry: SessionRegistry;
let output: vscode.OutputChannel;
let lastControlRequestKey: string | null = null;
let restoringText = false;
const pendingSync = new Map<string, { document: vscode.TextDocument; timer: ReturnType<typeof setTimeout> }>();

// --- read-only without control --------------------------------------------------

let roomProvider: RoomFileSystemProvider;
let roomFileSystem: vscode.Disposable | undefined;
let roomFileSystemReadonly: boolean | undefined;
let accessSync: Promise<void> = Promise.resolve();

/**
 * (Re-)register the room's file system as read-only or writable.
 *
 * Declaring the whole file system read-only is what makes VS Code itself
 * refuse changes up front: New File, New Folder, Rename and Delete are greyed
 * out in the Explorer and editors are locked, so a member without control is
 * stopped when they reach for the button, not after typing a name. VS Code
 * takes this flag at registration, so it is registered again when it flips.
 */
function registerRoomFileSystem(readonly: boolean): void {
  if (roomFileSystemReadonly === readonly) return;

  const message = new vscode.MarkdownString(
    "Only the member with control can change files in this ICPC Live room. " +
      "[Request Control](command:icpcLive.requestControl)"
  );

  message.isTrusted = { enabledCommands: ["icpcLive.requestControl"] };

  roomFileSystem?.dispose();
  roomFileSystemReadonly = readonly;
  roomFileSystem = vscode.workspace.registerFileSystemProvider(ROOM_SCHEME, roomProvider, {
    isCaseSensitive: true,
    isReadonly: readonly ? message : false,
  });
}

/** Bring the file system's read-only state in line with who has control. */
function syncFileSystemAccess(): void {
  accessSync = accessSync
    .then(async () => {
      if (!client.canEdit === roomFileSystemReadonly) return;

      if (!client.canEdit) {
        // Unsaved documents are settled while saving is still possible.
        await settleDocumentsAfterLosingControl();
      }

      registerRoomFileSystem(!client.canEdit);
      await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
    })
    .then(undefined, (error: unknown) => {
      console.error("[ICPC Live] could not update file access", error);
    });
}

/** What integration tests reach through `extension.exports`. */
export type ExtensionApi = {
  client: RoomClient;
  flushTyping: () => void;
  /** What Join Room does once the server, code and name have been typed. */
  enterRoom: (identity: RoomIdentity) => Promise<void>;
};

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  registry = createSessionRegistry(context.globalState);
  client = new RoomClient({ tokens: registry });
  output = vscode.window.createOutputChannel("ICPC Live");

  roomProvider = new RoomFileSystemProvider(client);
  // Nothing can be edited before the room is joined.
  registerRoomFileSystem(true);

  const roomView = new RoomViewProvider(client);
  const membersView = new MembersViewProvider(client);
  const runHistoryView = new RunHistoryViewProvider(client);
  const controlProvider = new ControlViewProvider(client);
  const controlView = vscode.window.createTreeView("icpcLive.control", {
    treeDataProvider: controlProvider,
  });

  /** Menus, buttons and welcome text in package.json depend on these. */
  function updateContext(): void {
    const state = client.state;
    const set = (key: string, value: boolean) =>
      void vscode.commands.executeCommand("setContext", `icpcLive.${key}`, value);

    set("joined", state !== null);
    set("canEdit", client.canEdit);
    set("isController", client.isController);
    set("controlRequested", Boolean(state?.controlRequests.includes(client.userName)));
    controlView.description = controlProvider.describe();
  }

  context.subscriptions.push(
    output,
    { dispose: () => roomFileSystem?.dispose() },
    vscode.workspace.registerFileSystemProvider(
      INPUT_SCHEME,
      new InputFileSystemProvider(client),
      { isCaseSensitive: true }
    ),
    vscode.window.registerTreeDataProvider("icpcLive.room", roomView),
    vscode.window.registerTreeDataProvider("icpcLive.members", membersView),
    vscode.window.registerTreeDataProvider("icpcLive.runHistory", runHistoryView),
    controlView,
    client.onDidChangeStatus(updateContext),
    client.onDidChangeStatus(syncFileSystemAccess),
    createStatusBar(client),
    vscode.workspace.onDidChangeTextDocument(onDocumentChanged),
    vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged),
    { dispose: () => client.disconnect() },

    command("icpcLive.createRoom", createRoom),
    command("icpcLive.joinRoom", () => joinRoom()),
    command("icpcLive.leaveRoom", leaveRoom),
    command("icpcLive.copyInvite", copyInvite),
    command("icpcLive.showRoomMenu", showRoomMenu),
    command("icpcLive.requestControl", requestControl),
    command("icpcLive.requestControlButton", requestControl),
    command("icpcLive.approveControl", (node?: MemberNode) => answerControlRequest(true, node)),
    command("icpcLive.rejectControl", (node?: MemberNode) => answerControlRequest(false, node)),
    command("icpcLive.runCode", runCode),
    command("icpcLive.editInput", editInput),
    command("icpcLive.setStdinMode", setStdinMode),
    command("icpcLive.clockMenu", clockMenu),
    command("icpcLive.openRunOutput", (record?: RunRecord) => {
      if (!record) return;

      output.clear();
      output.append(record.output || "(No saved output)");
      output.show(true);
    })
  );

  client.onDidChangeState(({ previous, current, accessChanged }) => {
    updateContext();

    if (accessChanged || current === null) syncFileSystemAccess();

    notifyControlRequest();

    if (previous === null && current !== null) {
      // VS Code adds extension sections to the Explorer collapsed. Open ours
      // on joining, without taking the keyboard away from the editor, so the
      // Request Control button is in view next to the file tree.
      void vscode.commands
        .executeCommand("icpcLive.control.focus", { preserveFocus: true })
        .then(undefined, () => undefined);
    }

    if (current && current.activeFilePath !== previous?.activeFilePath) {
      void followActiveFile(current.activeFilePath, previous === null);
    }
  });

  client.onDidReceiveRunResult((result) => {
    output.clear();
    output.append(result.output);

    if (result.status !== "queued" && result.status !== "running") {
      output.show(true);
    }
  });

  client.onDidReceiveError(({ message }) => {
    void vscode.window.showErrorMessage(`ICPC Live: ${message}`);
  });

  client.onDidEnd(({ reason, message }) => {
    cancelPendingTyping();

    if (reason === "left") return;

    const again = reason === "replaced" ? "Use This Window" : "Join Again…";

    void vscode.window
      .showWarningMessage(`ICPC Live: ${message}.`, again)
      .then((choice) => {
        if (choice !== again) return;

        const identity = client.identity;

        if (reason === "replaced" && identity) {
          void connectHere(identity);
        } else {
          void joinRoom(identity || undefined);
        }
      });
  });

  updateContext();
  void connectToOpenRoomFolder();

  return { client, flushTyping, enterRoom };
}

export function deactivate(): void {
  cancelPendingTyping();
  client?.disconnect();
}

function command<A extends unknown[]>(
  id: string,
  handler: (...args: A) => unknown
): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    try {
      await handler(...(args as A));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `ICPC Live: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

// --- joining ------------------------------------------------------------------

/** The seat this window's folder stands for, if it is a room folder. */
function openSeat(): { roomKey: string; folderName: string } | null {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.uri.scheme === ROOM_SCHEME
  );

  if (!folder) return null;

  const location = parseRoomUri(folder.uri.authority, folder.uri.path);

  return location.kind === "entry"
    ? { roomKey: location.roomKey, folderName: location.folderName }
    : null;
}

/** Whether this window's folder is the one for `identity`'s seat. */
function isOpenSeat(identity: { roomId: string; userName: string }): boolean {
  const open = openSeat();

  return (
    open !== null &&
    open.roomKey === roomKey(identity.roomId) &&
    open.folderName === seatFolderName(identity)
  );
}

function testIdentity(): RoomIdentity | undefined {
  // Lets the integration tests start VS Code directly inside a room.
  const raw = process.env.ICPC_LIVE_TEST_IDENTITY;

  if (!raw) return undefined;

  try {
    const value = JSON.parse(raw) as RoomIdentity;

    return typeof value.serverUrl === "string" &&
      typeof value.roomId === "string" &&
      typeof value.userName === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** A window opened on a room folder joins that room by itself. */
async function connectToOpenRoomFolder(): Promise<void> {
  const open = openSeat();

  if (!open) return;

  const identity = registry.getIdentity(open.roomKey, open.folderName) || testIdentity();

  if (!identity || !isOpenSeat(identity)) {
    const choice = await vscode.window.showWarningMessage(
      "ICPC Live: this window is on a room folder, but this VS Code has no saved seat for it.",
      "Join Room…"
    );

    if (choice) await joinRoom();
    return;
  }

  await connectHere(identity);
}

async function connectHere(identity: RoomIdentity): Promise<boolean> {
  try {
    await client.connect(identity);
    registry.saveIdentity(client.identity || identity);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const choice = await vscode.window.showErrorMessage(
      `ICPC Live: could not join room ${formatRoomCode(identity.roomId)}. ${message}`,
      "Join Again…"
    );

    if (choice) await joinRoom(identity);
    return false;
  }
}

async function askServerUrl(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("icpcLive");
  const value = await vscode.window.showInputBox({
    title: "ICPC Live server",
    prompt: "Address of the ICPC Live server your team uses",
    value: config.get<string>("serverUrl") || "http://localhost:3001",
    ignoreFocusOut: true,
    validateInput: (text) => {
      try {
        const url = new URL(text.trim());
        return /^(https?|wss?):$/.test(url.protocol) ? null : "Use an http(s) address";
      } catch {
        return "Enter an address such as https://example.com";
      }
    },
  });

  if (!value) return undefined;

  const serverUrl = value.trim().replace(/\/+$/, "");

  await config.update("serverUrl", serverUrl, vscode.ConfigurationTarget.Global);
  return serverUrl;
}

async function askUserName(suggested?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Your name",
    prompt: "Shown to your teammates in the room",
    value: suggested ?? registry.getLastName(),
    ignoreFocusOut: true,
    validateInput: (text) => {
      const name = text.trim();

      if (!name) return "Enter your name";
      return name.length > 32 ? "Names can be up to 32 characters" : null;
    },
  });

  return value?.trim() || undefined;
}

/**
 * Join a room and show it. The join is done first, from this window, so a
 * wrong code or a taken name is reported before anything is opened.
 */
async function enterRoom(identity: RoomIdentity): Promise<void> {
  // Only this window's own seat is joined in place. Joining the same room
  // under another name is another member, and gets a window of its own.
  if (isOpenSeat(identity)) {
    await connectHere(identity);
    return;
  }

  const probe = new RoomClient({ tokens: registry });
  let joined: RoomIdentity;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ICPC Live: joining the room…" },
      () => probe.connect(identity)
    );
    joined = probe.identity || identity;
  } catch (error) {
    throw error instanceof JoinError ? new Error(error.message) : error;
  } finally {
    // The seat is kept by its token; the room window takes it from here.
    probe.disconnect();
  }

  registry.saveIdentity(joined);
  registry.setLastName(joined.userName);

  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.parse(roomRootUriString(joined), true),
    // Never replace a folder the user already has open.
    { forceNewWindow: Boolean(vscode.workspace.workspaceFolders?.length) }
  );
}

async function joinRoom(previous?: RoomIdentity): Promise<void> {
  const serverUrl = await askServerUrl();
  if (!serverUrl) return;

  const code = await vscode.window.showInputBox({
    title: "Team code",
    prompt: "The 6-character code your teammate shared, for example ABC-DEF",
    value: previous ? formatRoomCode(previous.roomId) : "",
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? null : "Enter the team code"),
  });
  if (!code) return;

  const userName = await askUserName(previous?.userName);
  if (!userName) return;

  await enterRoom({ serverUrl, roomId: code.trim(), userName });
}

async function createRoom(): Promise<void> {
  const serverUrl = await askServerUrl();
  if (!serverUrl) return;

  const userName = await askUserName();
  if (!userName) return;

  const room = await createRoomOnServer(serverUrl, userName);

  await enterRoom({ serverUrl, roomId: room.roomId, userName });
}

async function leaveRoom(): Promise<void> {
  if (!client.state) return;

  const confirmed = await vscode.window.showWarningMessage(
    "Leave this ICPC Live room?",
    {
      modal: true,
      detail:
        "Your name is freed and control passes to a teammate if you hold it. The room and its files stay for the rest of the team.",
    },
    "Leave Room"
  );

  if (confirmed !== "Leave Room") return;

  const identity = client.identity;

  flushTyping();
  client.leave();

  if (!identity) return;

  registry.forgetIdentity(identity);

  if (isOpenSeat(identity)) {
    await vscode.commands.executeCommand("workbench.action.closeFolder");
  }
}

function requireRoom(): NonNullable<RoomClient["state"]> {
  if (!client.state) {
    throw new Error("Join a room first (ICPC Live: Join Room).");
  }

  return client.state;
}

async function copyInvite(): Promise<void> {
  const state = requireRoom();
  const server = (client.identity?.serverUrl || "").replace(/\/+$/, "");
  const link = `${server}/r/${state.roomId}`;

  await vscode.env.clipboard.writeText(link);
  void vscode.window.showInformationMessage(
    `Copied the invite link. Team code: ${formatRoomCode(state.roomId)}`
  );
}

// --- control ------------------------------------------------------------------

function requestControl(): void {
  requireRoom();

  if (client.isController) {
    void vscode.window.showInformationMessage("ICPC Live: you already have control.");
    return;
  }

  client.send({ type: "request_control" });
}

async function answerControlRequest(approve: boolean, node?: MemberNode): Promise<void> {
  const state = requireRoom();
  const target =
    node?.name ||
    (state.controlRequests.length === 1
      ? state.controlRequests[0]
      : await vscode.window.showQuickPick(state.controlRequests, {
          title: approve ? "Give control to…" : "Decline request from…",
        }));

  if (!target) {
    if (state.controlRequests.length === 0) {
      void vscode.window.showInformationMessage("ICPC Live: nobody is asking for control.");
    }
    return;
  }

  if (!approve) {
    client.send({ type: "reject_control", targetUserName: target });
    return;
  }

  // Everything typed must reach the room, and be saved here, before the
  // files turn read-only for this window.
  flushTyping();
  await saveDirtyRoomDocuments();
  client.send({ type: "approve_control", targetUserName: target });
}

function notifyControlRequest(): void {
  const decision = controlRequestNotificationDecision(
    client.state,
    client.userName,
    lastControlRequestKey
  );

  lastControlRequestKey = decision.nextNotificationKey;

  const requester = decision.requester;

  if (!requester) return;

  void vscode.window
    .showInformationMessage(
      `${requester} is asking for control of the ICPC Live room.`,
      "Give Control",
      "Decline"
    )
    .then((choice) => {
      if (!choice || !client.state?.controlRequests.includes(requester)) return;

      return answerControlRequest(choice === "Give Control", { kind: "request", name: requester });
    })
    .then(undefined, (error: unknown) => {
      void vscode.window.showErrorMessage(
        `ICPC Live: ${error instanceof Error ? error.message : String(error)}`
      );
    });
}

async function showRoomMenu(): Promise<void> {
  const state = requireRoom();
  const items: Array<vscode.QuickPickItem & { run: string }> = [];

  if (client.isController) {
    items.push({ label: "$(play) Run the open file", description: "Ctrl+Enter", run: "icpcLive.runCode" });

    for (const name of state.controlRequests) {
      items.push({ label: `$(check) Give control to ${name}`, run: `approve:${name}` });
    }
  } else if (!state.controlRequests.includes(client.userName)) {
    items.push({ label: "$(edit) Request control", run: "icpcLive.requestControl" });
  }

  items.push(
    { label: "$(terminal) Edit program input", run: "icpcLive.editInput" },
    { label: "$(watch) Contest clock…", run: "icpcLive.clockMenu" },
    { label: "$(link) Copy invite link", run: "icpcLive.copyInvite" },
    { label: "$(sign-out) Leave room", run: "icpcLive.leaveRoom" }
  );

  const choice = await vscode.window.showQuickPick(items, {
    title: `You are ${client.userName} in room ${formatRoomCode(state.roomId)}`,
  });

  if (!choice) return;

  if (choice.run.startsWith("approve:")) {
    await answerControlRequest(true, { kind: "request", name: choice.run.slice("approve:".length) });
  } else {
    await vscode.commands.executeCommand(choice.run);
  }
}

// --- running ------------------------------------------------------------------

function roomPathOf(uri: vscode.Uri | undefined): string | null {
  if (!uri || uri.scheme !== ROOM_SCHEME) return null;

  const location = parseRoomUri(uri.authority, uri.path);
  const seat = client.identity;

  return seat &&
    location.kind === "entry" &&
    location.roomKey === roomKey(seat.roomId) &&
    location.folderName === seatFolderName(seat) &&
    location.path !== ""
    ? location.path
    : null;
}

function runCode(): void {
  const state = requireRoom();

  if (!client.canEdit) {
    throw new Error(
      client.isController
        ? "You are offline. Running resumes when the connection is back."
        : "Only the member with control can run code."
    );
  }

  const open = roomPathOf(vscode.window.activeTextEditor?.document.uri);
  const target = open && RUNNABLE.test(open) ? open : state.activeFilePath;

  if (!target || !findFile(state, target)) {
    throw new Error("Open a file to run it.");
  }

  if (!RUNNABLE.test(target)) {
    throw new Error("Only .cpp, .c, .py, .java and .kt files can be run.");
  }

  // The server runs what it has, so what was just typed goes first.
  flushTyping();
  client.send({ type: "run_code", activeFilePath: target });
  output.clear();
  output.appendLine(`Running ${target}…`);
  output.show(true);
}

async function editInput(): Promise<void> {
  const state = requireRoom();
  const document = await vscode.workspace.openTextDocument(inputUri(state.roomId));

  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
    preview: false,
  });

  if (state.stdinMode !== "console") {
    void vscode.window.showInformationMessage(
      "ICPC Live: the room currently reads input from input.in next to the file being run. Use “ICPC Live: Choose Input Source” to use this text instead."
    );
  }
}

async function setStdinMode(): Promise<void> {
  const state = requireRoom();

  if (!client.canEdit) {
    throw new Error("Only the member with control can change where input comes from.");
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "Typed input",
        description: "the Program Input tab",
        mode: "console" as const,
        picked: state.stdinMode === "console",
      },
      {
        label: "input.in file",
        description: "the file named input.in next to the file being run",
        mode: "file" as const,
        picked: state.stdinMode === "file",
      },
    ],
    { title: "Where should the program's input come from?" }
  );

  if (choice && choice.mode !== state.stdinMode) {
    client.send({ type: "update_stdin_mode", stdinMode: choice.mode });
  }
}

// --- contest clock ------------------------------------------------------------

async function askContestLength(currentMinutes: number): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Contest length",
    prompt: 'Any length from 1 minute to 30 days, e.g. "5h", "2h30m", "2:30" or "150" (minutes)',
    value: formatDuration(currentMinutes).replace(/\s+/g, "").replace("min", "m"),
    validateInput: (text) => {
      const parsed = parseLengthInput(text);
      return parsed.ok ? null : parsed.error;
    },
  });

  if (value === undefined) return undefined;

  const parsed = parseLengthInput(value);

  return parsed.ok ? parsed.minutes : undefined;
}

async function clockMenu(): Promise<void> {
  const state = requireRoom();
  const clock = getContestClock(state.contest, Date.now() + client.serverTimeOffsetMs);
  const length = formatDuration(state.contest.durationMinutes);
  const items: Array<vscode.QuickPickItem & { action: "start" | "length" | "end" | "reset" }> = [];

  if (clock.phase === "not_started") {
    items.push(
      { label: `$(play) Start contest (${length})`, action: "start" },
      { label: "$(watch) Set length…", description: `now ${length}`, action: "length" }
    );
  } else if (clock.phase === "running") {
    items.push(
      { label: "$(watch) Change length…", description: `now ${length}`, action: "length" },
      { label: "$(debug-stop) End contest", action: "end" },
      { label: "$(discard) Reset clock", action: "reset" }
    );
  } else {
    items.push({ label: "$(discard) Reset clock", description: "to run another contest", action: "reset" });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title:
      clock.phase === "running"
        ? `Contest clock: ${formatClock(clock.remainingMs)} left of ${length}`
        : clock.phase === "finished"
          ? `Contest clock: ${clock.timeUp ? "time is up" : "ended"}`
          : "Contest clock: not started",
  });

  if (!choice) return;

  if (choice.action === "start") {
    client.send({ type: "contest_start" });
  } else if (choice.action === "length") {
    const minutes = await askContestLength(state.contest.durationMinutes);

    if (minutes !== undefined) {
      client.send({ type: "contest_configure", durationMinutes: minutes });
    }
  } else {
    const label = choice.action === "end" ? "End Contest" : "Reset Clock";
    const confirmed = await vscode.window.showWarningMessage(
      choice.action === "end" ? "End the contest for everyone?" : "Reset the clock for everyone?",
      {
        modal: true,
        detail:
          choice.action === "end"
            ? "The clock stops for the whole room. Files are not affected."
            : "The clock goes back to not started. The length is kept and files are not affected.",
      },
      label
    );

    if (confirmed === label) {
      client.send({ type: choice.action === "end" ? "contest_end" : "contest_reset" });
    }
  }
}

// --- live typing --------------------------------------------------------------

function isRoomDocument(document: vscode.TextDocument): boolean {
  return (
    (document.uri.scheme === ROOM_SCHEME || document.uri.scheme === INPUT_SCHEME) &&
    document.uri.authority.toLowerCase() === roomKey(client.roomId)
  );
}

/** What the room currently has for a document, or null if it is not a room file. */
function roomTextFor(document: vscode.TextDocument): string | null {
  const state = client.state;

  if (!state || !isRoomDocument(document)) return null;
  if (document.uri.scheme === INPUT_SCHEME) return state.consoleInput;

  const path = roomPathOf(document.uri);

  return path ? findFile(state, path)?.content ?? null : null;
}

function pushDocument(document: vscode.TextDocument): void {
  if (!client.canEdit || document.isClosed) return;

  try {
    if (document.uri.scheme === INPUT_SCHEME) {
      client.updateConsoleInput(document.getText());
      return;
    }

    const path = roomPathOf(document.uri);

    if (path && findFile(client.state, path)) {
      client.updateFile(path, document.getText());
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `ICPC Live: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Teammates see text as it is typed, without waiting for a save. */
function onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
  const document = event.document;

  if (restoringText || event.contentChanges.length === 0 || !isRoomDocument(document)) return;

  if (!client.canEdit) {
    // VS Code already makes these documents read-only; this catches anything
    // that edits them anyway (another extension, a refactoring).
    void restoreRoomText(document);
    return;
  }

  const key = document.uri.toString();
  const existing = pendingSync.get(key);

  if (existing) clearTimeout(existing.timer);

  pendingSync.set(key, {
    document,
    timer: setTimeout(() => {
      pendingSync.delete(key);
      pushDocument(document);
    }, TYPING_SYNC_DELAY_MS),
  });
}

/** Send everything typed so far right now. */
function flushTyping(): void {
  for (const [key, entry] of Array.from(pendingSync)) {
    clearTimeout(entry.timer);
    pendingSync.delete(key);
    pushDocument(entry.document);
  }
}

function cancelPendingTyping(): void {
  for (const entry of pendingSync.values()) clearTimeout(entry.timer);

  pendingSync.clear();
}

async function restoreRoomText(document: vscode.TextDocument): Promise<void> {
  const expected = roomTextFor(document);

  if (expected === null || document.getText() === expected) return;

  restoringText = true;

  try {
    const edit = new vscode.WorkspaceEdit();

    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      expected
    );
    await vscode.workspace.applyEdit(edit);
  } finally {
    restoringText = false;
  }
}

function openRoomDocuments(): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(
    (document) => !document.isClosed && isRoomDocument(document)
  );
}

async function saveDirtyRoomDocuments(): Promise<void> {
  for (const document of openRoomDocuments()) {
    if (document.isDirty) await document.save();
  }
}

/**
 * Control moved away (or the connection dropped) while documents here were
 * still marked unsaved. Their text is already in the room, so they are saved
 * to clear the marker; anything the room does not have is put back first.
 */
async function settleDocumentsAfterLosingControl(): Promise<void> {
  cancelPendingTyping();

  for (const document of openRoomDocuments()) {
    if (!document.isDirty) continue;

    await restoreRoomText(document);
    await document.save();
  }
}

// --- following the controller ---------------------------------------------------

/** The file this window last told the server it is working in. */
let announcedActivePath = "";

function onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
  const path = roomPathOf(editor?.document.uri);
  const state = client.state;

  // The controller's open file is the room's active file, which is what
  // observers follow and what Run uses by default.
  if (!path || !state || !client.canEdit) return;
  if (path === state.activeFilePath || path === announcedActivePath) return;
  if (!findFile(state, path)) return;

  announcedActivePath = path;

  try {
    client.send({ type: "switch_file", path });
  } catch {
    announcedActivePath = "";
  }
}

async function followActiveFile(path: string, firstState: boolean): Promise<void> {
  const state = client.state;

  announcedActivePath = path;

  if (!state || !path || !findFile(state, path)) return;

  const follow = vscode.workspace.getConfiguration("icpcLive").get<boolean>("followController", true);

  // The controller already has their own editors; observers are shown what
  // the controller switches to. On joining, everyone is shown the active file.
  if (!firstState && (client.isController || !follow)) return;
  if (roomPathOf(vscode.window.activeTextEditor?.document.uri) === path) return;

  try {
    const seat = client.identity;

    if (!seat) return;

    const document = await vscode.workspace.openTextDocument(roomUri(seat, path));

    await vscode.window.showTextDocument(document, { preview: !client.isController, preserveFocus: true });
  } catch {
    // The file may have been deleted or renamed in the meantime.
  }
}
