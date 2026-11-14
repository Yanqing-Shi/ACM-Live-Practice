import type { ContestState } from "../protocol";

/** Matches the server: any length from one minute up to thirty days. */
export const MAX_DURATION_MINUTES = 30 * 24 * 60;

/**
 * Total minutes for what was typed into the hours and minutes boxes, or an
 * error message. Either box may be left empty; minutes may exceed 59.
 */
export function parseDuration(
  hours: string,
  minutes: string
): { ok: true; minutes: number } | { ok: false; error: string } {
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);

  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) {
    return { ok: false, error: "Use whole numbers for hours and minutes" };
  }

  const total = h * 60 + m;

  if (total < 1) {
    return { ok: false, error: "The contest must last at least 1 minute" };
  }

  if (total > MAX_DURATION_MINUTES) {
    return { ok: false, error: "The contest can last at most 30 days" };
  }

  return { ok: true, minutes: total };
}

export type ContestPhase = "not_started" | "running" | "finished";

export type ContestClock = {
  phase: ContestPhase;
  /** Milliseconds since the start, clamped to the contest length. */
  elapsedMs: number;
  remainingMs: number;
  /** True when the scheduled time ran out without anyone pressing End. */
  timeUp: boolean;
};

/** `now` is server time: local time corrected by the offset from room updates. */
export function getContestClock(contest: ContestState, now: number): ContestClock {
  const totalMs = contest.durationMinutes * 60_000;

  if (!contest.startedAt) {
    return { phase: "not_started", elapsedMs: 0, remainingMs: totalMs, timeUp: false };
  }

  const startMs = Date.parse(contest.startedAt);
  const stopMs = contest.endedAt ? Date.parse(contest.endedAt) : now;
  const elapsedMs = Math.max(0, Math.min(totalMs, stopMs - startMs));
  const timeUp = elapsedMs >= totalMs;

  return {
    phase: contest.endedAt || timeUp ? "finished" : "running",
    elapsedMs,
    remainingMs: totalMs - elapsedMs,
    timeUp,
  };
}

/** 4:59:07 style, always with hours. Long contests simply show more hours. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}
