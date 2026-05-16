export const WRITABLE_ROOM_SCHEME = "icpc-room";
export const READONLY_ROOM_SCHEME = "icpc-room-readonly";

export type RoomDocumentMode = "writable" | "readonly";

export function roomDocumentModeForController(
  isController: boolean
): RoomDocumentMode {
  return isController ? "writable" : "readonly";
}

export function roomSchemeForMode(mode: RoomDocumentMode): string {
  return mode === "writable" ? WRITABLE_ROOM_SCHEME : READONLY_ROOM_SCHEME;
}

export function roomUriString(
  roomId: string,
  path: string,
  mode: RoomDocumentMode
): string {
  return `${roomSchemeForMode(mode)}://${roomId}/${encodeURI(path)}`;
}

export function roomUriStringForController(
  roomId: string,
  path: string,
  isController: boolean
): string {
  return roomUriString(roomId, path, roomDocumentModeForController(isController));
}

export function uriPathToWorkspacePath(uriPath: string): string {
  return decodeURIComponent(uriPath.replace(/^\/+/, ""));
}

export function replacementModeForControlChange(
  isController: boolean,
  documentScheme: string
): RoomDocumentMode | undefined {
  if (isController && documentScheme === READONLY_ROOM_SCHEME) {
    return "writable";
  }

  if (!isController && documentScheme === WRITABLE_ROOM_SCHEME) {
    return "readonly";
  }

  return undefined;
}
