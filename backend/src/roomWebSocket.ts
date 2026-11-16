import type { IncomingMessage } from "http";
import type { WebSocketServer, WebSocket } from "ws";
import {
  configureContest,
  endContest,
  resetContest,
  startContest,
} from "./contestActions";
import { appendAuditEvent } from "./events";
import { ROOM_LIMITS } from "./limits";
import { flushRoomSave, loadRoomFromDisk, queueRoomSave } from "./persistence";
import { validateControllerAction } from "./permissions";
import { clientAddress, createRateLimiter, type RateLimiter } from "./rateLimit";
import {
  addClientToRoom,
  approveControl,
  createFile,
  createFolder,
  deleteItem,
  detachClient,
  rejectControl,
  removeClientFromRoomState,
  renameItem,
  requestControl,
  switchActiveFile,
  transferControlFromAbsentController,
  updateFileContent,
  type ActionResult,
} from "./roomActions";
import { sendToRoom } from "./roomBroadcast";
import { runCodeInRoom } from "./runner";
import { claimSeat, releaseSeat, touchSeat } from "./session";
import type {
  ClientMessage,
  ErrorCode,
  JoinRoomMessage,
  Room,
  RunCodeMessage,
  ServerMessage,
} from "./types";
import {
  isValidUserName,
  parseClientMessage,
  roomIdCandidates,
} from "./validation";

export type RegisterRoomWebSocketOptions = {
  rooms: Record<string, Room>;
  /** Saves the room soon and sends the full state to every member. */
  broadcastRoomState: (roomId: string) => void;
  /** How long a disconnected controller keeps the keyboard. */
  controllerGraceMs?: number;
  trustProxy?: boolean;
  joinLimiter?: RateLimiter;
  heartbeatMs?: number;
  log?: (message: string) => void;
};

type ClientRoomContext = {
  socket: WebSocket;
  room: Room;
  roomId: string;
  userName: string;
};

type MessageOf<T extends ClientMessage["type"]> = Extract<
  ClientMessage,
  { type: T }
>;

const SESSION_REPLACED_CLOSE_CODE = 4001;

