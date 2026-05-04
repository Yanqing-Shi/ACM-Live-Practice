import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

type JoinRoomMessage = {
  type: "join_room";
  roomId: string;
  userName: string;
};

type LeaveRoomMessage = {
  type: "leave_room";
};

type RequestControlMessage = {
  type: "request_control";
};

type ApproveControlMessage = {
  type: "approve_control";
  targetUserName: string;
};

type RejectControlMessage = {
  type: "reject_control";
  targetUserName: string;
};


type FileItem = {
  path: string;
  content: string;
};

type UpdateFileMessage = {
  type: "update_file";
  content: string;
};

type SwitchFileMessage = {
  type: "switch_file";
  path: string;
};

type ClientMessage =
  | JoinRoomMessage
  | LeaveRoomMessage
  | RequestControlMessage
  | ApproveControlMessage
  | RejectControlMessage
  | UpdateFileMessage
  | SwitchFileMessage;


type RoomStateMessage = {
  type: "room_state";
  roomId: string;
  members: string[];
  currentController: string | null;
  controlRequests: string[];
  files: FileItem[];
  activeFilePath: string;
};

type ErrorMessage = {
  type: "error";
  message: string;
};

type ServerMessage = RoomStateMessage | ErrorMessage;

type ClientInfo = {
  socket: WebSocket;
  userName: string;
};

type Room = {
  clients: ClientInfo[];
  currentController: string | null;
  controlRequests: string[];
  files: FileItem[];
  activeFilePath: string;
};

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
  activeFilePath: room.activeFilePath,
};

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

  socket.on("message", (raw: Buffer) => {
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
            files: [
              {
                path: "main.cpp",
                content: `#include <bits/stdc++.h>
          using namespace std;

          int main() {
              cout << "Hello ICPC!" << endl;
              return 0;
          }
          `,
              },
              {
                path: "input.in",
                content: "",
              },
            ],
            activeFilePath: "main.cpp",
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