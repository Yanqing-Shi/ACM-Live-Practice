import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { runCodeInRoom } from "./runner";
import type {
  ClientMessage,
  Room,
  RoomStateMessage,
  ServerMessage,
} from "./types";
import {
  addParentFolders,
  chooseNextActiveFile,
  getParentFolders,
  hasFile,
  hasFolder,
  isValidWorkspacePath,
  normalizeWorkspacePath,
} from "./workspace";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

const rooms: Record<string, Room> = {};
const socketMeta = new Map<WebSocket, { roomId: string; userName: string }>();

function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastRoomState(roomId: string): void {
  const room = rooms[roomId];
  if (!room) return;

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
    room.clients = room.clients.filter((client) => client.socket !== socket);
    room.controlRequests = room.controlRequests.filter(
      (name) => name !== userName
    );

    console.log(`[LEAVE] ${userName} left room ${roomId}`);

    if (room.clients.length === 0) {
      delete rooms[roomId];
      console.log(`[ROOM REMOVED] ${roomId}`);
    } else {
      if (room.currentController === userName) {
        room.currentController = room.clients[0].userName;
        console.log(
          `[CONTROL TRANSFER] ${room.currentController} is now controller of room ${roomId}`
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
  const summary = Object.entries(rooms).map(([roomId, room]) => ({
    roomId,
    members: room.clients.map((client) => client.userName),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    activeFilePath: room.activeFilePath,
  }));

  res.json(summary);
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
          rooms[roomId] = {
            clients: [],
            currentController: null,
            controlRequests: [],
            folders: [],
            files: [
              {
                path: "main.cpp",
                content: ``
              },
            ],
            activeFilePath: "main.cpp",
            consoleInput: "",
            stdinMode: "console",
          };
          console.log(`[ROOM CREATED] ${roomId}`);
        }

        const room = rooms[roomId];
        
        const alreadyInRoom = room.clients.some(
          (client) => client.userName === userName
        );

        if (alreadyInRoom) {
          sendMessage(socket, {
            type: "error",
            message: `User name "${userName}" already exists in room ${roomId}`,
          });
          return;
        }

        room.clients.push({ socket, userName });
        socketMeta.set(socket, { roomId, userName });

        if (room.currentController === null) {
          room.currentController = userName;
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
          const activeFile = room.files.find(
            (f) => f.path === room.activeFilePath
          );

          if (activeFile) {
            activeFile.content = data.activeFileContent;
          }
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

        if (room.currentController === userName) {
          sendMessage(socket, {
            type: "error",
            message: "You are already the controller",
          });
          return;
        }

        if (!room.controlRequests.includes(userName)) {
          room.controlRequests.push(userName);
          console.log(`[REQUEST CONTROL] ${userName} requested room ${roomId}`);
        }

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

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only the current controller can approve control requests",
          });
          return;
        }

        const targetExists = room.clients.some(
          (client) => client.userName === targetUserName
        );

        if (!targetExists) {
          sendMessage(socket, {
            type: "error",
            message: `Target user "${targetUserName}" is not in this room`,
          });
          return;
        }

        if (!room.controlRequests.includes(targetUserName)) {
          sendMessage(socket, {
            type: "error",
            message: `User "${targetUserName}" has not requested control`,
          });
          return;
        }

        room.currentController = targetUserName;
        room.controlRequests = room.controlRequests.filter(
          (name) => name !== targetUserName
        );

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

        if (room.currentController !== userName) {
          sendMessage(socket, {
            type: "error",
            message: "Only the current controller can reject control requests",
          });
          return;
        }

        room.controlRequests = room.controlRequests.filter(
          (name) => name !== targetUserName
        );

        console.log(`[CONTROL REJECTED] ${targetUserName} rejected`);

        broadcastRoomState(roomId);
        return;
      }

      if (data.type === "update_file") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, userName } = context;

        if (room.currentController !== userName) return;

        const file = room.files.find(
          (f) => f.path === room.activeFilePath
        );

        if (file) {
          file.content = data.content;
        }

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

        broadcastRoomState(roomId);
        return;
      }
      if (data.type === "switch_file") {
        const context = getClientRoom(socket);
        if (!context) return;

        const { room, roomId } = context;

        const exists = room.files.some((f) => f.path === data.path);

        if (exists) {
          room.activeFilePath = data.path;
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

        const folderPath = data.path.trim().replace(/\/+$/, "");

        if (!isValidWorkspacePath(folderPath)) {
          sendMessage(socket, {
            type: "error",
            message: "Invalid folder path",
          });
          return;
        }

        const fileWithSamePath = room.files.some((f) => f.path === folderPath);

        if (fileWithSamePath) {
          sendMessage(socket, {
            type: "error",
            message: `A file named "${folderPath}" already exists`,
          });
          return;
        }

        const parentFolders = getParentFolders(folderPath);

        for (const parent of parentFolders) {
          if (!room.folders.includes(parent)) {
            room.folders.push(parent);
          }
        }

        if (!room.folders.includes(folderPath)) {
          room.folders.push(folderPath);
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

        const newPath = data.path.trim();

        if (!newPath) {
          sendMessage(socket, {
            type: "error",
            message: "File name is required",
          });
          return;
        }

        if (newPath.includes("..") || newPath.startsWith("/") || newPath.startsWith("\\")) {
          sendMessage(socket, {
            type: "error",
            message: "Invalid file path",
          });
          return;
        }

        const alreadyExists = room.files.some((f) => f.path === newPath);

        if (alreadyExists) {
          sendMessage(socket, {
            type: "error",
            message: `File "${newPath}" already exists`,
          });
          return;
        }
        const parentFolders = getParentFolders(newPath);

        for (const folder of parentFolders) {
          if (!room.folders.includes(folder)) {
            room.folders.push(folder);
          }
        }
        room.files.push({
          path: newPath,
          content: "",
        });

        room.activeFilePath = newPath;

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

        const oldPath = normalizeWorkspacePath(data.oldPath);
        const newPath = normalizeWorkspacePath(data.newPath);

        if (!isValidWorkspacePath(oldPath) || !isValidWorkspacePath(newPath)) {
          sendMessage(socket, {
            type: "error",
            message: "Invalid path",
          });
          return;
        }

        if (oldPath === newPath) {
          return;
        }

        if (hasFile(room, newPath) || hasFolder(room, newPath)) {
          sendMessage(socket, {
            type: "error",
            message: `Path "${newPath}" already exists`,
          });
          return;
        }

        if (data.itemType === "file") {
          const file = room.files.find((f) => f.path === oldPath);

          if (!file) {
            sendMessage(socket, {
              type: "error",
              message: `File "${oldPath}" not found`,
            });
            return;
          }

          file.path = newPath;
          addParentFolders(room, newPath);

          if (room.activeFilePath === oldPath) {
            room.activeFilePath = newPath;
          }

          broadcastRoomState(roomId);
          return;
        }

        if (data.itemType === "folder") {
          if (!room.folders.includes(oldPath)) {
            sendMessage(socket, {
              type: "error",
              message: `Folder "${oldPath}" not found`,
            });
            return;
          }

          const oldPrefix = oldPath + "/";

          room.folders = room.folders.map((folder) => {
            if (folder === oldPath) return newPath;

            if (folder.startsWith(oldPrefix)) {
              return newPath + folder.slice(oldPath.length);
            }

            return folder;
          });

          room.files = room.files.map((file) => {
            if (file.path.startsWith(oldPrefix)) {
              return {
                ...file,
                path: newPath + file.path.slice(oldPath.length),
              };
            }

            return file;
          });

          if (room.activeFilePath.startsWith(oldPrefix)) {
            room.activeFilePath =
              newPath + room.activeFilePath.slice(oldPath.length);
          }

          addParentFolders(room, newPath);

          room.folders = Array.from(new Set(room.folders));

          broadcastRoomState(roomId);
          return;
        }
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

        const targetPath = normalizeWorkspacePath(data.path);

        if (!isValidWorkspacePath(targetPath)) {
          sendMessage(socket, {
            type: "error",
            message: "Invalid path",
          });
          return;
        }

        if (data.itemType === "file") {
          const beforeCount = room.files.length;

          room.files = room.files.filter((f) => f.path !== targetPath);

          if (room.files.length === beforeCount) {
            sendMessage(socket, {
              type: "error",
              message: `File "${targetPath}" not found`,
            });
            return;
          }

          if (room.activeFilePath === targetPath) {
            chooseNextActiveFile(room);
          }

          broadcastRoomState(roomId);
          return;
        }

        if (data.itemType === "folder") {
          if (!room.folders.includes(targetPath)) {
            sendMessage(socket, {
              type: "error",
              message: `Folder "${targetPath}" not found`,
            });
            return;
          }

          const prefix = targetPath + "/";

          room.folders = room.folders.filter(
            (folder) => folder !== targetPath && !folder.startsWith(prefix)
          );

          room.files = room.files.filter(
            (file) => !file.path.startsWith(prefix)
          );

          if (room.activeFilePath.startsWith(prefix)) {
            chooseNextActiveFile(room);
          }

          broadcastRoomState(roomId);
          return;
        }
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
  console.log(`Server is running at http://localhost:${PORT}`);
});
