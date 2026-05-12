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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
