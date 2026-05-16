import assert from "assert/strict";
import fs from "fs";
import path from "path";
import test from "node:test";
import {
  clearPersistedAuditEvents,
  deleteRoomFromDisk,
  loadRoomFromDisk,
  saveRoomToDisk,
} from "./persistence";
import { buildRoomStateMessage } from "./roomBroadcast";
import {
  createDefaultRoom,
  createFile,
  createFolder,
  updateActiveFileContent,
} from "./roomActions";
import {
  buildRoomSnapshot,
  restoreRoomFromSnapshot,
} from "./snapshot";
import type { Room, RunRecord } from "./types";

function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    runner: "Alice",
    filePath: "src/main.py",
    language: "python",
    startedAt: "2026-05-15T00:00:00.000Z",
    finishedAt: "2026-05-15T00:00:01.000Z",
    output: "ok",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    stdinMode: "file",
    stdinContent: "from-file\n",
    ...overrides,
  };
}

function roomFilePath(roomId: string): string {
  return path.resolve(
    process.cwd(),
    "data",
    "rooms",
    `${encodeURIComponent(roomId)}.json`
  );
}

function uniqueRoomId(label: string): string {
  return `codex-${label}-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function assertNoAuditSurface(value: unknown): void {
  assert.equal(JSON.stringify(value).includes("auditEvents"), false);
}

test("empty room snapshot remains valid and audit-free", () => {
  const room = createDefaultRoom();

  const snapshot = buildRoomSnapshot("empty-room", room);

  assert.deepEqual(snapshot.files, []);
  assert.deepEqual(snapshot.folders, []);
  assert.equal(snapshot.activeFilePath, "");
  assert.equal(snapshot.consoleInput, "");
  assert.equal(snapshot.stdinMode, "console");
  assert.deepEqual(snapshot.runHistory, []);
  assert.deepEqual(snapshot.controlTimeline, []);
  assertNoAuditSurface(snapshot);
});

test("room_state message does not expose auditEvents", () => {
  const room = createDefaultRoom();
  room.auditEvents = [
    {
      id: "audit-1",
      action: "file_updated",
      createdAt: "2026-05-15T00:00:00.000Z",
      actor: "Alice",
    },
  ];

  const roomState = buildRoomStateMessage("room-state-audit", room);

  assertNoAuditSurface(roomState);
});

test("non-empty snapshot includes workspace state and control timeline only", () => {
  const room = createDefaultRoom();
  createFolder(room, "src/tests");
  createFile(room, "src/main.py");
  updateActiveFileContent(room, "print(input())\n");
  room.consoleInput = "console value\n";
  room.stdinMode = "file";
  room.runHistory = [createRunRecord()];
  room.controlTimeline = [
    {
      id: "control-1",
      type: "requested",
      createdAt: "2026-05-15T00:00:00.000Z",
      actor: "Bob",
      targetUserName: "Alice",
      previousController: "Alice",
      nextController: "Alice",
    },
  ];
  room.auditEvents = [
    {
      id: "audit-1",
      action: "file_updated",
      createdAt: "2026-05-15T00:00:00.000Z",
      actor: "Alice",
    },
  ];

  const snapshot = buildRoomSnapshot("non-empty-room", room);

  assert.deepEqual(snapshot.files, [
    { path: "src/main.py", content: "print(input())\n" },
  ]);
  assert.deepEqual(snapshot.folders, ["src", "src/tests"]);
  assert.equal(snapshot.activeFilePath, "src/main.py");
  assert.equal(snapshot.consoleInput, "console value\n");
  assert.equal(snapshot.stdinMode, "file");
  assert.equal(snapshot.runHistory[0].stdinMode, "file");
  assert.equal(snapshot.runHistory[0].stdinContent, "from-file\n");
  assert.equal(snapshot.controlTimeline[0].type, "requested");
  assertNoAuditSurface(snapshot);
});

test("snapshot restore sanitizes run history and ignores auditEvents", () => {
  const room = createDefaultRoom();

  restoreRoomFromSnapshot(room, {
    files: [{ path: "main.py", content: "print('x')\n" }],
    folders: [],
    activeFilePath: "main.py",
    consoleInput: "shared stdin\n",
    stdinMode: "console",
    runHistory: [
      {
        id: "old-run",
        runner: "Alice",
        filePath: "main.py",
        language: "python",
        startedAt: "2026-05-15T00:00:00.000Z",
        finishedAt: "2026-05-15T00:00:01.000Z",
        output: "legacy",
        stdout: "legacy\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        stdinMode: "console",
      },
    ],
    controlTimeline: [
      {
        id: "control-legacy",
        type: "assigned",
        createdAt: "2026-05-15T00:00:00.000Z",
        actor: "system",
        nextController: "Alice",
      },
    ],
    auditEvents: [{ id: "audit-legacy" }],
  });

  assert.equal(room.activeFilePath, "main.py");
  assert.equal(room.consoleInput, "shared stdin\n");
  assert.equal(room.stdinMode, "console");
  assert.equal(room.runHistory[0].stdinMode, "console");
  assert.equal(room.runHistory[0].stdinContent, "");
  assert.equal(room.controlTimeline[0].id, "control-legacy");
  assert.deepEqual(room.auditEvents, []);
});

test("persisted room saves and loads state without auditEvents", () => {
  const roomId = uniqueRoomId("persist");
  const room = createDefaultRoom();

  try {
    createFolder(room, "src/tests");
    createFile(room, "src/main.py");
    updateActiveFileContent(room, "print(input())\n");
    room.consoleInput = "console value\n";
    room.stdinMode = "file";
    room.runHistory = [createRunRecord()];
    room.controlTimeline = [
      {
        id: "control-1",
        type: "approved",
        createdAt: "2026-05-15T00:00:00.000Z",
        actor: "Alice",
        targetUserName: "Bob",
        previousController: "Alice",
        nextController: "Bob",
      },
    ];
    room.auditEvents = [
      {
        id: "audit-1",
        action: "file_updated",
        createdAt: "2026-05-15T00:00:00.000Z",
        actor: "Alice",
      },
    ];

    saveRoomToDisk(roomId, room);

    const persisted = JSON.parse(
      fs.readFileSync(roomFilePath(roomId), "utf8")
    ) as Record<string, unknown>;
    assert.deepEqual(persisted.files, room.files);
    assert.deepEqual(persisted.folders, room.folders);
    assert.equal(persisted.activeFilePath, "src/main.py");
    assert.equal(persisted.consoleInput, "console value\n");
    assert.equal(persisted.stdinMode, "file");
    assert.deepEqual(persisted.runHistory, room.runHistory);
    assert.deepEqual(persisted.controlTimeline, room.controlTimeline);
    assert.equal(
      Object.prototype.hasOwnProperty.call(persisted, "auditEvents"),
      false
    );

    const loaded = loadRoomFromDisk(roomId) as Room;
    assert.deepEqual(loaded.files, room.files);
    assert.deepEqual(loaded.folders, room.folders);
    assert.equal(loaded.activeFilePath, "src/main.py");
    assert.equal(loaded.consoleInput, "console value\n");
    assert.equal(loaded.stdinMode, "file");
    assert.equal(loaded.runHistory[0].stdinContent, "from-file\n");
    assert.deepEqual(loaded.controlTimeline, room.controlTimeline);
    assert.deepEqual(loaded.auditEvents, []);
  } finally {
    deleteRoomFromDisk(roomId);
  }
});

test("persisted auditEvents are cleaned and loaded runtime auditEvents are empty", () => {
  const roomId = uniqueRoomId("audit-cleanup");
  const filePath = roomFilePath(roomId);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          savedAt: "2026-05-15T00:00:00.000Z",
          currentController: "Alice",
          controlRequests: ["Bob"],
          files: [{ path: "main.py", content: "print('legacy')\n" }],
          folders: [],
          activeFilePath: "main.py",
          consoleInput: "legacy stdin\n",
          stdinMode: "console",
          runHistory: [
            {
              id: "legacy-run",
              runner: "Alice",
              filePath: "main.py",
              language: "python",
              startedAt: "2026-05-15T00:00:00.000Z",
              finishedAt: "2026-05-15T00:00:01.000Z",
              output: "legacy",
              stdout: "legacy\n",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              stdinMode: "console",
            },
          ],
          controlTimeline: [],
          auditEvents: [{ id: "audit-legacy" }],
        },
        null,
        2
      ),
      "utf8"
    );

    clearPersistedAuditEvents();

    const cleaned = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(
      Object.prototype.hasOwnProperty.call(cleaned, "auditEvents"),
      false
    );

    const loaded = loadRoomFromDisk(roomId) as Room;
    assert.equal(loaded.runHistory[0].stdinContent, "");
    assert.deepEqual(loaded.auditEvents, []);
  } finally {
    deleteRoomFromDisk(roomId);
  }
});
