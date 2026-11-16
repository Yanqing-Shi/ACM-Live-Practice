import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test, { after } from "node:test";
import {
  getRoomsDataDir,
  loadRoomFromDisk,
  purgeIdleRooms,
  saveRoomToDisk,
} from "./persistence";
import { createDefaultRoom, createFile } from "./roomActions";
import { claimSeat } from "./session";
import { configureContest, startContest } from "./contestActions";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-persistence-test-"));
process.env.ICPC_DATA_DIR = dataDir;

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

test("ICPC_DATA_DIR moves the rooms directory", () => {
  assert.equal(getRoomsDataDir(), path.join(dataDir, "rooms"));
});

test("seats and contest state survive a save and load", () => {
  const room = createDefaultRoom();
  const claim = claimSeat(room, "Alice", undefined);

  createFile(room, "A/main.cpp", "int main(){}\n");
  configureContest(room, { durationMinutes: 4320 });
  startContest(room, new Date("2026-11-01T10:00:00.000Z"));
  room.currentController = "Alice";
  saveRoomToDisk("PERSIST", room);

  const loaded = loadRoomFromDisk("PERSIST");

  assert.ok(loaded);
  assert.equal(loaded.members.length, 1);
  assert.equal(loaded.members[0].name, "Alice");
  assert.deepEqual(loaded.contest, {
    durationMinutes: 4320,
    startedAt: "2026-11-01T10:00:00.000Z",
    endedAt: null,
  });
  assert.equal(loaded.files[0].content, "int main(){}\n");
  // Control is never restored: the first member back becomes controller.
  assert.equal(loaded.currentController, null);

  if (claim.ok) {
    assert.equal(claimSeat(loaded, "Alice", claim.sessionToken).ok, true);
  }
});

test("saving leaves no temporary files behind", () => {
  saveRoomToDisk("ATOMIC", createDefaultRoom());
  saveRoomToDisk("ATOMIC", createDefaultRoom());

  const leftovers = fs
    .readdirSync(getRoomsDataDir())
    .filter((name) => name.endsWith(".tmp"));

  assert.deepEqual(leftovers, []);
});

test("a corrupt or legacy room file does not throw", () => {
  const dir = getRoomsDataDir();

  fs.writeFileSync(path.join(dir, "BROKEN.json"), "{ not json", "utf8");
  fs.writeFileSync(path.join(dir, "ARRAY.json"), "[]", "utf8");
  fs.writeFileSync(
    path.join(dir, "LEGACY.json"),
    JSON.stringify({ files: [{ path: "a.py", content: "x" }, { path: 5 }], folders: ["a", 1] }),
    "utf8"
  );

  const original = console.error;
  console.error = () => {};

  try {
    assert.equal(loadRoomFromDisk("BROKEN"), null);
  } finally {
    console.error = original;
  }

  assert.equal(loadRoomFromDisk("ARRAY"), null);
  assert.equal(loadRoomFromDisk("MISSING"), null);

  const legacy = loadRoomFromDisk("LEGACY");

  assert.ok(legacy);
  assert.deepEqual(legacy.files, [{ path: "a.py", content: "x" }]);
  assert.deepEqual(legacy.folders, ["a"]);
  assert.deepEqual(legacy.members, []);
  assert.equal(legacy.contest.durationMinutes, 300);
});

test("idle rooms are purged, recent and online rooms are kept", () => {
  const dir = getRoomsDataDir();
  const old = new Date(Date.now() - 40 * DAY_MS);

  for (const roomId of ["OLDONE", "OLDTWO", "FRESH1"]) {
    saveRoomToDisk(roomId, createDefaultRoom());
  }

  fs.utimesSync(path.join(dir, "OLDONE.json"), old, old);
  fs.utimesSync(path.join(dir, "OLDTWO.json"), old, old);

  const removed = purgeIdleRooms(30 * DAY_MS, ["OLDTWO"]);

  assert.deepEqual(removed, ["OLDONE"]);
  assert.equal(fs.existsSync(path.join(dir, "OLDONE.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "OLDTWO.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "FRESH1.json")), true);
});
