import type { ContestState, Room } from "./types";
import type { ActionResult } from "./roomActions";

export const DEFAULT_DURATION_MINUTES = 300;
// A contest may be any length a team wants: a 20-minute drill, a 5-hour
// regional, a multi-day camp. The cap only keeps the number sane.
export const MAX_DURATION_MINUTES = 30 * 24 * 60;

export function createDefaultContest(): ContestState {
  return {
    durationMinutes: DEFAULT_DURATION_MINUTES,
    startedAt: null,
    endedAt: null,
  };
}

function isValidDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DURATION_MINUTES
  );
}

export function isContestRunning(contest: ContestState): boolean {
  return contest.startedAt !== null && contest.endedAt === null;
}

/** Set the contest length. Allowed at any time, including while running. */
export function configureContest(
  room: Room,
  config: { durationMinutes: unknown }
): ActionResult {
  if (!isValidDuration(config.durationMinutes)) {
    return {
      ok: false,
      error: `Contest length must be a whole number of minutes, from 1 minute to ${
        MAX_DURATION_MINUTES / (24 * 60)
      } days`,
    };
  }

  room.contest.durationMinutes = config.durationMinutes;
  return { ok: true };
}

export function startContest(room: Room, now = new Date()): ActionResult {
  const contest = room.contest;

  if (isContestRunning(contest)) {
    return { ok: false, error: "The contest is already running" };
  }

  if (contest.endedAt !== null) {
    return { ok: false, error: "The contest has ended. Reset it to start again." };
  }

  contest.startedAt = now.toISOString();
  contest.endedAt = null;
  return { ok: true };
}

export function endContest(room: Room, now = new Date()): ActionResult {
  const contest = room.contest;

  if (!isContestRunning(contest)) {
    return { ok: false, error: "The contest is not running" };
  }

  const scheduledEnd =
    Date.parse(contest.startedAt as string) + contest.durationMinutes * 60_000;

  contest.endedAt = new Date(Math.min(now.getTime(), scheduledEnd)).toISOString();
  return { ok: true };
}

/** Clears the clock so it can be started again. The length is kept. */
export function resetContest(room: Room): ActionResult {
  room.contest.startedAt = null;
  room.contest.endedAt = null;
  return { ok: true };
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Rebuild the clock from untrusted JSON (a saved room or an imported
 * snapshot). Fields from older versions, such as a problem list, are ignored.
 */
export function sanitizeContest(value: unknown): ContestState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createDefaultContest();
  }

  const raw = value as Record<string, unknown>;
  const startedAt = readTimestamp(raw.startedAt);

  return {
    durationMinutes: isValidDuration(raw.durationMinutes)
      ? raw.durationMinutes
      : DEFAULT_DURATION_MINUTES,
    startedAt,
    endedAt: startedAt ? readTimestamp(raw.endedAt) : null,
  };
}
