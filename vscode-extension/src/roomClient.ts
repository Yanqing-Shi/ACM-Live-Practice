// The connection to one room. No `vscode` import: this is tested with plain
// Node against the real server.
import WebSocket from "ws";
import type {
  ClientMessage,
  ErrorCode,
  RoomStateMessage,
  RunResultMessage,
} from "./protocol";
import {
  mergeRoomState,
  parseServerMessage,
  serverUrlToWebSocketUrl,
  withFileContent,
} from "./protocolHelpers";
import { diffWorkspace, FileClock, type RoomFileChange } from "./roomModel";
import type { RoomIdentity } from "./sessionRegistry";

export type Listener<T> = (value: T) => void;
export type Disposable = { dispose(): void };
export type Event<T> = (listener: Listener<T>) => Disposable;

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(value);
      } catch (error) {
        console.error("[ICPC Live] listener failed", error);
      }
    }
  }
}

export type ClientStatus =
  | "idle"
  | "connecting"
  | "connected"
  /** The connection dropped; the seat is kept and we are trying again. */
  | "reconnecting"
  /** The seat is gone (left, replaced, or refused). No more reconnects. */
  | "ended";

export type StateChange = {
  previous: RoomStateMessage | null;
  current: RoomStateMessage | null;
  /** Files and folders whose existence or content changed. */
  changes: RoomFileChange[];
  /** Whether this user's ability to edit flipped with this change. */
  accessChanged: boolean;
};

export type EndReason = "left" | "replaced" | "refused";

export class JoinError extends Error {
  constructor(
    message: string,
    readonly code?: ErrorCode
  ) {
    super(message);
    this.name = "JoinError";
  }
}

export type TokenStore = {
  getToken(identity: RoomIdentity): string | undefined;
  saveToken(identity: RoomIdentity, token: string): void;
  forgetToken(identity: RoomIdentity): void;
};

