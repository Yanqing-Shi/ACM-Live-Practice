import assert from "assert/strict";
import test from "node:test";
import {
  configureContest,
  endContest,
  resetContest,
  sanitizeContest,
  startContest,
} from "./contestActions";
import { validateControllerAction } from "./permissions";
import { createDefaultRoom } from "./roomActions";

const T0 = new Date("2026-11-01T10:00:00.000Z");

function minutesAfterStart(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

test("a new room has a five hour clock that has not started", () => {
  assert.deepEqual(createDefaultRoom().contest, {
    durationMinutes: 300,
    startedAt: null,
    endedAt: null,
  });
});

test("a contest can be any length from a minute to a month", () => {
  const room = createDefaultRoom();

  for (const minutes of [1, 20, 150, 300, 24 * 60, 3 * 24 * 60, 30 * 24 * 60]) {
    assert.equal(configureContest(room, { durationMinutes: minutes }).ok, true, String(minutes));
    assert.equal(room.contest.durationMinutes, minutes);
  }
});

test("an invalid length is rejected and the clock is left untouched", () => {
  const room = createDefaultRoom();

  configureContest(room, { durationMinutes: 90 });

  for (const durationMinutes of [0, -5, 1.5, 30 * 24 * 60 + 1, "300", null, undefined, NaN]) {
    assert.equal(
      configureContest(room, { durationMinutes }).ok,
      false,
      String(durationMinutes)
    );
    assert.equal(room.contest.durationMinutes, 90);
  }
});

test("start, end and reset follow the clock rules", () => {
  const room = createDefaultRoom();

  assert.equal(endContest(room, T0).ok, false);
  assert.equal(startContest(room, T0).ok, true);
  assert.equal(room.contest.startedAt, T0.toISOString());
  assert.equal(startContest(room, T0).ok, false);

  assert.equal(endContest(room, minutesAfterStart(90)).ok, true);
  assert.equal(room.contest.endedAt, minutesAfterStart(90).toISOString());
  assert.equal(startContest(room, minutesAfterStart(91)).ok, false);

  assert.equal(resetContest(room).ok, true);
  assert.equal(room.contest.startedAt, null);
  assert.equal(room.contest.endedAt, null);
  assert.equal(startContest(room, T0).ok, true);
});

test("the length can be changed while the contest is running and survives a reset", () => {
  const room = createDefaultRoom();

  startContest(room, T0);
  assert.equal(configureContest(room, { durationMinutes: 330 }).ok, true);
  assert.equal(room.contest.startedAt, T0.toISOString());

  resetContest(room);
  assert.equal(room.contest.durationMinutes, 330);
});

test("ending after the scheduled finish records the scheduled finish", () => {
  const room = createDefaultRoom();

  startContest(room, T0);
  endContest(room, minutesAfterStart(400));
  assert.equal(room.contest.endedAt, minutesAfterStart(300).toISOString());

  const long = createDefaultRoom();

  configureContest(long, { durationMinutes: 3 * 24 * 60 });
  startContest(long, T0);
  endContest(long, minutesAfterStart(50 * 60));
  assert.equal(long.contest.endedAt, minutesAfterStart(50 * 60).toISOString());
});

test("any member may use the clock, unlike workspace edits", () => {
  const room = createDefaultRoom();
  room.currentController = "Alice";

  for (const type of [
    "contest_configure",
    "contest_start",
    "contest_end",
    "contest_reset",
  ] as const) {
    assert.deepEqual(validateControllerAction(room, "Bob", type), { ok: true });
  }

  assert.equal(validateControllerAction(room, "Bob", "update_file").ok, false);
});

test("a clock loaded from untrusted JSON is rebuilt safely", () => {
  assert.deepEqual(sanitizeContest(undefined), {
    durationMinutes: 300,
    startedAt: null,
    endedAt: null,
  });
  assert.equal(sanitizeContest("x").durationMinutes, 300);
  assert.equal(sanitizeContest([]).durationMinutes, 300);

  assert.deepEqual(
    sanitizeContest({
      durationMinutes: -3,
      startedAt: "not a date",
      endedAt: "2026-01-01T00:00:00.000Z",
    }),
    { durationMinutes: 300, startedAt: null, endedAt: null }
  );

  // Rooms saved while there was a problem board still load; the board is dropped.
  assert.deepEqual(
    sanitizeContest({
      title: "Old contest",
      contestUrl: "https://example.com",
      durationMinutes: 4320,
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: null,
      problems: [{ label: "A", status: "solved" }],
    }),
    { durationMinutes: 4320, startedAt: "2026-11-01T10:00:00.000Z", endedAt: null }
  );
});
