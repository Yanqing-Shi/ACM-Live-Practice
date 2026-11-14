import assert from "assert/strict";
import test from "node:test";
import { createDefaultRoom } from "./roomActions";
import {
  claimSeat,
  findMemberByToken,
  hashSessionToken,
  releaseSeat,
  sanitizeMembers,
} from "./session";
import type { WebSocket } from "ws";

const fakeSocket = {} as WebSocket;

test("a new name gets a seat and a token that is stored only as a hash", () => {
  const room = createDefaultRoom();
  const claim = claimSeat(room, "Alice", undefined);

  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  assert.equal(claim.isNewSeat, true);
  assert.equal(room.members.length, 1);
  assert.equal(room.members[0].tokenHash, hashSessionToken(claim.sessionToken));
  assert.equal(JSON.stringify(room.members).includes(claim.sessionToken), false);
});

test("a taken name needs the matching token", () => {
  const room = createDefaultRoom();
  const first = claimSeat(room, "Alice", undefined);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const noToken = claimSeat(room, "Alice", undefined);
  assert.equal(noToken.ok, false);
  if (!noToken.ok) assert.equal(noToken.code, "name_taken");

  const wrongToken = claimSeat(room, "Alice", "not-the-token");
  assert.equal(wrongToken.ok, false);

  const resumed = claimSeat(room, "Alice", first.sessionToken);
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.equal(resumed.isNewSeat, false);
    assert.equal(resumed.sessionToken, first.sessionToken);
  }
  assert.equal(room.members.length, 1);
});

test("one member's token cannot claim another member's name", () => {
  const room = createDefaultRoom();
  const alice = claimSeat(room, "Alice", undefined);
  const bob = claimSeat(room, "Bob", undefined);
  assert.equal(alice.ok && bob.ok, true);
  if (!alice.ok || !bob.ok) return;

  assert.equal(claimSeat(room, "Alice", bob.sessionToken).ok, false);
  assert.equal(findMemberByToken(room, bob.sessionToken)?.name, "Bob");
  assert.equal(findMemberByToken(room, "nope"), null);
  assert.equal(findMemberByToken(room, undefined), null);
});

test("a full room rejects new names until a seat is released", () => {
  const room = createDefaultRoom();

  assert.equal(claimSeat(room, "A", undefined, { maxMembers: 2 }).ok, true);
  assert.equal(claimSeat(room, "B", undefined, { maxMembers: 2 }).ok, true);

  const full = claimSeat(room, "C", undefined, { maxMembers: 2 });
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.code, "room_full");

  releaseSeat(room, "A");
  assert.equal(claimSeat(room, "C", undefined, { maxMembers: 2 }).ok, true);
});

test("a full room reuses a stale offline seat but never a connected one", () => {
  const room = createDefaultRoom();
  const start = new Date("2026-01-01T00:00:00.000Z");
  const later = new Date("2026-01-03T00:00:00.000Z");

  claimSeat(room, "Old", undefined, { now: start, maxMembers: 2 });
  claimSeat(room, "Online", undefined, { now: start, maxMembers: 2 });
  room.clients.push({ socket: fakeSocket, userName: "Online" });

  const claim = claimSeat(room, "New", undefined, { now: later, maxMembers: 2 });

  assert.equal(claim.ok, true);
  assert.deepEqual(
    room.members.map((member) => member.name).sort(),
    ["New", "Online"]
  );
});

test("members loaded from disk drop malformed and duplicate entries", () => {
  const members = sanitizeMembers([
    { name: "Alice", tokenHash: "h1", joinedAt: "t", lastSeenAt: "t" },
    { name: "Alice", tokenHash: "h2" },
    { name: 5, tokenHash: "h3" },
    { name: "Bob" },
    null,
  ]);

  assert.equal(members.length, 1);
  assert.equal(members[0].tokenHash, "h1");
  assert.deepEqual(sanitizeMembers("nope"), []);
});
