import assert from "node:assert/strict";
import test from "node:test";
import { formatClock, formatDuration, getContestClock, parseLengthInput } from "../contestClock";
import { allFolders, diffWorkspace, entryKind, FileClock, listDirectory } from "../roomModel";
import {
  formatRoomCode,
  inputUriString,
  parseRoomUri,
  roomKey,
  roomRootUriString,
  seatFolderName,
  workspacePathToUriString,
} from "../roomUris";
import { createSessionRegistry } from "../sessionRegistry";

const workspace = {
  files: [
    { path: "A/main.cpp", content: "a" },
    { path: "A/tests/1.in", content: "1" },
    { path: "notes.txt", content: "n" },
  ],
  folders: ["A", "B/empty"],
};

const alice = { roomId: "ZNAMR7", userName: "Alice" };

test("a seat's folder is named after the room and the member", () => {
  assert.equal(roomKey("ZNAMR7"), "znamr7");
  assert.equal(formatRoomCode("ZNAMR7"), "ZNA-MR7");
  assert.equal(formatRoomCode("room-12ab"), "room-12ab");
  assert.equal(seatFolderName(alice), "ZNA-MR7 (Alice)");
  assert.equal(roomRootUriString(alice), "icpc-room://znamr7/ZNA-MR7%20(Alice)");
  assert.equal(
    workspacePathToUriString(alice, "A/my file.cpp"),
    "icpc-room://znamr7/ZNA-MR7%20(Alice)/A/my%20file.cpp"
  );
  assert.equal(workspacePathToUriString(alice, ""), roomRootUriString(alice));
  assert.equal(inputUriString("ZNAMR7"), "icpc-room-input://znamr7/Program%20Input.txt");
});

test("two members of one room get different folders, so different windows", () => {
  const bob = { roomId: "ZNAMR7", userName: "Bob" };

  assert.notEqual(roomRootUriString(alice), roomRootUriString(bob));
  assert.equal(seatFolderName(bob), "ZNA-MR7 (Bob)");
  // A slash in a name must not turn into an extra path segment.
  assert.equal(seatFolderName({ roomId: "ZNAMR7", userName: "A/B" }).includes("/"), false);
  assert.equal(
    parseRoomUri("znamr7", `/${seatFolderName({ roomId: "ZNAMR7", userName: "A/B" })}/x.cpp`).kind,
    "entry"
  );
});

test("room URIs are split back into room, seat folder and workspace path", () => {
  assert.deepEqual(parseRoomUri("znamr7", "/ZNA-MR7 (Alice)/A/main.cpp"), {
    roomKey: "znamr7",
    kind: "entry",
    folderName: "ZNA-MR7 (Alice)",
    path: "A/main.cpp",
  });
  assert.deepEqual(parseRoomUri("ZNAMR7", "/ZNA-MR7 (Alice)"), {
    roomKey: "znamr7",
    kind: "entry",
    folderName: "ZNA-MR7 (Alice)",
    path: "",
  });
  assert.deepEqual(parseRoomUri("znamr7", "/ZNA-MR7 (Alice)/"), {
    roomKey: "znamr7",
    kind: "entry",
    folderName: "ZNA-MR7 (Alice)",
    path: "",
  });
  assert.equal(parseRoomUri("znamr7", "/").kind, "container");
  assert.equal(parseRoomUri("znamr7", "").kind, "container");
});

test("folders include explicit ones and those implied by files", () => {
  assert.deepEqual(Array.from(allFolders(workspace)).sort(), ["A", "A/tests", "B", "B/empty"]);
  assert.equal(entryKind(workspace, ""), "folder");
  assert.equal(entryKind(workspace, "A"), "folder");
  assert.equal(entryKind(workspace, "A/tests"), "folder");
  assert.equal(entryKind(workspace, "A/main.cpp"), "file");
  assert.equal(entryKind(workspace, "A/missing.cpp"), null);
  assert.equal(entryKind(workspace, "AB"), null);
});

test("a directory lists its direct children, folders first", () => {
  assert.deepEqual(listDirectory(workspace, ""), [
    { name: "A", kind: "folder" },
    { name: "B", kind: "folder" },
    { name: "notes.txt", kind: "file" },
  ]);
  assert.deepEqual(listDirectory(workspace, "A"), [
    { name: "tests", kind: "folder" },
    { name: "main.cpp", kind: "file" },
  ]);
  assert.deepEqual(listDirectory(workspace, "B"), [{ name: "empty", kind: "folder" }]);
  assert.deepEqual(listDirectory(workspace, "B/empty"), []);
});

test("differences between two states become file events", () => {
  const next = {
    files: [
      { path: "A/main.cpp", content: "changed" },
      { path: "C/new.py", content: "" },
      { path: "notes.txt", content: "n" },
    ],
    folders: ["A"],
  };
  const changes = diffWorkspace(workspace, next)
    .map((change) => `${change.type} ${change.kind} ${change.path}`)
    .sort();

  assert.deepEqual(changes, [
    "changed file A/main.cpp",
    "created file C/new.py",
    "created folder C",
    "deleted file A/tests/1.in",
    "deleted folder A/tests",
    "deleted folder B",
    "deleted folder B/empty",
  ]);
  assert.deepEqual(diffWorkspace(workspace, workspace), []);
  assert.equal(diffWorkspace(null, workspace).every((change) => change.type === "created"), true);
  assert.equal(diffWorkspace(workspace, null).every((change) => change.type === "deleted"), true);
});

