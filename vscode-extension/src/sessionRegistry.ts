import { roomKey, seatFolderName } from "./roomUris";

/** The subset of VS Code's Memento this module needs. */
export type KeyValueStore = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
};

/** Who this VS Code installation is in a room, and on which server. */
export type RoomIdentity = {
  serverUrl: string;
  roomId: string;
  userName: string;
};

const identityKey = (key: string, folderName: string) =>
  `icpcLive.seat.${key.toLowerCase()}/${folderName}`;

function normalizeServer(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "").toLowerCase();
}

const tokenKey = (identity: RoomIdentity) =>
  `icpcLive.token|${normalizeServer(identity.serverUrl)}|${roomKey(identity.roomId)}|${identity.userName}`;

/**
 * Remembers seats across windows and restarts. Joining opens the room in
 * another window (a fresh extension host), which finds who it is here by the
 * room key and folder name in its folder URI, and its seat on the server by
 * the stored session token. Each name in a room is a separate seat, so one
 * VS Code can hold several members of the same room in separate windows.
 */
export function createSessionRegistry(store: KeyValueStore) {
  return {
    getIdentity(key: string, folderName: string): RoomIdentity | undefined {
      const value = store.get<Partial<RoomIdentity>>(identityKey(key, folderName));

      return value &&
        typeof value.serverUrl === "string" &&
        typeof value.roomId === "string" &&
        typeof value.userName === "string"
        ? { serverUrl: value.serverUrl, roomId: value.roomId, userName: value.userName }
        : undefined;
    },
    saveIdentity(identity: RoomIdentity): void {
      void store.update(identityKey(roomKey(identity.roomId), seatFolderName(identity)), identity);
    },
    forgetIdentity(identity: RoomIdentity): void {
      void store.update(
        identityKey(roomKey(identity.roomId), seatFolderName(identity)),
        undefined
      );
    },
    getToken(identity: RoomIdentity): string | undefined {
      return store.get<string>(tokenKey(identity)) || undefined;
    },
    saveToken(identity: RoomIdentity, token: string): void {
      void store.update(tokenKey(identity), token);
    },
    forgetToken(identity: RoomIdentity): void {
      void store.update(tokenKey(identity), undefined);
    },
    /** The name used last time, offered as the default next time. */
    getLastName(): string {
      return store.get<string>("icpcLive.lastName") || "";
    },
    setLastName(userName: string): void {
      void store.update("icpcLive.lastName", userName);
    },
  };
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
