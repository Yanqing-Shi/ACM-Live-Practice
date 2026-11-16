import { WebSocket } from "ws";
import type { MemberState, Room, RoomStateMessage, ServerMessage } from "./types";

function buildMemberStates(room: Room): MemberState[] {
  const connected = new Set(room.clients.map((client) => client.userName));
  const states: MemberState[] = room.members.map((member) => ({
    name: member.name,
    connected: connected.has(member.name),
  }));
  const seated = new Set(states.map((state) => state.name));

  for (const name of connected) {
    if (!seated.has(name)) {
      states.push({ name, connected: true });
    }
  }

  return states;
}

export function buildRoomStateMessage(
  roomId: string,
  room: Room
): RoomStateMessage {
  return {
    type: "room_state",
    roomId,
    members: room.clients.map((client) => client.userName),
    memberStates: buildMemberStates(room),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
    controlTimeline: room.controlTimeline,
    contest: room.contest,
    running: room.runInProgress === true,
    serverTime: new Date().toISOString(),
  };
}

/** Send one message to every connected member, optionally skipping one socket. */
export function sendToRoom(
  room: Room,
  message: ServerMessage,
  except?: WebSocket
): void {
  const serialized = JSON.stringify(message);

  for (const client of room.clients) {
    if (client.socket !== except && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(serialized);
    }
  }
}

export function broadcastRoomStateMessage(
  roomId: string,
  room: Room
): void {
  // The state is serialised once; only the per-connection acknowledgement
  // differs between recipients, so it is appended to the shared text.
  const shared = JSON.stringify(buildRoomStateMessage(roomId, room)).slice(0, -1);

  for (const client of room.clients) {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(`${shared},"ackSeq":${client.editSeq ?? 0}}`);
    }
  }
}
