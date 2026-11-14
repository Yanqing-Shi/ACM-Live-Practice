import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { ROOM_LIMITS } from "./limits";
import type { ErrorCode, Room, RoomMember } from "./types";

export function createSessionToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");

  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenMatches(member: RoomMember, token: string): boolean {
  return safeEqual(member.tokenHash, hashSessionToken(token));
}

export function findMember(room: Room, userName: string): RoomMember | null {
  return room.members.find((member) => member.name === userName) || null;
}

export function findMemberByToken(
  room: Room,
  token: string | null | undefined
): RoomMember | null {
  if (!token) {
    return null;
  }

  return room.members.find((member) => tokenMatches(member, token)) || null;
}

export type ClaimSeatResult =
  | { ok: true; member: RoomMember; sessionToken: string; isNewSeat: boolean }
  | { ok: false; code: ErrorCode; error: string };

function isConnected(room: Room, userName: string): boolean {
  return room.clients.some((client) => client.userName === userName);
}

/**
 * Give `userName` a seat in the room.
 *
 * A name that already has a seat can only be taken again with the token that
 * was issued for it, so a refresh resumes the seat and nobody else can use the
 * name. A new name gets a new seat and a new token.
 */
export function claimSeat(
  room: Room,
  userName: string,
  sessionToken: string | undefined,
  options: { now?: Date; maxMembers?: number; staleSeatMs?: number } = {}
): ClaimSeatResult {
  const now = options.now || new Date();
  const maxMembers = options.maxMembers ?? ROOM_LIMITS.maxMembers;
  const staleSeatMs = options.staleSeatMs ?? ROOM_LIMITS.staleSeatMs;
  const existing = findMember(room, userName);

  if (existing) {
    if (!sessionToken || !tokenMatches(existing, sessionToken)) {
      return {
        ok: false,
        code: "name_taken",
        error: `The name "${userName}" is already taken in this room. Pick another name.`,
      };
    }

    existing.lastSeenAt = now.toISOString();
    return { ok: true, member: existing, sessionToken, isNewSeat: false };
  }

  if (room.members.length >= maxMembers) {
    const reusable = room.members
      .filter(
        (member) =>
          !isConnected(room, member.name) &&
          member.name !== room.currentController &&
          now.getTime() - Date.parse(member.lastSeenAt) > staleSeatMs
      )
      .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0];

    if (!reusable) {
      return {
        ok: false,
        code: "room_full",
        error: `This room is full (${maxMembers} members).`,
      };
    }

    room.members = room.members.filter((member) => member !== reusable);
  }

  const token = createSessionToken();
  const member: RoomMember = {
    name: userName,
    tokenHash: hashSessionToken(token),
    joinedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };

  room.members.push(member);
  return { ok: true, member, sessionToken: token, isNewSeat: true };
}

export function releaseSeat(room: Room, userName: string): void {
  room.members = room.members.filter((member) => member.name !== userName);
}

export function touchSeat(room: Room, userName: string, now = new Date()): void {
  const member = findMember(room, userName);

  if (member) {
    member.lastSeenAt = now.toISOString();
  }
}

export function sanitizeMembers(value: unknown): RoomMember[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const members: RoomMember[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;

    const candidate = item as Partial<RoomMember>;

    if (
      typeof candidate.name !== "string" ||
      typeof candidate.tokenHash !== "string" ||
      seen.has(candidate.name)
    ) {
      continue;
    }

    const fallbackTime = new Date(0).toISOString();

    seen.add(candidate.name);
    members.push({
      name: candidate.name,
      tokenHash: candidate.tokenHash,
      joinedAt:
        typeof candidate.joinedAt === "string" ? candidate.joinedAt : fallbackTime,
      lastSeenAt:
        typeof candidate.lastSeenAt === "string"
          ? candidate.lastSeenAt
          : fallbackTime,
    });
  }

  return members;
}
