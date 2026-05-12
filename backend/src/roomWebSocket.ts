import type { WebSocketServer, WebSocket } from "ws";
import { loadRoomFromDisk, saveRoomToDisk } from "./persistence";
import {
  addClientToRoom,
  approveControl,
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
import type { ClientMessage, Room, ServerMessage } from "./types";
import { isValidRoomId, isValidUserName } from "./validation";

type RegisterRoomWebSocketOptions = {
  rooms: Record<string, Room>;
  broadcastRoomState: (roomId: string) => void;
};

type ClientRoomContext = {
  room: Room;
  roomId: string;
  userName: string;
};

export function registerRoomWebSocket(
  wss: WebSocketServer,
  { rooms, broadcastRoomState }: RegisterRoomWebSocketOptions
): void {
  const socketMeta = new Map<WebSocket, { roomId: string; userName: string }>();

  function sendMessage(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function broadcastToRoom(roomId: string, message: ServerMessage): void {
    const room = rooms[roomId];
    if (!room) return;

    const serialized = JSON.stringify(message);

    for (const client of room.clients) {
      if (client.socket.readyState === client.socket.OPEN) {
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

  function getClientRoom(socket: WebSocket): ClientRoomContext | null {
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

  function removeUserFromOtherRooms(
    userName: string,
    targetRoomId: string
  ): void {
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

  wss.on("connection", (socket: WebSocket) => {
    console.log("[WS CONNECTED]");

    socket.on("message", async (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString()) as ClientMessage;

        if (data.type === "join_room") {
          const roomId = data.roomId.trim();
          const userName = data.userName.trim();

          if (!roomId || !userName) {
            sendMessage(socket, {
              type: "error",
              message: "roomId and userName are required",
            });
            return;
          }

          if (!isValidUserName(userName)) {
            sendMessage(socket, {
              type: "error",
              message: "Invalid userName",
            });
            return;
          }

          if (!isValidRoomId(roomId)) {
            sendMessage(socket, {
              type: "error",
              message: "Invalid roomId",
            });
            return;
          }

          const existingMeta = socketMeta.get(socket);
          if (existingMeta) {
            if (existingMeta.roomId === roomId) {
              sendMessage(socket, {
                type: "error",
                message: "You are already in this room",
              });
              return;
            }

            sendMessage(socket, {
              type: "error",
              message: "Leave your current room before joining another room",
            });
            return;
          }

          removeUserFromOtherRooms(userName, roomId);

          if (!rooms[roomId]) {
            const persistedRoom = loadRoomFromDisk(roomId);

            if (persistedRoom) {
              rooms[roomId] = persistedRoom;
              console.log(`[ROOM LOADED] ${roomId}`);
            } else {
              sendMessage(socket, {
                type: "error",
                message: `Room "${roomId}" does not exist. Create a room first.`,
              });
              return;
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
            console.log(
              `[CONTROL ASSIGNED] ${userName} controls room ${roomId}`
            );
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
            const message =
              error instanceof Error ? error.message : String(error);

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
      } catch {
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
}
