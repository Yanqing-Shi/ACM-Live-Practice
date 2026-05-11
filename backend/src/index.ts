import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { randomBytes } from "crypto";
import { recordAuditEvent } from "./audit";
import {
  addClientToRoom,
  approveControl,
  createDefaultRoom,
  createFile,
  createFolder,
  deleteItem,
  rejectControl,
  removeClientFromRoomState,
  renameItem,
  requestControl,
  switchActiveFile,
  updateActiveFileContent,
} from "./roomActions";
import { runCodeInRoom } from "./runner";
import {
  addParentFolders,
  isValidWorkspacePath,
  normalizeWorkspacePath,
} from "./workspace";
import {
  listPersistedRooms,
  loadRoomFromDisk,
  queueRoomSave,
  roomExistsOnDisk,
  saveRoomToDisk,
} from "./persistence";
import type {
  ClientMessage,
  FileItem,
  Room,
  RoomStateMessage,
  ServerMessage,
} from "./types";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = Number(process.env.PORT || 3001);

const rooms: Record<string, Room> = {};
const socketMeta = new Map<WebSocket, { roomId: string; userName: string }>();

function isUserInAnyRoom(userName: string): boolean {
  return Object.values(rooms).some((room) =>
    room.clients.some((client) => client.userName === userName)
  );
}

function createRoomId(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const roomId = `room-${randomBytes(4).toString("hex")}`;

    if (!rooms[roomId] && !roomExistsOnDisk(roomId)) {
      return roomId;
    }
  }

  throw new Error("Could not generate a unique room id");
}

function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastRoomState(roomId: string): void {
  const room = rooms[roomId];
  if (!room) return;

  queueRoomSave(roomId, room);

  const message: RoomStateMessage = {
    type: "room_state",
    roomId,
    members: room.clients.map((c) => c.userName),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
    controlTimeline: room.controlTimeline,
    auditEvents: room.auditEvents,
  };

  const serialized = JSON.stringify(message);

  for (const client of room.clients) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(serialized);
    }
  }
}


function broadcastToRoom(roomId: string, message: ServerMessage): void {
  const room = rooms[roomId];
  if (!room) return;

  const serialized = JSON.stringify(message);

  for (const client of room.clients) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(serialized);
    }
  }
}

function removeClientFromRoom(socket: WebSocket): void {
  const meta = socketMeta.get(socket);
  if (!meta) return;

  const { roomId, userName } = meta;
  const room = rooms[roomId];

  if (room) {
    const client = room.clients.find((existing) => existing.socket === socket);

    if (!client) {
      socketMeta.delete(socket);
      return;
    }

    const result = removeClientFromRoomState(room, client);

    console.log(`[LEAVE] ${userName} left room ${roomId}`);

    if (result.roomEmpty) {
      saveRoomToDisk(roomId, room);
      delete rooms[roomId];
      console.log(`[ROOM REMOVED] ${roomId}`);
    } else {
      if (result.controllerChanged) {
        console.log(
          `[CONTROL TRANSFER] ${result.newController} is now controller of room ${roomId}`
        );
      }

      broadcastRoomState(roomId);
    }
  }

  socketMeta.delete(socket);
}

function getClientRoom(socket: WebSocket) {
  const meta = socketMeta.get(socket);
  if (!meta) return null;

  const room = rooms[meta.roomId];
  if (!room) return null;

  return {
    room,
    roomId: meta.roomId,
    userName: meta.userName,
  };
}

function buildRoomSnapshot(roomId: string, room: Room) {
  return {
    roomId,
    exportedAt: new Date().toISOString(),
    members: room.clients.map((client) => client.userName),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
    controlTimeline: room.controlTimeline,
    auditEvents: room.auditEvents,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is string => typeof item === "string");
}

function sanitizeSnapshotFiles(value: unknown): FileItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Snapshot files must be an array");
  }

  const files: FileItem[] = [];
  const seenPaths = new Set<string>();

  for (const item of value) {
    if (!isObject(item)) {
      throw new Error("Snapshot file item must be an object");
    }

    if (typeof item.path !== "string" || typeof item.content !== "string") {
      throw new Error("Snapshot file item requires string path and content");
    }

    const filePath = normalizeWorkspacePath(item.path);

    if (!isValidWorkspacePath(filePath)) {
      throw new Error(`Invalid snapshot file path: ${item.path}`);
    }

    if (seenPaths.has(filePath)) {
      throw new Error(`Duplicate snapshot file path: ${filePath}`);
    }

    seenPaths.add(filePath);
    files.push({
      path: filePath,
      content: item.content,
    });
  }

  if (files.length === 0) {
    files.push({
      path: "main.cpp",
      content: "",
    });
  }

  return files;
}