export function registerRoomWebSocket(
  wss: WebSocketServer,
  {
    rooms,
    broadcastRoomState,
    controllerGraceMs = ROOM_LIMITS.controllerGraceMs,
    trustProxy = false,
    joinLimiter = createRateLimiter({ windowMs: 60_000, max: 40 }),
    heartbeatMs = 30_000,
    log = console.log,
  }: RegisterRoomWebSocketOptions
): void {
  const socketMeta = new Map<WebSocket, { roomId: string; userName: string }>();
  const socketAddress = new Map<WebSocket, string>();
  const aliveSockets = new WeakSet<WebSocket>();
  // At most one pending hand-over per room: the controller that dropped.
  const graceTimers = new Map<
    string,
    { userName: string; timer: ReturnType<typeof setTimeout> }
  >();

  function sendMessage(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(
    socket: WebSocket,
    message: string,
    code: ErrorCode = "action_failed"
  ): void {
    sendMessage(socket, { type: "error", message, code });
  }

  function cancelGraceTimer(roomId: string, userName?: string): void {
    const pending = graceTimers.get(roomId);

    if (!pending) return;
    if (userName !== undefined && pending.userName !== userName) return;

    clearTimeout(pending.timer);
    graceTimers.delete(roomId);
  }

  function unloadRoomIfEmpty(roomId: string, room: Room): boolean {
    // A room with a run in flight stays loaded: the run still holds this
    // object, and unloading now could let its late save overwrite a newer copy.
    if (room.clients.length > 0 || room.runInProgress) {
      return false;
    }

    cancelGraceTimer(roomId);
    room.currentController = null;
    room.controlRequests = [];
    flushRoomSave(roomId, room);
    delete rooms[roomId];
    log(`[ROOM UNLOADED] ${roomId}`);
    return true;
  }

  function startControllerGrace(roomId: string, userName: string): void {
    cancelGraceTimer(roomId);

    const handOver = (): void => {
      graceTimers.delete(roomId);

      const room = rooms[roomId];
      if (!room || room.currentController !== userName) return;

      const result = transferControlFromAbsentController(room);

      if (result.controllerChanged) {
        log(
          `[CONTROL TRANSFER] ${result.newController} is now controller of room ${roomId}`
        );
        broadcastRoomState(roomId);
      }
    };

    if (controllerGraceMs <= 0) {
      handOver();
      return;
    }

    const timer = setTimeout(handOver, controllerGraceMs);

    timer.unref();
    graceTimers.set(roomId, { userName, timer });
  }

  /** The connection dropped without an explicit leave. The seat is kept. */
  function handleDisconnect(socket: WebSocket): void {
    const meta = socketMeta.get(socket);

    socketMeta.delete(socket);
    socketAddress.delete(socket);

    if (!meta) return;

    const { roomId, userName } = meta;
    const room = rooms[roomId];
    const client = room?.clients.find((existing) => existing.socket === socket);

    if (!room || !client) return;

    const result = detachClient(room, client);

    touchSeat(room, userName);
    log(`[DISCONNECT] ${userName} dropped from room ${roomId}`);

    if (unloadRoomIfEmpty(roomId, room)) return;

    if (result.wasController) {
      startControllerGrace(roomId, userName);
    }

    broadcastRoomState(roomId);
  }

  /** The member chose to leave: free the seat and hand control over now. */
  function handleLeave(socket: WebSocket): void {
    const meta = socketMeta.get(socket);

    socketMeta.delete(socket);

    if (meta) {
      const { roomId, userName } = meta;
      const room = rooms[roomId];
      const client = room?.clients.find((existing) => existing.socket === socket);

      if (room && client) {
        const result = removeClientFromRoomState(room, client);

        releaseSeat(room, userName);
        cancelGraceTimer(roomId, userName);
        log(`[LEAVE] ${userName} left room ${roomId}`);

        if (!unloadRoomIfEmpty(roomId, room)) {
          if (result.controllerChanged) {
            log(
              `[CONTROL TRANSFER] ${result.newController} is now controller of room ${roomId}`
            );
          }

          broadcastRoomState(roomId);
        }
      }
    }

    socket.close();
  }

  function getContext(socket: WebSocket): ClientRoomContext | null {
    const meta = socketMeta.get(socket);
    if (!meta) return null;

    const room = rooms[meta.roomId];
    if (!room) return null;

    return { socket, room, roomId: meta.roomId, userName: meta.userName };
  }

  /** Remember that an edit from this connection is now part of the room. */
  function acknowledgeEdit(context: ClientRoomContext, seq: number | undefined): void {
    if (seq === undefined) return;

    const client = context.room.clients.find(
      (existing) => existing.socket === context.socket
    );

    if (client && seq > (client.editSeq ?? 0)) {
      client.editSeq = seq;
    }
  }

  function handleJoin(socket: WebSocket, data: JoinRoomMessage): void {
    if (socketMeta.has(socket)) {
      sendError(
        socket,
        "Leave your current room before joining another room",
        "already_joined"
      );
      return;
    }

    if (!joinLimiter.take(socketAddress.get(socket) || "unknown")) {
      sendError(
        socket,
        "Too many join attempts. Wait a minute and try again.",
        "rate_limited"
      );
      return;
    }

    const userName = data.userName.trim();

    if (!data.roomId.trim() || !userName) {
      sendError(socket, "roomId and userName are required", "invalid_message");
      return;
    }

    if (!isValidUserName(userName)) {
      sendError(socket, "Invalid userName", "invalid_message");
      return;
    }

    const candidates = roomIdCandidates(data.roomId);

    if (candidates.length === 0) {
      sendError(socket, "Invalid roomId", "invalid_message");
      return;
    }

    let roomId = "";
    let room: Room | null = null;
    let loadedFromDisk = false;

    for (const candidate of candidates) {
      if (rooms[candidate]) {
        roomId = candidate;
        room = rooms[candidate];
        break;
      }

      const savedRoom = loadRoomFromDisk(candidate);

      if (savedRoom) {
        roomId = candidate;
        room = savedRoom;
        loadedFromDisk = true;
        break;
      }
    }

    if (!room) {
      sendError(
        socket,
        `Room "${data.roomId.trim()}" does not exist. Create a room first.`,
        "room_not_found"
      );
      return;
    }

    const claim = claimSeat(room, userName, data.sessionToken);

    if (!claim.ok) {
      sendError(socket, claim.error, claim.code);
      return;
    }

    if (loadedFromDisk) {
      rooms[roomId] = room;
      log(`[ROOM LOADED] ${roomId}`);
    }

    // The same seat is already connected (another tab, or a half-dead socket
    // from before a network drop): the newest connection wins.
    const previous = room.clients.find((client) => client.userName === userName);

    if (previous) {
      socketMeta.delete(previous.socket);
      room.clients = room.clients.filter((client) => client !== previous);
      sendError(
        previous.socket,
        "This seat was opened in another window",
        "session_replaced"
      );
      previous.socket.close(SESSION_REPLACED_CLOSE_CODE, "session replaced");
    }

    cancelGraceTimer(roomId, userName);

    // A controller that never came back and whose grace period is not running
    // (for example after a restart) must not block the room forever.
    if (
      room.currentController !== null &&
      room.currentController !== userName &&
      !graceTimers.has(roomId)
    ) {
      transferControlFromAbsentController(room);
    }

    const addResult = addClientToRoom(room, { socket, userName });

    if (!addResult.ok) {
      sendError(socket, addResult.error || "Could not join room", "name_taken");
      return;
    }

    socketMeta.set(socket, { roomId, userName });

    sendMessage(socket, {
      type: "session",
      roomId,
      userName,
      sessionToken: claim.sessionToken,
    });

    log(`[JOIN] ${userName} joined room ${roomId}`);
    broadcastRoomState(roomId);
  }

  /** Reply with the action's error, or broadcast the new state. */
  function finishAction(
    context: ClientRoomContext,
    result: ActionResult,
    fallbackError: string
  ): boolean {
    if (!result.ok) {
      sendError(context.socket, result.error || fallbackError);
      return false;
    }

    broadcastRoomState(context.roomId);
    return true;
  }

  async function handleRunCode(
    context: ClientRoomContext,
    data: RunCodeMessage
  ): Promise<void> {
    const { socket, room, roomId, userName } = context;

    if (room.runInProgress) {
      sendMessage(socket, {
        type: "run_result",
        output: "[Run rejected]\nA run is already in progress for this room.\n",
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        runner: userName,
        status: "rejected",
      });
      return;
    }

    if (
      typeof data.activeFilePath === "string" &&
      data.activeFilePath !== room.activeFilePath
    ) {
      const switched = switchActiveFile(room, data.activeFilePath);

      if (!switched.ok) {
        sendError(socket, switched.error || "Could not switch file");
        return;
      }
    }

    if (typeof data.activeFileContent === "string") {
      const updated = updateFileContent(
        room,
        room.activeFilePath,
        data.activeFileContent
      );

      if (!updated.ok) {
        sendError(socket, updated.error || "Could not update file");
        return;
      }
    }

    if (data.stdinMode) {
      room.stdinMode = data.stdinMode;
    }

    if (typeof data.consoleInput === "string") {
      room.consoleInput = data.consoleInput;
    }

    const runTarget = room.activeFilePath;

    room.runInProgress = true;
    appendAuditEvent(room, {
      action: "run_started",
      actor: userName,
      target: runTarget,
      detail: `stdinMode=${room.stdinMode}`,
    });
    broadcastRoomState(roomId);

    try {
      const runResult = await runCodeInRoom(room, userName, (message) => {
        sendToRoom(room, message);
      });

      appendAuditEvent(room, {
        action: "run_finished",
        actor: userName,
        target: runTarget,
        detail: runResult.timedOut ? "timeout" : `exitCode=${runResult.exitCode}`,
      });
      sendToRoom(room, runResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      sendToRoom(room, {
        type: "run_result",
        output: `[Run system error]\n${message}`,
        stdout: "",
        stderr: message,
        exitCode: null,
        timedOut: false,
        runner: userName,
        status: "system_error",
      });
      appendAuditEvent(room, {
        action: "run_finished",
        actor: userName,
        target: runTarget,
        detail: `system error: ${message}`,
      });
    } finally {
      room.runInProgress = false;

      // Everyone may have left while the program was running.
      if (rooms[roomId] === room && !unloadRoomIfEmpty(roomId, room)) {
        broadcastRoomState(roomId);
      }
    }
  }

  const handlers: {
    [T in ClientMessage["type"]]?: (
      context: ClientRoomContext,
      data: MessageOf<T>
    ) => void | Promise<void>;
  } = {
    run_code: handleRunCode,

    request_control(context) {
      const result = requestControl(context.room, context.userName);

      if (finishAction(context, result, "Could not request control")) {
        log(`[REQUEST CONTROL] ${context.userName} requested room ${context.roomId}`);
      }
    },

    approve_control(context, data) {
      const result = approveControl(
        context.room,
        context.userName,
        data.targetUserName
      );

      if (finishAction(context, result, "Could not approve control request")) {
        cancelGraceTimer(context.roomId);
        log(
          `[CONTROL APPROVED] ${data.targetUserName} now controls room ${context.roomId}`
        );
      }
    },

    reject_control(context, data) {
      const result = rejectControl(
        context.room,
        context.userName,
        data.targetUserName
      );

      finishAction(context, result, "Could not reject control request");
    },

    update_file(context, data) {
      const { socket, room, roomId, userName } = context;
      const path = data.path ?? room.activeFilePath;
      const result = updateFileContent(room, path, data.content);

      if (!result.ok) {
        sendError(socket, result.error || "Could not update file");
        return;
      }

      // Edits go to the other members only. The editor already has this text,
      // and echoing it back could overwrite keystrokes typed since.
      acknowledgeEdit(context, data.seq);
      queueRoomSave(roomId, room);
      sendToRoom(
        room,
        { type: "file_updated", path, content: data.content, updatedBy: userName },
        socket
      );
    },

    update_console_input(context, data) {
      const { socket, room, roomId, userName } = context;

      room.consoleInput = data.consoleInput;
      acknowledgeEdit(context, data.seq);
      queueRoomSave(roomId, room);
      sendToRoom(
        room,
        {
          type: "console_input_updated",
          consoleInput: data.consoleInput,
          updatedBy: userName,
        },
        socket
      );
    },

    update_stdin_mode(context, data) {
      context.room.stdinMode = data.stdinMode;
      appendAuditEvent(context.room, {
        action: "stdin_mode_updated",
        actor: context.userName,
        target: data.stdinMode,
      });
      broadcastRoomState(context.roomId);
    },

    switch_file(context, data) {
      const result = switchActiveFile(context.room, data.path);

      if (finishAction(context, result, "Could not switch file")) {
        appendAuditEvent(context.room, {
          action: "file_switched",
          actor: context.userName,
          target: data.path,
        });
      }
    },

    create_folder(context, data) {
      const result = createFolder(context.room, data.path);

      if (finishAction(context, result, "Could not create folder")) {
        appendAuditEvent(context.room, {
          action: "folder_created",
          actor: context.userName,
          target: data.path,
        });
      }
    },

    create_file(context, data) {
      const result = createFile(context.room, data.path, data.content ?? "");

      if (finishAction(context, result, "Could not create file")) {
        appendAuditEvent(context.room, {
          action: "file_created",
          actor: context.userName,
          target: data.path,
        });
      }
    },

    rename_item(context, data) {
      const result = renameItem(
        context.room,
        data.itemType,
        data.oldPath,
        data.newPath
      );

      if (finishAction(context, result, "Could not rename item")) {
        appendAuditEvent(context.room, {
          action: "item_renamed",
          actor: context.userName,
          target: data.newPath,
          detail: `${data.itemType}: ${data.oldPath} -> ${data.newPath}`,
        });
      }
    },

    delete_item(context, data) {
      const result = deleteItem(context.room, data.itemType, data.path);

      if (finishAction(context, result, "Could not delete item")) {
        appendAuditEvent(context.room, {
          action: "item_deleted",
          actor: context.userName,
          target: data.path,
          detail: data.itemType,
        });
      }
    },

    contest_configure(context, data) {
      finishAction(
        context,
        configureContest(context.room, data),
        "Could not change the contest length"
      );
    },

    contest_start(context) {
      finishAction(context, startContest(context.room), "Could not start contest");
    },

    contest_end(context) {
      finishAction(context, endContest(context.room), "Could not end contest");
    },

    contest_reset(context) {
      finishAction(context, resetContest(context.room), "Could not reset contest");
    },
  };

  async function handleMessage(socket: WebSocket, raw: Buffer): Promise<void> {
    let decoded: unknown;

    try {
      decoded = JSON.parse(raw.toString());
    } catch {
      sendError(socket, "Invalid JSON message", "invalid_message");
      return;
    }

    const parsed = parseClientMessage(decoded);

    if (!parsed.ok) {
      sendError(socket, parsed.error, "invalid_message");
      return;
    }

    const data = parsed.message;

    if (data.type === "join_room") {
      handleJoin(socket, data);
      return;
    }

    if (data.type === "leave_room") {
      handleLeave(socket);
      return;
    }

    const context = getContext(socket);

    if (!context) {
      sendError(socket, "Join a room first", "not_joined");
      return;
    }

    const permission = validateControllerAction(
      context.room,
      context.userName,
      data.type
    );

    if (!permission.ok) {
      sendError(socket, permission.error, "not_controller");
      return;
    }

    const handler = handlers[data.type] as
      | ((context: ClientRoomContext, data: ClientMessage) => void | Promise<void>)
      | undefined;

    if (!handler) {
      sendError(socket, "Unknown message type", "invalid_message");
      return;
    }

    await handler(context, data);
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    socketAddress.set(socket, clientAddress(request, trustProxy));
    aliveSockets.add(socket);

    socket.on("pong", () => {
      aliveSockets.add(socket);
    });

    socket.on("message", (raw: Buffer) => {
      handleMessage(socket, raw).catch((error) => {
        console.error("[WS HANDLER ERROR]", error);
        sendError(socket, "Internal server error");
      });
    });

    socket.on("close", () => {
      handleDisconnect(socket);
    });

    socket.on("error", (err: Error) => {
      console.error("[WS ERROR]", err.message);
    });
  });

  // Drop connections that stopped answering, so a member whose network died
  // is shown as offline and a dead controller's grace period can start.
  if (heartbeatMs > 0) {
    const heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        if (!aliveSockets.has(socket)) {
          socket.terminate();
          continue;
        }

        aliveSockets.delete(socket);
        socket.ping();
      }
    }, heartbeatMs);

    heartbeat.unref();
    wss.on("close", () => {
      clearInterval(heartbeat);
    });
  }

  wss.on("close", () => {
    for (const pending of graceTimers.values()) {
      clearTimeout(pending.timer);
    }

    graceTimers.clear();
  });
}
