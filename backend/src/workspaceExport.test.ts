import assert from "assert/strict";
import test from "node:test";
import { createDefaultRoom, createFile, updateActiveFileContent } from "./roomActions";
import { buildWorkspaceZip } from "./workspaceExport";

function readStoredZipEntries(zip: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;

  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = zip.toString("utf8", nameStart, nameStart + nameLength);
    const content = zip.toString(
      "utf8",
      contentStart,
      contentStart + compressedSize
    );

    entries.set(name, content);
    offset = contentStart + compressedSize;
  }

  return entries;
}

test("workspace zip contains team files and metadata entries", () => {
  const room = createDefaultRoom();

  createFile(room, "A/main.cpp");
  updateActiveFileContent(room, "int main() { return 0; }\n");
  room.consoleInput = "1 2\n";
  room.stdinMode = "console";
  room.runHistory = [
    {
      id: "run-1",
      runner: "Alice",
      filePath: "A/main.cpp",
      language: "cpp",
      startedAt: "2026-05-15T00:00:00.000Z",
      finishedAt: "2026-05-15T00:00:01.000Z",
      output: "ok",
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      stdinMode: "console",
      stdinContent: "1 2\n",
    },
  ];
  room.controlTimeline = [
    {
      id: "control-1",
      type: "assigned",
      createdAt: "2026-05-15T00:00:00.000Z",
      actor: "system",
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

  const zip = buildWorkspaceZip("room-test", room);
  const entries = readStoredZipEntries(zip);

  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(entries.get("A/main.cpp"), "int main() { return 0; }\n");
  assert.equal(entries.has("_icpc_export/run-history.json"), true);
  assert.equal(entries.has("_icpc_export/control-timeline.json"), true);
  assert.equal(entries.has("_icpc_export/room-snapshot.json"), true);

  const runHistory = JSON.parse(
    entries.get("_icpc_export/run-history.json") || "[]"
  );
  const controlTimeline = JSON.parse(
    entries.get("_icpc_export/control-timeline.json") || "[]"
  );
  const snapshot = JSON.parse(
    entries.get("_icpc_export/room-snapshot.json") || "{}"
  );

  assert.equal(runHistory[0].stdinMode, "console");
  assert.equal(runHistory[0].stdinContent, "1 2\n");
  assert.equal(controlTimeline[0].type, "assigned");
  assert.equal(snapshot.activeFilePath, "A/main.cpp");
  assert.equal(JSON.stringify(runHistory).includes("auditEvents"), false);
  assert.equal(JSON.stringify(controlTimeline).includes("auditEvents"), false);
  assert.equal(JSON.stringify(snapshot).includes("auditEvents"), false);
});

test("workspace zip for an empty workspace contains only export metadata", () => {
  const room = createDefaultRoom();

  const zip = buildWorkspaceZip("empty-room", room);
  const entries = readStoredZipEntries(zip);

  assert.deepEqual(Array.from(entries.keys()).sort(), [
    "_icpc_export/control-timeline.json",
    "_icpc_export/room-snapshot.json",
    "_icpc_export/run-history.json",
  ]);

  const snapshot = JSON.parse(
    entries.get("_icpc_export/room-snapshot.json") || "{}"
  );
  assert.deepEqual(snapshot.files, []);
  assert.deepEqual(snapshot.folders, []);
  assert.equal(snapshot.activeFilePath, "");
});
