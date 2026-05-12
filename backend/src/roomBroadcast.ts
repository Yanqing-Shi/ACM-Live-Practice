import { WebSocket } from "ws";
import type { Room, RoomStateMessage } from "./types";

export function buildRoomStateMessage(
  roomId: string,
  room: Room
): RoomStateMessage {
  return {
    type: "room_state",
    roomId,
    members: room.clients.map((client) => client.userName),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
  };
}

export function broadcastRoomStateMessage(
  roomId: string,
  room: Room
): void {
  const serialized = JSON.stringify(buildRoomStateMessage(roomId, room));

  for (const client of room.clients) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(serialized);
    }
  }
}
