import express, { type Express } from "express";
import { WebSocketServer } from "ws";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import fs from "fs";
import path from "path";
import { ROOM_LIMITS } from "./limits";
import {
  clearPersistedAuditEvents,
  flushRoomSave,
  purgeIdleRooms,
  queueRoomSave,
} from "./persistence";
import { createRateLimiter, type RateLimiter } from "./rateLimit";
import { broadcastRoomStateMessage } from "./roomBroadcast";
import { registerRoomHttpRoutes } from "./roomHttpRoutes";
import { registerRoomWebSocket } from "./roomWebSocket";
import { getDefaultExecutor } from "./sandbox";
import type { Room } from "./types";

export type IcpcServerOptions = {
  /** Enables `GET /rooms` and `DELETE /rooms/:id` for holders of this token. */
  adminToken?: string;
  /** Set when a reverse proxy sits in front, so rate limits see client IPs. */
  trustProxy?: boolean;
  /** Extra browser origins allowed to call the HTTP API. Same-origin always works. */
  corsAllowedOrigins?: string[];
  controllerGraceMs?: number;
  /** Folder with the built web app. `null` serves the API only. */
  frontendDir?: string | null;
  createRoomLimiter?: RateLimiter;
  joinLimiter?: RateLimiter;
  heartbeatMs?: number;
  log?: (message: string) => void;
};

export type IcpcServer = {
  app: Express;
  server: Server;
  wss: WebSocketServer;
  rooms: Record<string, Room>;
  listen: (port?: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
  saveAllRooms: () => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where the built web app lives, looking from the usual working directories. */
export function findFrontendDir(): { dir: string; entry: string } | null {
  const roots = [
    path.resolve(process.cwd(), ".."),
    process.cwd(),
    path.resolve(__dirname, "..", ".."),
  ];

  for (const root of roots) {
    const found = resolveFrontend(path.join(root, "web", "dist"));

    if (found) return found;
  }

  return null;
}

function resolveFrontend(
  frontendDir: string | null | undefined
): { dir: string; entry: string } | null {
  if (frontendDir === null) return null;
  if (frontendDir === undefined) return findFrontendDir();

  const entry = path.join(frontendDir, "index.html");

  return fs.existsSync(entry) ? { dir: frontendDir, entry } : null;
}

export function createIcpcServer(options: IcpcServerOptions = {}): IcpcServer {
  const log = options.log || console.log;
  const app = express();
  const rooms: Record<string, Room> = {};
  const allowedOrigins = new Set(options.corsAllowedOrigins || []);
  const createRoomLimiter =
    options.createRoomLimiter ||
    createRateLimiter({ windowMs: 10 * 60_000, max: 20 });
  const joinLimiter =
    options.joinLimiter || createRateLimiter({ windowMs: 60_000, max: 40 });

  app.disable("x-powered-by");

  // The web app is served from this same origin, so browsers need no CORS
  // headers by default. Other origins must be listed explicitly.
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });
  app.use(express.json({ limit: "8mb" }));

  clearPersistedAuditEvents();

  function broadcastRoomState(roomId: string): void {
    const room = rooms[roomId];
    if (!room) return;

    queueRoomSave(roomId, room);
    broadcastRoomStateMessage(roomId, room);
  }

  function saveAllRooms(): void {
    for (const [roomId, room] of Object.entries(rooms)) {
      flushRoomSave(roomId, room);
    }
  }

  function purge(): void {
    const removed = purgeIdleRooms(
      ROOM_LIMITS.roomMaxIdleDays * DAY_MS,
      Object.keys(rooms)
    );

    if (removed.length > 0) {
      log(`[ROOMS PURGED] ${removed.length} idle room(s) removed`);
    }
  }

  registerRoomHttpRoutes({
    app,
    rooms,
    broadcastRoomState,
    adminToken: options.adminToken,
    trustProxy: options.trustProxy,
    createRoomLimiter,
    describeExecutor: () => {
      try {
        const executor = getDefaultExecutor();
        return { mode: executor.mode, sandboxed: executor.sandboxed, ok: true };
      } catch (error) {
        return {
          mode: "unavailable",
          sandboxed: false,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const frontend = resolveFrontend(options.frontendDir);

  if (frontend) {
    app.use(express.static(frontend.dir));

    for (const route of ["/", "/room/:roomId", "/r/:roomId"]) {
      app.get(route, (_req, res) => {
        res.sendFile(frontend.entry);
      });
    }
  } else if (options.frontendDir !== null) {
    log("[FRONTEND] web/dist not found (run `npm run build`); serving API only");
  }

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    maxPayload: ROOM_LIMITS.wsMaxPayloadBytes,
  });

  registerRoomWebSocket(wss, {
    rooms,
    broadcastRoomState,
    controllerGraceMs: options.controllerGraceMs,
    trustProxy: options.trustProxy,
    joinLimiter,
    heartbeatMs: options.heartbeatMs,
    log,
  });

  purge();
  const purgeTimer = setInterval(purge, DAY_MS);
  purgeTimer.unref();

  return {
    app,
    server,
    wss,
    rooms,
    saveAllRooms,
    listen(port = 0, host?: string): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close(): Promise<void> {
      clearInterval(purgeTimer);
      createRoomLimiter.dispose();
      joinLimiter.dispose();
      saveAllRooms();

      for (const socket of wss.clients) {
        socket.terminate();
      }

      return new Promise((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      });
    },
  };
}
