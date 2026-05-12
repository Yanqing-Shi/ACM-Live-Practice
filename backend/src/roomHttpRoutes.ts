import type { Express } from "express";
import { randomBytes } from "crypto";
import { createDefaultRoom } from "./roomActions";
import {
  deleteRoomFromDisk,
  flushRoomSave,
  listPersistedRooms,
  loadRoomFromDisk,
  roomExistsOnDisk,
  saveRoomToDisk,
} from "./persistence";
import {
  buildRoomSnapshot,
  restoreRoomFromSnapshot,
} from "./snapshot";
import type { FileItem, Room } from "./types";
import {
  isObject,
  isValidRoomId,
  isValidUserName,
} from "./validation";

type RegisterRoomHttpRoutesOptions = {
  app: Express;
  rooms: Record<string, Room>;
  broadcastRoomState: (roomId: string) => void;
};

function isUserInAnyRoom(
  rooms: Record<string, Room>,
  userName: string
): boolean {
  return Object.values(rooms).some((room) =>
    room.clients.some((client) => client.userName === userName)
  );
}

function createRoomId(rooms: Record<string, Room>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const roomId = `room-${randomBytes(4).toString("hex")}`;

    if (!rooms[roomId] && !roomExistsOnDisk(roomId)) {
      return roomId;
    }
  }

  throw new Error("Could not generate a unique room id");
}

export function registerRoomHttpRoutes({
  app,
  rooms,
  broadcastRoomState,
}: RegisterRoomHttpRoutesOptions): void {
  app.get("/", (_req, res) => {
    res.json({
      message: "ICPC Collab Backend is running",
    });
  });

  app.get("/rooms", (_req, res) => {
    const persistedRooms = listPersistedRooms();
    const persistedRoomById = new Map(
      persistedRooms.map((room) => [room.roomId, room])
    );
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

    for (const persistedRoom of persistedRooms) {
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
      const persistedRoom = persistedRoomById.get(roomId);

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
        savedAt: persistedRoom?.savedAt || null,
      });
    }

    res.json(Array.from(summaryByRoomId.values()));
  });

  app.post("/rooms", (req, res) => {
    const creatorUserName =
      isObject(req.body) && typeof req.body.creatorUserName === "string"
        ? req.body.creatorUserName.trim()
        : "";

    if (creatorUserName && isUserInAnyRoom(rooms, creatorUserName)) {
      res.status(409).json({
        type: "error",
        message: "You must leave your current room before creating a new room",
      });
      return;
    }

    if (creatorUserName && !isValidUserName(creatorUserName)) {
      res.status(400).json({
        type: "error",
        message: "Invalid userName",
      });
      return;
    }

    let roomId: string;

    try {
      roomId = createRoomId(rooms);
    } catch (error) {
      res.status(500).json({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const room = createDefaultRoom();

    rooms[roomId] = room;
    saveRoomToDisk(roomId, room);

    res.status(201).json({
      roomId,
      joinPath: `/room/${roomId}`,
    });
  });

  app.delete("/rooms/:roomId", (req, res) => {
    const { roomId } = req.params;

    if (rooms[roomId]) {
      res.status(409).json({
        type: "error",
        message: `Room "${roomId}" is online. Leave the room before deleting it.`,
      });
      return;
    }

    const deleted = deleteRoomFromDisk(roomId);

    if (!deleted) {
      res.status(404).json({
        type: "error",
        message: `Room "${roomId}" not found`,
      });
      return;
    }

    res.json({
      ok: true,
      roomId,
    });
  });

  app.get("/rooms/:roomId/snapshot", (req, res) => {
    const { roomId } = req.params;

    if (!isValidRoomId(roomId)) {
      res.status(400).json({
        type: "error",
        message: "Invalid roomId",
      });
      return;
    }

    const room = rooms[roomId] || loadRoomFromDisk(roomId);

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

    if (!isValidRoomId(roomId)) {
      res.status(400).json({
        type: "error",
        message: "Invalid roomId",
      });
      return;
    }

    const roomWasOnline = Boolean(rooms[roomId]);
    const room = rooms[roomId] || createDefaultRoom();

    try {
      restoreRoomFromSnapshot(room, req.body);
    } catch (error) {
      res.status(400).json({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    flushRoomSave(roomId, room);

    if (roomWasOnline) {
      broadcastRoomState(roomId);
    }

    res.json(buildRoomSnapshot(roomId, room));
  });
}