function sanitizeSnapshotFolders(
  value: unknown,
  files: FileItem[]
): string[] {
  const folders = new Set<string>();
  const filePaths = new Set(files.map((file) => file.path));

  for (const folder of readStringArray(value)) {
    const folderPath = normalizeWorkspacePath(folder);

    if (!isValidWorkspacePath(folderPath)) continue;
    if (filePaths.has(folderPath)) continue;

    folders.add(folderPath);
  }

  const tempRoom = {
    folders: Array.from(folders),
  } as Room;

  for (const file of files) {
    addParentFolders(tempRoom, file.path);
  }

  for (const folder of Array.from(folders)) {
    addParentFolders(tempRoom, folder);
  }

  return Array.from(new Set(tempRoom.folders));
}

function restoreRoomFromSnapshot(room: Room, snapshot: unknown): void {
  if (!isObject(snapshot)) {
    throw new Error("Snapshot must be a JSON object");
  }

  const files = sanitizeSnapshotFiles(snapshot.files);
  const folders = sanitizeSnapshotFolders(snapshot.folders, files);
  const activeFilePath =
    typeof snapshot.activeFilePath === "string"
      ? normalizeWorkspacePath(snapshot.activeFilePath)
      : "";
  const activeFileExists = files.some((file) => file.path === activeFilePath);
  const onlineUsers = new Set(room.clients.map((client) => client.userName));
  const requestedController =
    typeof snapshot.currentController === "string"
      ? snapshot.currentController
      : null;
  const previousController = room.currentController;

  room.files = files;
  room.folders = folders;
  room.activeFilePath = activeFileExists ? activeFilePath : files[0].path;
  room.consoleInput =
    typeof snapshot.consoleInput === "string" ? snapshot.consoleInput : "";
  room.stdinMode = snapshot.stdinMode === "file" ? "file" : "console";
  room.runHistory = Array.isArray(snapshot.runHistory)
    ? (snapshot.runHistory.slice(-50) as Room["runHistory"])
    : [];
  room.controlTimeline = Array.isArray(snapshot.controlTimeline)
    ? (snapshot.controlTimeline.slice(-100) as Room["controlTimeline"])
    : [];
  room.auditEvents = Array.isArray(snapshot.auditEvents)
    ? (snapshot.auditEvents.slice(-199) as Room["auditEvents"])
    : [];

  if (requestedController && onlineUsers.has(requestedController)) {
    room.currentController = requestedController;
  } else if (previousController && onlineUsers.has(previousController)) {
    room.currentController = previousController;
  } else {
    room.currentController =
      room.clients.length > 0 ? room.clients[0].userName : null;
  }

  room.controlRequests = readStringArray(snapshot.controlRequests).filter(
    (name) => onlineUsers.has(name) && name !== room.currentController
  );

  recordAuditEvent(room, {
    type: "snapshot_restored",
    actor: "snapshot_import",
    details: {
      fileCount: room.files.length,
      folderCount: room.folders.length,
      runCount: room.runHistory.length,
    },
  });
}

function removeUserFromOtherRooms(userName: string, targetRoomId: string): void {
  for (const [otherRoomId, otherRoom] of Object.entries(rooms)) {
    if (otherRoomId === targetRoomId) continue;

    const wasInRoom = otherRoom.clients.some(
      (client) => client.userName === userName
    );

    if (!wasInRoom) continue;

    otherRoom.clients = otherRoom.clients.filter(
      (client) => client.userName !== userName
    );

    otherRoom.controlRequests = otherRoom.controlRequests.filter(
      (name) => name !== userName
    );

    if (otherRoom.currentController === userName) {
      otherRoom.currentController =
        otherRoom.clients.length > 0 ? otherRoom.clients[0].userName : null;
    }

    if (otherRoom.clients.length === 0) {
      delete rooms[otherRoomId];
      console.log(`[ROOM REMOVED] ${otherRoomId}`);
    } else {
      broadcastRoomState(otherRoomId);
    }
  }
}
app.get("/", (_req, res) => {
  res.json({
    message: "ICPC Collab Backend is running",
  });
});

