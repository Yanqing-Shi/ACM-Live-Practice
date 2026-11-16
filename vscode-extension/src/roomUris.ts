// How a seat in a room maps onto VS Code URIs. No `vscode` import: this is
// unit-tested with plain Node.
//
//   icpc-room://<room key>/<folder name>/<workspace path>
//
// The room key (the room id in lower case) identifies the room; VS Code
// lower-cases URI authorities, so nothing else is safe there. The folder name
// is "<team code> (<your name>)". It is what the Explorer and the window title
// show, and it makes each member's window a different folder: VS Code only
// opens a folder once, so without the name a second member joining from the
// same VS Code would just be sent to the first member's window.

export const ROOM_SCHEME = "icpc-room";
export const INPUT_SCHEME = "icpc-room-input";
export const INPUT_FILE_NAME = "Program Input.txt";

const ROOM_CODE = /^[A-HJKMNP-Z2-9]{6}$/;

export function roomKey(roomId: string): string {
  return roomId.toLowerCase();
}

/** Team codes are shown in two groups of three; older ids are shown as is. */
export function formatRoomCode(roomId: string): string {
  return ROOM_CODE.test(roomId) ? `${roomId.slice(0, 3)}-${roomId.slice(3)}` : roomId;
}

/** A member's place in a room: which room, under which name. */
export type Seat = { roomId: string; userName: string };

/**
 * The folder a seat's window is opened on, e.g. "ZNA-MR7 (Alice)". Slashes
 * cannot appear in a single path segment, so they are replaced by a
 * look-alike; the name itself is kept in the saved identity, not parsed back.
 */
export function seatFolderName(seat: Seat): string {
  const name = seat.userName.replace(/[\\/]/g, "\u2215").trim();

  return `${formatRoomCode(seat.roomId)} (${name})`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The folder a window is opened on for this seat. */
export function roomRootUriString(seat: Seat): string {
  return `${ROOM_SCHEME}://${roomKey(seat.roomId)}/${encodeURIComponent(seatFolderName(seat))}`;
}

export function workspacePathToUriString(seat: Seat, path: string): string {
  const root = roomRootUriString(seat);

  return path ? `${root}/${encodePath(path)}` : root;
}

export function inputUriString(roomId: string): string {
  return `${INPUT_SCHEME}://${roomKey(roomId)}/${encodeURIComponent(INPUT_FILE_NAME)}`;
}

export type RoomLocation =
  /** The authority itself: a directory holding only seat folders. */
  | { roomKey: string; kind: "container" }
  /** Something inside a seat's folder; `path` is "" for the folder itself. */
  | { roomKey: string; kind: "entry"; folderName: string; path: string };

/**
 * Split a room URI (already-decoded `authority` and `path`, as VS Code's Uri
 * exposes them) into the room, the seat folder and the workspace path.
 */
export function parseRoomUri(authority: string, uriPath: string): RoomLocation {
  const segments = uriPath.split("/").filter((segment) => segment !== "");
  const key = authority.toLowerCase();

  if (segments.length === 0) {
    return { roomKey: key, kind: "container" };
  }

  return {
    roomKey: key,
    kind: "entry",
    folderName: segments[0],
    path: segments.slice(1).join("/"),
  };
}
