import type { ContestState } from "./protocol";

export const MAX_DURATION_MINUTES = 30 * 24 * 60;

export type ContestPhase = "not_started" | "running" | "finished";

export type ContestClock = {
  phase: ContestPhase;
  elapsedMs: number;
  remainingMs: number;
  /** True when the scheduled time ran out without anyone ending the contest. */
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

/**
 * Read a contest length typed into an input box. Accepted forms:
 * "5h", "2h30m", "2h 30", "90m", "2:30" (hours:minutes), "150" (minutes).
 */
export function parseLengthInput(
  input: string
): { ok: true; minutes: number } | { ok: false; error: string } {
  const text = input.trim().toLowerCase();
  let minutes: number | null = null;
  let match: RegExpExecArray | null;

  if ((match = /^(\d+)\s*:\s*(\d{1,2})$/.exec(text))) {
    minutes = Number(match[1]) * 60 + Number(match[2]);
  } else if ((match = /^(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*(?:m(?:in(?:utes?)?)?)?)?$/.exec(text))) {
    minutes = Number(match[1]) * 60 + Number(match[2] || 0);
  } else if ((match = /^(\d+)\s*(?:m(?:in(?:utes?)?)?)?$/.exec(text))) {
    minutes = Number(match[1]);
  }

  if (minutes === null) {
    return { ok: false, error: 'Use a form like "5h", "2h30m", "2:30" or "150" (minutes).' };
  }

  if (minutes < 1) {
    return { ok: false, error: "The contest must last at least 1 minute." };
  }

  if (minutes > MAX_DURATION_MINUTES) {
    return { ok: false, error: "The contest can last at most 30 days." };
  }

  return { ok: true, minutes };
}