app.get("/rooms", (_req, res) => {
  const summaryByRoomId = new Map<
    string,
    {
      roomId: string;
      status: "online" | "saved";
      members: string[];
      currentController: string | null;
      controlRequests: string[];
      files: FileItem[];
      fileCount: number;
      folderCount: number;
      activeFilePath: string;
      runCount: number;
      savedAt: string | null;
    }
  >();

  for (const persistedRoom of listPersistedRooms()) {
    summaryByRoomId.set(persistedRoom.roomId, {
      roomId: persistedRoom.roomId,
      status: "saved",
      members: [],
      currentController: null,
      controlRequests: [],
      files: [],
      fileCount: persistedRoom.fileCount,
      folderCount: persistedRoom.folderCount,
      activeFilePath: persistedRoom.activeFilePath,
      runCount: persistedRoom.runCount,
      savedAt: persistedRoom.savedAt,
    });
  }

  for (const [roomId, room] of Object.entries(rooms)) {
    summaryByRoomId.set(roomId, {
      roomId,
      status: "online",
      members: room.clients.map((client) => client.userName),
      currentController: room.currentController,
      controlRequests: room.controlRequests,
      files: room.files,
      fileCount: room.files.length,
      folderCount: room.folders.length,
      activeFilePath: room.activeFilePath,
      runCount: room.runHistory.length,
      savedAt: null,
    });
  }

  res.json(Array.from(summaryByRoomId.values()));
});

