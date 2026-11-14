import type { Express, Request, Response } from "express";
import { appendAuditEvent } from "./events";
import { createDefaultRoom } from "./roomActions";
import {
  deleteRoomFromDisk,
  flushRoomSave,
  listPersistedRooms,
  loadRoomFromDisk,
  roomExistsOnDisk,
  saveRoomToDisk,
} from "./persistence";
import { clientAddress, createRateLimiter, type RateLimiter } from "./rateLimit";
import { findMemberByToken, safeEqual } from "./session";
import {
  buildRoomSnapshot,
  restoreRoomFromSnapshot,
} from "./snapshot";
import { buildWorkspaceZip } from "./workspaceExport";
import { checkRunnerHealth, type RunnerHealthItem } from "./runnerHealth";
import type { Room } from "./types";
import { generateRoomCode, isValidRoomId, roomIdCandidates } from "./validation";

export type RegisterRoomHttpRoutesOptions = {
  app: Express;
  rooms: Record<string, Room>;
  broadcastRoomState: (roomId: string) => void;
  /** Enables the admin routes (`GET /rooms`, `DELETE /rooms/:id`) when set. */
  adminToken?: string;
  trustProxy?: boolean;
  createRoomLimiter?: RateLimiter;
  /** Extra fields for `/health/runners`, e.g. the active executor. */
  describeExecutor?: () => unknown;
};

const RUNNER_HEALTH_CACHE_MS = 60_000;

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({
    type: "error",
    message,
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;

  if (typeof header !== "string") {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

function createRoomId(rooms: Record<string, Room>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const roomId = generateRoomCode();

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
  adminToken,
  trustProxy = false,
  createRoomLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20 }),
  describeExecutor,
}: RegisterRoomHttpRoutesOptions): void {
  let runnerHealthCache: { at: number; runners: RunnerHealthItem[] } | null = null;

  /** Find a room that is loaded or saved, accepting typed team codes. */
  function resolveRoom(
    rawRoomId: string
  ): { roomId: string; room: Room; online: boolean } | null {
    for (const roomId of roomIdCandidates(rawRoomId)) {
      const onlineRoom = rooms[roomId];

      if (onlineRoom) {
        return { roomId, room: onlineRoom, online: true };
      }

      const savedRoom = loadRoomFromDisk(roomId);

      if (savedRoom) {
        return { roomId, room: savedRoom, online: false };
      }
    }

    return null;
  }

  /**
   * Resolve the room and check the caller's session token. Answers 401/404
   * itself and returns null when the request must stop.
   */
  function authorizeMember(
    req: Request,
    res: Response
  ): { roomId: string; room: Room; online: boolean; userName: string } | null {
    const rawRoomId = String(req.params.roomId || "");

    if (roomIdCandidates(rawRoomId).length === 0) {
      sendError(res, 400, "Invalid roomId");
      return null;
    }

    const token = bearerToken(req);

    if (!token) {
      sendError(res, 401, "Join the room first: a session token is required");
      return null;
    }

    const resolved = resolveRoom(rawRoomId);
    const member = resolved ? findMemberByToken(resolved.room, token) : null;

    // The same answer for "no such room" and "not a member", so this route
    // cannot be used to discover which team codes exist.
    if (!resolved || !member) {
      sendError(res, 403, "You are not a member of this room");
      return null;
    }

    return { ...resolved, userName: member.name };
  }

  function requireAdmin(req: Request, res: Response): boolean {
    const token = bearerToken(req);

    if (!adminToken || !token || !safeEqual(token, adminToken)) {
      sendError(res, 404, "Not found");
      return false;
    }

    return true;
  }

  app.get("/health", (_req, res) => {
    res.json({
      message: "ICPC Collab Backend is running",
    });
  });

  app.get("/health/runners", async (_req, res) => {
    // Each probe spawns five processes, so an unauthenticated caller must not
    // be able to trigger them on every request.
    if (!runnerHealthCache || Date.now() - runnerHealthCache.at > RUNNER_HEALTH_CACHE_MS) {
      runnerHealthCache = { at: Date.now(), runners: await checkRunnerHealth() };
    }

    const runners = runnerHealthCache.runners;
    const allAvailable = runners.every((runner) => runner.available);

    res.json({
      ok: allAvailable,
      platform: process.platform,
      runners,
      ...(describeExecutor ? { executor: describeExecutor() } : {}),
    });
  });

  app.get("/rooms", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const summaryByRoomId = new Map<
      string,
      {
        roomId: string;
        status: "online" | "saved";
        members: string[];
        currentController: string | null;
        fileCount: number;
        folderCount: number;
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
        fileCount: persistedRoom.fileCount,
        folderCount: persistedRoom.folderCount,
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
        fileCount: room.files.length,
        folderCount: room.folders.length,
        runCount: room.runHistory.length,
        savedAt: summaryByRoomId.get(roomId)?.savedAt || null,
      });
    }

    res.json(Array.from(summaryByRoomId.values()));
  });

  app.post("/rooms", (req, res) => {
    if (!createRoomLimiter.take(clientAddress(req, trustProxy))) {
      sendError(res, 429, "Too many rooms created from this address. Try again later.");
      return;
    }

    let roomId: string;

    try {
      roomId = createRoomId(rooms);
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error));
      return;
    }

    // The room is only written to disk here. It is loaded into memory when the
    // first member joins, so abandoned creations do not pile up in memory.
    saveRoomToDisk(roomId, createDefaultRoom());

    res.status(201).json({
      roomId,
      joinPath: `/r/${roomId}`,
    });
  });

  app.delete("/rooms/:roomId", (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { roomId } = req.params;

    if (!isValidRoomId(roomId)) {
      sendError(res, 400, "Invalid roomId");
      return;
    }

    if (rooms[roomId]) {
      sendError(
        res,
        409,
        `Room "${roomId}" is online. Leave the room before deleting it.`
      );
      return;
    }

    if (!deleteRoomFromDisk(roomId)) {
      sendError(res, 404, `Room "${roomId}" not found`);
      return;
    }

    res.json({
      ok: true,
      roomId,
    });
  });

  app.get("/rooms/:roomId/snapshot", (req, res) => {
    const access = authorizeMember(req, res);
    if (!access) return;

    res.json(buildRoomSnapshot(access.roomId, access.room));
  });

  app.get("/rooms/:roomId/workspace.zip", (req, res) => {
    const access = authorizeMember(req, res);
    if (!access) return;

    const zip = buildWorkspaceZip(access.roomId, access.room);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="icpc-room-${access.roomId}-workspace.zip"`
    );
    res.send(zip);
  });

  app.post("/rooms/:roomId/snapshot", (req, res) => {
    const access = authorizeMember(req, res);
    if (!access) return;

    const { roomId, room, userName } = access;

    // Importing replaces the whole workspace, so it follows the same rule as
    // every other edit: only the member holding control may do it.
    if (!access.online || room.currentController !== userName) {
      sendError(res, 403, "Only the current controller can import a snapshot");
      return;
    }

    if (room.runInProgress) {
      sendError(res, 409, "Wait for the current run to finish before importing");
      return;
    }

    try {
      restoreRoomFromSnapshot(room, req.body);
      appendAuditEvent(room, {
        action: "snapshot_restored",
        actor: userName,
        target: roomId,
      });
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
      return;
    }

    flushRoomSave(roomId, room);
    broadcastRoomState(roomId);

    res.json(buildRoomSnapshot(roomId, room));
  });
}