export type RoomClientOptions = {
  tokens: TokenStore;
  reconnectDelaysMs?: number[];
  joinTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  done: (state: RoomStateMessage) => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingJoin = {
  resolve: (state: RoomStateMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const SESSION_REPLACED_CLOSE_CODE = 4001;
/** Join failures that trying again cannot fix. */
const FATAL_JOIN_CODES: ReadonlySet<string> = new Set([
  "room_not_found",
  "room_full",
  "name_taken",
  "invalid_message",
]);

export class RoomClient {
  private socket: WebSocket | null = null;
  private identityValue: RoomIdentity | null = null;
  private stateValue: RoomStateMessage | null = null;
  private statusValue: ClientStatus = "idle";
  private offsetMs = 0;
  private wasEditable = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingJoin: PendingJoin | null = null;
  private readonly pendingRequests: PendingRequest[] = [];
  private readonly readyWaiters: Array<(state: RoomStateMessage | null) => void> = [];

  // Edits sent on this connection that no room update has acknowledged yet,
  // and the ones that must be sent again after a reconnect.
  private editSeq = 0;
  private readonly unackedFiles = new Map<string, number>();
  private readonly resendFiles = new Set<string>();
  private unackedConsoleSeq = 0;
  private resendConsole = false;

  private readonly stateEmitter = new Emitter<StateChange>();
  private readonly statusEmitter = new Emitter<ClientStatus>();
  private readonly runEmitter = new Emitter<RunResultMessage>();
  private readonly errorEmitter = new Emitter<{ message: string; code?: string }>();
  private readonly endEmitter = new Emitter<{ reason: EndReason; message: string }>();
  private readonly consoleEmitter = new Emitter<string>();

  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidChangeStatus = this.statusEmitter.event;
  readonly onDidReceiveRunResult = this.runEmitter.event;
  /** Errors from the server that no pending request claimed. */
  readonly onDidReceiveError = this.errorEmitter.event;
  readonly onDidEnd = this.endEmitter.event;
  /** The program input was replaced by the server (not typed here). */
  readonly onDidChangeConsoleInput = this.consoleEmitter.event;

  /** Times for room files, as the file system provider reports them. */
  readonly fileClock = new FileClock();
  /** When the program input last changed from the server's side. */
  consoleInputMtime = Date.now();

  constructor(private readonly options: RoomClientOptions) {}

  get identity(): RoomIdentity | null {
    return this.identityValue;
  }

  get roomId(): string {
    return this.identityValue?.roomId || "";
  }

  get userName(): string {
    return this.identityValue?.userName || "";
  }

  get state(): RoomStateMessage | null {
    return this.stateValue;
  }

  get status(): ClientStatus {
    return this.statusValue;
  }

  get isController(): boolean {
    return Boolean(
      this.stateValue &&
        this.identityValue &&
        this.stateValue.currentController === this.identityValue.userName
    );
  }

  /** Editing needs control and a live connection, as in the web app. */
  get canEdit(): boolean {
    return this.isController && this.statusValue === "connected";
  }

  /** Add to Date.now() to get the server's time, for the contest clock. */
  get serverTimeOffsetMs(): number {
    return this.offsetMs;
  }

  /**
   * Join the room. Resolves with the first room state, or rejects with a
   * JoinError when the server refuses or cannot be reached.
   */
  connect(identity: RoomIdentity): Promise<RoomStateMessage> {
    this.close();
    this.identityValue = identity;
    this.stateValue = null;
    this.wasEditable = false;
    this.reconnectAttempt = 0;
    this.unackedFiles.clear();
    this.resendFiles.clear();
    this.unackedConsoleSeq = 0;
    this.resendConsole = false;
    this.setStatus("connecting");

    return new Promise((resolve, reject) => {
      this.pendingJoin = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.failJoin(new JoinError("Timed out connecting to the ICPC Live server"));
        }, this.options.joinTimeoutMs ?? 10_000),
      };
      this.openSocket();
    });
  }

  /**
   * The current room state, waiting for the join in progress if there is
   * one. Resolves with null when there is no room to wait for.
   */
  whenReady(timeoutMs = 10_000): Promise<RoomStateMessage | null> {
    if (this.stateValue) return Promise.resolve(this.stateValue);
    if (this.statusValue === "idle" || this.statusValue === "ended") {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const waiter = (state: RoomStateMessage | null) => {
        clearTimeout(timer);
        resolve(state);
      };
      const timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);

        if (index >= 0) this.readyWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);

      this.readyWaiters.push(waiter);
    });
  }

  /** Drop the connection but keep the seat, e.g. when the window closes. */
  disconnect(): void {
    this.close();
    this.setStatus("idle");
  }

  /** Give the seat up: the name is freed and control moves on. */
  leave(): void {
    const identity = this.identityValue;

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "leave_room" } satisfies ClientMessage));
    }

    if (identity) this.options.tokens.forgetToken(identity);

    this.end("left", "You left the room");
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to the ICPC Live room");
    }

    this.socket.send(JSON.stringify(message));
  }

  /**
   * Send a message and wait until a room update shows it took effect.
   * Rejects with the server's error message if it was refused.
   */
  request(
    message: ClientMessage,
    done: (state: RoomStateMessage) => boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.send(message);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const pending: PendingRequest = {
        done,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.pendingRequests.indexOf(pending);

          if (index >= 0) this.pendingRequests.splice(index, 1);
          reject(new Error("The ICPC Live server did not answer in time"));
        }, this.options.requestTimeoutMs ?? 8000),
      };

      this.pendingRequests.push(pending);
    });
  }

  /**
   * Send new content for a file. `saved` marks an explicit save, which moves
   * the file's modification time; text sent while typing must not.
   */
  updateFile(path: string, content: string, options: { saved?: boolean } = {}): void {
    if (!this.canEdit) {
      throw new Error("Only the member with control can edit room files");
    }

    const current = this.stateValue?.files.find((file) => file.path === path);

    if (current && current.content !== content) {
      const seq = ++this.editSeq;

      this.send({ type: "update_file", path, content, seq });
      this.unackedFiles.set(path, seq);
      // The server does not echo our own edits, so keep our copy current.
      this.stateValue = withFileContent(this.stateValue as RoomStateMessage, path, content);
    }

    if (options.saved) this.fileClock.touch(path);
  }

  updateConsoleInput(consoleInput: string): void {
    if (!this.canEdit) {
      throw new Error("Only the member with control can edit the program input");
    }

    if (!this.stateValue || this.stateValue.consoleInput === consoleInput) return;

    const seq = ++this.editSeq;

    this.send({ type: "update_console_input", consoleInput, seq });
    this.unackedConsoleSeq = seq;
    this.stateValue = { ...this.stateValue, consoleInput };
  }

  // -------------------------------------------------------------------------

  private setStatus(status: ClientStatus): void {
    if (this.statusValue === status) return;

    const accessBefore = this.wasEditable;

    this.statusValue = status;
    this.statusEmitter.fire(status);

    // Going offline pauses editing; coming back resumes it. Either way the
    // files' permissions changed even though the room state did not.
    if (this.stateValue && accessBefore !== this.canEdit) {
      this.emitState(this.stateValue, this.stateValue, []);
    }
  }

  private emitState(
    previous: RoomStateMessage | null,
    current: RoomStateMessage | null,
    changes: RoomFileChange[]
  ): void {
    const editable = this.canEdit;
    const accessChanged = editable !== this.wasEditable;

    this.wasEditable = editable;

    if (accessChanged && current) {
      // VS Code only re-reads a file's permissions when the file looks
      // changed, so every file gets a new modification time.
      this.fileClock.touchAll(current.files.map((file) => file.path));
    }

    this.stateEmitter.fire({ previous, current, changes, accessChanged });
  }

  private close(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;

    const socket = this.socket;

    this.socket = null;

    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.close();
    }

    if (this.pendingJoin) {
      clearTimeout(this.pendingJoin.timer);
      this.pendingJoin = null;
    }

    this.rejectRequests(new Error("Disconnected from the ICPC Live room"));
  }

  private rejectRequests(error: Error): void {
    for (const pending of this.pendingRequests.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private resolveReady(state: RoomStateMessage | null): void {
    for (const waiter of this.readyWaiters.splice(0)) waiter(state);
  }

  private failJoin(error: JoinError): void {
    const pending = this.pendingJoin;

    this.pendingJoin = null;
    this.close();
    this.setStatus("idle");
    this.resolveReady(null);

    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private end(reason: EndReason, message: string): void {
    const previous = this.stateValue;

    this.close();
    this.stateValue = null;
    this.statusValue = "ended";
    this.statusEmitter.fire("ended");
    this.resolveReady(null);
    this.wasEditable = false;
    this.stateEmitter.fire({
      previous,
      current: null,
      changes: diffWorkspace(previous, null),
      accessChanged: true,
    });
    this.endEmitter.fire({ reason, message });
  }

  private openSocket(): void {
    const identity = this.identityValue;

    if (!identity) return;

    let url: string;

    try {
      url = serverUrlToWebSocketUrl(identity.serverUrl);
    } catch {
      this.failJoin(new JoinError("That is not a valid ICPC Live server address"));
      return;
    }

    const socket = new WebSocket(url);

    this.socket = socket;

    socket.on("open", () => {
      // Acknowledgements are per connection: anything the old connection had
      // not confirmed is sent again once we are back in the room.
      for (const path of this.unackedFiles.keys()) this.resendFiles.add(path);
      this.unackedFiles.clear();
      this.resendConsole = this.resendConsole || this.unackedConsoleSeq > 0;
      this.unackedConsoleSeq = 0;
      this.editSeq = 0;

      socket.send(
        JSON.stringify({
          type: "join_room",
          roomId: identity.roomId,
          userName: identity.userName,
          sessionToken: this.options.tokens.getToken(identity),
        } satisfies ClientMessage)
      );
    });

    socket.on("message", (raw) => {
      if (this.socket === socket) this.handleMessage(raw.toString());
    });

    socket.on("error", () => {
      // 'close' follows and does the work.
    });

    socket.on("close", (code) => {
      if (this.socket !== socket) return;

      this.socket = null;
      this.rejectRequests(new Error("The connection to the ICPC Live room was lost"));

      if (code === SESSION_REPLACED_CLOSE_CODE) {
        this.end("replaced", "This seat was opened in another window");
        return;
      }

      if (this.pendingJoin) {
        this.failJoin(
          new JoinError("Could not reach the ICPC Live server. Check the address and your connection.")
        );
        return;
      }

      if (this.statusValue === "connected" || this.statusValue === "reconnecting") {
        const delays = this.options.reconnectDelaysMs ?? [500, 1000, 2000, 4000, 8000];
        const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];

        this.reconnectAttempt += 1;
        this.setStatus("reconnecting");
        this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
      }
    });
  }

  private handleMessage(raw: string): void {
    const effect = parseServerMessage(raw);
    const identity = this.identityValue;

    if (!identity) return;

    if (effect.kind === "session") {
      // The server answers with the canonical id for the code that was typed.
      this.identityValue = {
        serverUrl: identity.serverUrl,
        roomId: effect.session.roomId,
        userName: effect.session.userName,
      };
      this.options.tokens.saveToken(this.identityValue, effect.session.sessionToken);
      return;
    }

    if (effect.kind === "state") {
      this.handleRoomState(effect.state);
      return;
    }

    if (effect.kind === "file_updated") {
      if (!this.stateValue) return;

      const previous = this.stateValue;

      this.stateValue = withFileContent(previous, effect.path, effect.content);

      const changes = diffWorkspace(previous, this.stateValue);

      this.fileClock.apply(changes);
      this.emitState(previous, this.stateValue, changes);
      return;
    }

    if (effect.kind === "console_input") {
      if (!this.stateValue) return;

      const previous = this.stateValue;

      this.stateValue = { ...previous, consoleInput: effect.consoleInput };
      this.consoleInputMtime = Math.max(Date.now(), this.consoleInputMtime + 1);
      this.consoleEmitter.fire(effect.consoleInput);
      this.emitState(previous, this.stateValue, []);
      return;
    }

    if (effect.kind === "run") {
      this.runEmitter.fire(effect.result);
      return;
    }

    if (effect.kind === "error") {
      this.handleError(effect.message, effect.code);
    }
  }

  private handleError(message: string, code: string | undefined): void {
    if (code === "session_replaced") return;

    const joining = this.statusValue === "connecting" || this.statusValue === "reconnecting";

    if (joining && code && FATAL_JOIN_CODES.has(code)) {
      const identity = this.identityValue;

      // A token that no longer opens this name is useless from now on.
      if (identity && code === "name_taken") this.options.tokens.forgetToken(identity);

      if (this.pendingJoin) {
        this.failJoin(new JoinError(message, code as ErrorCode));
      } else {
        this.end("refused", message);
      }

      return;
    }

    if (joining && code === "rate_limited") {
      if (this.pendingJoin) this.failJoin(new JoinError(message, "rate_limited"));
      return;
    }

    // The server answers each action in order, so an error belongs to the
    // oldest request still waiting.
    const pending = this.pendingRequests.shift();

    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      return;
    }

    this.errorEmitter.fire({ message, code });
  }

  private handleRoomState(incoming: RoomStateMessage): void {
    const identity = this.identityValue as RoomIdentity;
    const previous = this.stateValue;
    const ackSeq = incoming.ackSeq ?? 0;
    const stillController = incoming.currentController === identity.userName;
    const serverMs = Date.parse(incoming.serverTime);

    if (!Number.isNaN(serverMs)) this.offsetMs = serverMs - Date.now();

    if (!stillController) {
      // Edits typed just before control moved away must not be sent later.
      this.unackedFiles.clear();
      this.resendFiles.clear();
      this.unackedConsoleSeq = 0;
      this.resendConsole = false;
    } else {
      for (const [path, seq] of this.unackedFiles) {
        if (seq <= ackSeq) this.unackedFiles.delete(path);
      }

      if (this.unackedConsoleSeq <= ackSeq) this.unackedConsoleSeq = 0;
    }

    let next = mergeRoomState(
      previous,
      incoming,
      identity.userName,
      (path) => this.unackedFiles.has(path) || this.resendFiles.has(path)
    );

    if (
      previous &&
      stillController &&
      previous.currentController === identity.userName &&
      (this.unackedConsoleSeq > 0 || this.resendConsole)
    ) {
      next = { ...next, consoleInput: previous.consoleInput };
    }

    const consoleChanged = previous !== null && previous.consoleInput !== next.consoleInput;

    this.stateValue = next;

    const firstState = this.statusValue !== "connected";

    if (firstState) {
      this.reconnectAttempt = 0;
      this.statusValue = "connected";
      this.statusEmitter.fire("connected");
    }

    const changes = diffWorkspace(previous, next);

    this.fileClock.apply(changes);

    if (consoleChanged) {
      this.consoleInputMtime = Math.max(Date.now(), this.consoleInputMtime + 1);
      this.consoleEmitter.fire(next.consoleInput);
    }

    this.emitState(previous, next, changes);

    if (firstState) {
      this.resendUnconfirmedEdits(next, stillController);

      if (this.pendingJoin) {
        const pending = this.pendingJoin;

        this.pendingJoin = null;
        clearTimeout(pending.timer);
        pending.resolve(next);
      }
    }

    this.resolveReady(next);

    for (const pending of this.pendingRequests.slice()) {
      if (pending.done(next)) {
        this.pendingRequests.splice(this.pendingRequests.indexOf(pending), 1);
        clearTimeout(pending.timer);
        pending.resolve();
      }
    }
  }

  /** After a reconnect, deliver what the old connection never confirmed. */
  private resendUnconfirmedEdits(state: RoomStateMessage, stillController: boolean): void {
    const paths = Array.from(this.resendFiles);
    const resendConsole = this.resendConsole;

    this.resendFiles.clear();
    this.resendConsole = false;

    if (!stillController) return;

    for (const path of paths) {
      const file = state.files.find((item) => item.path === path);

      if (!file) continue;

      const seq = ++this.editSeq;

      this.send({ type: "update_file", path, content: file.content, seq });
      this.unackedFiles.set(path, seq);
    }

    if (resendConsole) {
      const seq = ++this.editSeq;

      this.send({ type: "update_console_input", consoleInput: state.consoleInput, seq });
      this.unackedConsoleSeq = seq;
    }
  }
}