test("file times move only when a file is touched, and never repeat", () => {
  let now = 1000;
  const clock = new FileClock(() => now);
  const first = { ...clock.get("a.cpp") };

  assert.deepEqual(clock.get("a.cpp"), first);

  // Two changes within the same millisecond must still look different.
  clock.touch("a.cpp");
  const second = clock.get("a.cpp").mtime;
  clock.touch("a.cpp");
  const third = clock.get("a.cpp").mtime;

  assert.equal(second > first.mtime, true);
  assert.equal(third > second, true);
  assert.equal(clock.get("a.cpp").ctime, first.ctime);

  now = 5000;
  clock.apply([
    { type: "changed", kind: "file", path: "a.cpp" },
    { type: "created", kind: "file", path: "b.cpp" },
    { type: "deleted", kind: "file", path: "gone.cpp" },
  ]);
  assert.equal(clock.get("a.cpp").mtime, 5000);
  assert.equal(clock.get("b.cpp").ctime > 5000, true);
});

test("contest clock phases and formatting", () => {
  const start = Date.parse("2026-11-01T10:00:00.000Z");
  const running = { durationMinutes: 150, startedAt: "2026-11-01T10:00:00.000Z", endedAt: null };

  assert.equal(getContestClock({ ...running, startedAt: null }, start).phase, "not_started");
  assert.equal(formatClock(getContestClock(running, start + 60_000).remainingMs), "2:29:00");
  assert.equal(getContestClock(running, start + 151 * 60_000).timeUp, true);
  assert.equal(
    getContestClock({ ...running, endedAt: "2026-11-01T11:00:00.000Z" }, start + 9e9).phase,
    "finished"
  );
  assert.equal(formatDuration(300), "5 h");
  assert.equal(formatDuration(150), "2 h 30 min");
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatClock(72 * 3600_000), "72:00:00");
});

test("a typed contest length is understood in the usual forms", () => {
  const minutes = (text: string) => {
    const parsed = parseLengthInput(text);
    return parsed.ok ? parsed.minutes : parsed.error;
  };

  assert.equal(minutes("5h"), 300);
  assert.equal(minutes("5 h"), 300);
  assert.equal(minutes("2h30m"), 150);
  assert.equal(minutes("2h 30"), 150);
  assert.equal(minutes("2h30min"), 150);
  assert.equal(minutes("90m"), 90);
  assert.equal(minutes("90 min"), 90);
  assert.equal(minutes("150"), 150);
  assert.equal(minutes("2:30"), 150);
  assert.equal(minutes("72h"), 4320);
  assert.equal(minutes("720h"), 43200);
  assert.match(String(minutes("721h")), /at most 30 days/);
  assert.match(String(minutes("0")), /at least 1 minute/);
  assert.match(String(minutes("soon")), /Use a form like/);
  assert.match(String(minutes("")), /Use a form like/);
  assert.match(String(minutes("-5")), /Use a form like/);
});

test("the session registry finds a room's identity and seat again", () => {
  const data = new Map<string, unknown>();
  const registry = createSessionRegistry({
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  });
  const identity = { serverUrl: "http://localhost:3001/", roomId: "ZNAMR7", userName: "Ada" };

  const bob = { ...identity, userName: "Bob" };

  registry.saveIdentity(identity);
  registry.saveIdentity(bob);
  registry.saveToken(identity, "secret");
  registry.saveToken(bob, "bob-secret");
  registry.setLastName("Ada");

  // A room window only knows the lower-cased room key and its folder name.
  assert.deepEqual(registry.getIdentity("znamr7", "ZNA-MR7 (Ada)"), identity);
  assert.deepEqual(registry.getIdentity("ZNAMR7", "ZNA-MR7 (Ada)"), identity);
  // Two members of the same room on one VS Code are kept apart.
  assert.deepEqual(registry.getIdentity("znamr7", "ZNA-MR7 (Bob)"), bob);
  assert.equal(registry.getIdentity("znamr7", "ZNA-MR7 (Carol)"), undefined);
  assert.equal(registry.getIdentity("other", "ZNA-MR7 (Ada)"), undefined);
  // A trailing slash or different case in the server address is the same server.
  assert.equal(registry.getToken({ ...identity, serverUrl: "HTTP://localhost:3001" }), "secret");
  assert.equal(registry.getToken(bob), "bob-secret");
  assert.equal(registry.getToken({ ...identity, userName: "Grace" }), undefined);
  assert.equal(registry.getLastName(), "Ada");

  registry.forgetToken(identity);
  registry.forgetIdentity(identity);
  assert.equal(registry.getToken(identity), undefined);
  assert.equal(registry.getIdentity("znamr7", "ZNA-MR7 (Ada)"), undefined);
  // Forgetting one seat leaves the other alone.
  assert.deepEqual(registry.getIdentity("znamr7", "ZNA-MR7 (Bob)"), bob);
});
