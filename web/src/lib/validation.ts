const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

export function isValidRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9_-]{3,64}$/.test(roomId);
}

export function isValidUserName(userName: string): boolean {
  return (
    userName.length >= 1 &&
    userName.length <= 32 &&
    !/[\x00-\x1F\x7F]/.test(userName)
  );
}

/** "abc-def" or " ABC DEF " -> "ABCDEF"; null when it is not a team code. */
export function normalizeRoomCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "").toUpperCase();

  if (compact.length !== ROOM_CODE_LENGTH) return null;

  for (const char of compact) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return null;
  }

  return compact;
}

/** What to send to the server for something typed into the code box. */
export function cleanRoomInput(input: string): string {
  return normalizeRoomCode(input) ?? input.trim();
}

export function isJoinableRoomInput(input: string): boolean {
  return normalizeRoomCode(input) !== null || isValidRoomId(input.trim());
}

/** Team codes are shown in two groups of three so they are easy to read out. */
export function formatRoomCode(roomId: string): string {
  return normalizeRoomCode(roomId) === roomId
    ? `${roomId.slice(0, 3)}-${roomId.slice(3)}`
    : roomId;
}

/** Reads the room from `/r/CODE`, `/room/id` or `?room=id`. */
export function readRoomFromLocation(location: {
  pathname: string;
  search: string;
}): string {
  const match = /^\/(?:r|room)\/([^/]+)\/?$/.exec(location.pathname);

  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  return new URLSearchParams(location.search).get("room") || "";
}

export function roomPath(roomId: string): string {
  return `/r/${encodeURIComponent(roomId)}`;
}
