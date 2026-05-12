import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import {
  flushRoomSave,
  queueRoomSave,
} from "./persistence";
import { broadcastRoomStateMessage } from "./roomBroadcast";
import { registerRoomHttpRoutes } from "./roomHttpRoutes";
import { registerRoomWebSocket } from "./roomWebSocket";
import type { Room } from "./types";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = Number(process.env.PORT || 3001);

const rooms: Record<string, Room> = {};

function broadcastRoomState(roomId: string): void {
  const room = rooms[roomId];
  if (!room) return;

  queueRoomSave(roomId, room);
  broadcastRoomStateMessage(roomId, room);
}


function saveAllRoomsToDisk(): void {
  for (const [roomId, room] of Object.entries(rooms)) {
    flushRoomSave(roomId, room);
  }
}

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[${signal}] Saving rooms before shutdown`);
  saveAllRoomsToDisk();
  process.exit(0);
}

registerRoomHttpRoutes({
  app,
  rooms,
  broadcastRoomState,
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

registerRoomWebSocket(wss, {
  rooms,
  broadcastRoomState,
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", saveAllRoomsToDisk);