app.post("/rooms", (req, res) => {
  const creatorUserName =
    isObject(req.body) && typeof req.body.creatorUserName === "string"
      ? req.body.creatorUserName.trim()
      : "";

  if (creatorUserName && isUserInAnyRoom(creatorUserName)) {
    res.status(409).json({
      type: "error",
      message: "You must leave your current room before creating a new room",
    });
    return;
  }

  let roomId: string;

  try {
    roomId = createRoomId();
  } catch (error) {
    res.status(500).json({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const room = createDefaultRoom();

  recordAuditEvent(room, {
    type: "room_created",
    actor: "system",
  });

  rooms[roomId] = room;
  saveRoomToDisk(roomId, room);

  res.status(201).json({
    roomId,
    joinPath: `/room/${roomId}`,
  });
});

app.get("/rooms/:roomId/snapshot", (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];

  if (!room) {
    res.status(404).json({
      type: "error",
      message: `Room "${roomId}" not found`,
    });
    return;
  }

  res.json(buildRoomSnapshot(roomId, room));
});

app.post("/rooms/:roomId/snapshot", (req, res) => {
  const { roomId } = req.params;

  if (!rooms[roomId]) {
    rooms[roomId] = createDefaultRoom();
  }

  const room = rooms[roomId];

  try {
    restoreRoomFromSnapshot(room, req.body);
  } catch (error) {
    res.status(400).json({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  broadcastRoomState(roomId);
  res.json(buildRoomSnapshot(roomId, room));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (socket: WebSocket) => {
  console.log("[WS CONNECTED]");

  socket.on("message", async (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString()) as ClientMessage;

      if (data.type === "join_room") {
        const { roomId, userName } = data;

        if (!roomId || !userName) {
          sendMessage(socket, {
            type: "error",
            message: "roomId and userName are required",
          });
          return;
        }

        const existingMeta = socketMeta.get(socket);
        if (existingMeta) {
          removeClientFromRoom(socket);
        }
        removeUserFromOtherRooms(userName, roomId);
        if (!rooms[roomId]) {
          const persistedRoom = loadRoomFromDisk(roomId);

          if (persistedRoom) {
            rooms[roomId] = persistedRoom;
            console.log(`[ROOM LOADED] ${roomId}`);
          } else {
            rooms[roomId] = createDefaultRoom();
            recordAuditEvent(rooms[roomId], {
              type: "room_created",
              actor: userName,
            });
            console.log(`[ROOM CREATED] ${roomId}`);
          }
        }

        const room = rooms[roomId];
        const addResult = addClientToRoom(room, { socket, userName });

        if (!addResult.ok) {
          sendMessage(socket, {
            type: "error",
            message: `User name "${userName}" already exists in room ${roomId}`,
          });
          return;
        }

        socketMeta.set(socket, { roomId, userName });

        if (room.currentController === userName) {
          console.log(`[CONTROL ASSIGNED] ${userName} controls room ${roomId}`);
        }

        console.log(`[JOIN] ${userName} joined room ${roomId}`);
        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "leave_room") {
        removeClientFromRoom(socket);
        socket.close();
        return;
      }
      if (data.type === "run_code") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can run code",
          });
          return;
        }

        if (
          data.activeFilePath === room.activeFilePath &&
          typeof data.activeFileContent === "string"
        ) {
          updateActiveFileContent(room, data.activeFileContent);
        }

        try {
          const runResult = await runCodeInRoom(room, userName, (message) => {
            broadcastToRoom(roomId, message);
          });

          broadcastToRoom(roomId, runResult);

          broadcastRoomState(roomId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          broadcastToRoom(roomId, {
            type: "run_result",
            output: `[Run system error]\n${message}`,
            stdout: "",
            stderr: message,
            exitCode: null,
            timedOut: false,
            runner: userName,
          });
        }

        return;
      }
      if (data.type === "request_control") {
        const context = getClientRoom(socket);
        
        if (!context) {
          sendMessage(socket, {
            type: "error",
            message: "You must join a room before requesting control",
          });
          return;
        }

        const { room, roomId, userName } = context;

        const result = requestControl(room, userName);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not request control",
          });
          return;
        }

        console.log(`[REQUEST CONTROL] ${userName} requested room ${roomId}`);
        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "approve_control") {
        const context = getClientRoom(socket);

        if (!context) {
          sendMessage(socket, {
            type: "error",
            message: "You must join a room before approving control",
          });
          return;
        }

        const { room, roomId, userName } = context;
        const { targetUserName } = data;

        const result = approveControl(room, userName, targetUserName);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not approve control request",
          });
          return;
        }

        console.log(
          `[CONTROL APPROVED] ${targetUserName} now controls room ${roomId}`
        );

        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "reject_control") {
        const context = getClientRoom(socket);

        if (!context) {
          sendMessage(socket, {
            type: "error",
            message: "You must join a room before rejecting control",
          });
          return;
        }

        const { room, roomId, userName } = context;
        const { targetUserName } = data;

        const result = rejectControl(room, userName, targetUserName);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not reject control request",
          });
          return;
        }

        console.log(`[CONTROL REJECTED] ${targetUserName} rejected`);

        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "update_file") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, userName } = context;

        if (room.currentController !== userName) return;

        updateActiveFileContent(room, data.content);

        broadcastRoomState(context.roomId);
        return;
      }
      if (data.type === "update_console_input") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can edit console input",
          });
          return;
        }

        room.consoleInput = data.consoleInput;
        recordAuditEvent(room, {
          type: "console_input_updated",
          actor: userName,
          details: {
            length: data.consoleInput.length,
          },
        });

        broadcastRoomState(roomId);
        return;
      }
      if (data.type === "update_stdin_mode") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can change input mode",
          });
          return;
        }

        room.stdinMode = data.stdinMode;
        recordAuditEvent(room, {
          type: "stdin_mode_changed",
          actor: userName,
          details: {
            stdinMode: data.stdinMode,
          },
        });

        broadcastRoomState(roomId);
        return;
      }
      if (data.type === "switch_file") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId } = context;
        const result = switchActiveFile(room, data.path);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not switch file",
          });
          return;
        }

        broadcastRoomState(roomId);
        return;
      }
      if (data.type === "create_folder") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can create folders",
          });
          return;
        }

        const result = createFolder(room, data.path);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not create folder",
          });
          return;
        }

        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "create_file") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can create files",
          });
          return;
        }

        const result = createFile(room, data.path);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not create file",
          });
          return;
        }

        broadcastRoomState(roomId);
        return;
      }
      if (data.type === "rename_item") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can rename files or folders",
          });
          return;
        }

        const result = renameItem(
          room,
          data.itemType,
          data.oldPath,
          data.newPath
        );

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not rename item",
          });
          return;
        }

        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "delete_item") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId, userName } = context;

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only controller can delete files or folders",
          });
          return;
        }

        const result = deleteItem(room, data.itemType, data.path);

        if (!result.ok) {
          sendMessage(socket, {
            type: "error",
            message: result.error || "Could not delete item",
          });
          return;
        }

        broadcastRoomState(roomId);
        return;
      }

      sendMessage(socket, {
        type: "error",
        message: "Unknown message type",
      });
    } catch (error) {
      sendMessage(socket, {
        type: "error",
        message: "Invalid JSON message",
      });
    }
  });

  socket.on("close", () => {
    removeClientFromRoom(socket);
    console.log("[WS CLOSED]");
  });

  socket.on("error", (err: Error) => {
    console.error("[WS ERROR]", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
