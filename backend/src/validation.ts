import { randomInt } from "crypto";
import { ROOM_LIMITS } from "./limits";
import type { ClientMessage } from "./protocol";

export function isValidRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9_-]{3,64}$/.test(roomId);
}

export function isValidUserName(userName: string): boolean {
  return (
    userName.length >= 1 &&
    userName.length <= 32 &&
    userName === userName.trim() &&
    !/[\x00-\x1F\x7F]/.test(userName)
  );
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Team codes avoid characters that are easy to confuse when read aloud or
// typed from a screenshot: no 0/O, 1/I/L.
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  let code = "";

  for (let index = 0; index < ROOM_CODE_LENGTH; index++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }

  return code;
}

/**
 * Turn what a person typed ("abc-def", " ABC DEF ") into the stored code form
 * ("ABCDEF"). Returns null when the input cannot be a generated team code.
 */
export function normalizeRoomCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, "").toUpperCase();

  if (compact.length !== ROOM_CODE_LENGTH) {
    return null;
  }

  for (const char of compact) {
    if (!ROOM_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }

  return compact;
}

/**
 * Ids to try, in order, for something a person typed: the exact text first
 * (rooms created before team codes existed), then the normalized team code.
 */
export function roomIdCandidates(input: string): string[] {
  const trimmed = input.trim();
  const candidates: string[] = [];

  if (isValidRoomId(trimmed)) {
    candidates.push(trimmed);
  }

  const code = normalizeRoomCode(trimmed);

  if (code && !candidates.includes(code)) {
    candidates.push(code);
  }

  return candidates;
}

export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

function invalid(error: string): ParsedClientMessage {
  return { ok: false, error };
}

function isString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || isString(value, maxLength);
}

function isOptionalSeq(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isStdinMode(value: unknown): value is "console" | "file" {
  return value === "console" || value === "file";
}

function isItemType(value: unknown): value is "file" | "folder" {
  return value === "file" || value === "folder";
}

/**
 * Check the shape of a decoded WebSocket message. Field contents (paths,
 * names, contest values) are validated again by the action that uses them;
 * this only guarantees the types the handlers rely on.
 */
export function parseClientMessage(value: unknown): ParsedClientMessage {
  if (!isObject(value) || typeof value.type !== "string") {
    return invalid("Message must be an object with a type");
  }

  const limits = ROOM_LIMITS;
  const path = limits.maxPathLength + 16;

  switch (value.type) {
    case "join_room":
      if (!isString(value.roomId, 128) || !isString(value.userName, 128)) {
        return invalid("join_room requires roomId and userName");
      }
      if (!isOptionalString(value.sessionToken, 256)) {
        return invalid("Invalid sessionToken");
      }
      break;

    case "leave_room":
    case "request_control":
    case "contest_start":
    case "contest_end":
    case "contest_reset":
      break;

    case "approve_control":
    case "reject_control":
      if (!isString(value.targetUserName, 128)) {
        return invalid(`${value.type} requires targetUserName`);
      }
      break;

    case "update_file":
      if (!isOptionalString(value.path, path)) {
        return invalid("Invalid file path");
      }
      if (typeof value.content !== "string") {
        return invalid("update_file requires content");
      }
      if (!isOptionalSeq(value.seq)) {
        return invalid("Invalid seq");
      }
      break;

    case "switch_file":
    case "create_folder":
      if (!isString(value.path, path)) {
        return invalid(`${value.type} requires path`);
      }
      break;

    case "create_file":
      if (!isString(value.path, path)) {
        return invalid("create_file requires path");
      }
      if (value.content !== undefined && typeof value.content !== "string") {
        return invalid("Invalid file content");
      }
      break;

    case "rename_item":
      if (
        !isItemType(value.itemType) ||
        !isString(value.oldPath, path) ||
        !isString(value.newPath, path)
      ) {
        return invalid("rename_item requires itemType, oldPath and newPath");
      }
      break;

    case "delete_item":
      if (!isItemType(value.itemType) || !isString(value.path, path)) {
        return invalid("delete_item requires itemType and path");
      }
      break;

    case "run_code":
      if (value.stdinMode !== undefined && !isStdinMode(value.stdinMode)) {
        return invalid("Invalid stdinMode");
      }
      if (
        value.consoleInput !== undefined &&
        !isString(value.consoleInput, limits.maxConsoleInputSize)
      ) {
        return invalid("Console input is too large");
      }
      if (!isOptionalString(value.activeFilePath, path)) {
        return invalid("Invalid activeFilePath");
      }
      if (
        value.activeFileContent !== undefined &&
        typeof value.activeFileContent !== "string"
      ) {
        return invalid("Invalid activeFileContent");
      }
      break;

    case "update_console_input":
      if (!isString(value.consoleInput, limits.maxConsoleInputSize)) {
        return invalid("Console input is too large");
      }
      if (!isOptionalSeq(value.seq)) {
        return invalid("Invalid seq");
      }
      break;

    case "update_stdin_mode":
      if (!isStdinMode(value.stdinMode)) {
        return invalid("Invalid stdinMode");
      }
      break;

    case "contest_configure":
      if (typeof value.durationMinutes !== "number") {
        return invalid("contest_configure requires durationMinutes");
      }
      break;

    default:
      return invalid("Unknown message type");
  }

  return { ok: true, message: value as unknown as ClientMessage };
}
