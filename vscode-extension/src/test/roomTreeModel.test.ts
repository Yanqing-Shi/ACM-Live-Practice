import assert from "node:assert/strict";
import test from "node:test";
import type { RoomStateMessage } from "../protocol";
import {
  buildRoomTreeChildren,
  describeRoomTreeItem,
  RoomTreeNode,
} from "../roomTreeModel";

function makeState(
  files: RoomStateMessage["files"],
  folders: string[]
): RoomStateMessage {
  return {
    type: "room_state",
    roomId: "room-1",
    members: [],
    currentController: null,
    controlRequests: [],
    files,
    folders,
    activeFilePath: files[0]?.path || "",
    consoleInput: "",
    stdinMode: "console",
    runHistory: [],
    controlTimeline: [],
  };
}

test("room tree returns empty workspace placeholder", () => {
  assert.deepEqual(buildRoomTreeChildren(makeState([], [])), [
    {
      name: "Workspace is empty",
      path: "",
      type: "empty",
    },
  ]);
});

test("room tree groups nested files and sorts folders before files", () => {
  const children = buildRoomTreeChildren(
    makeState(
      [
        { path: "notes.txt", content: "" },
        { path: "A/main.cpp", content: "" },
        { path: "B/solver.py", content: "" },
      ],
      ["B"]
    )
  );

  assert.deepEqual(children, [
    { name: "A", path: "A", type: "folder" },
    { name: "B", path: "B", type: "folder" },
    { name: "notes.txt", path: "notes.txt", type: "file" },
  ]);
});

test("room tree item descriptors include file command and resource URI", () => {
  const node: RoomTreeNode = {
    name: "main.cpp",
    path: "A/main.cpp",
    type: "file",
  };

  assert.deepEqual(describeRoomTreeItem(node, "room-1"), {
    label: "main.cpp",
    collapsible: "none",
    contextValue: "file",
    resourceUri: "icpc-room://room-1/A/main.cpp",
    command: {
      command: "icpcLive.openRoomFile",
      title: "Open Room File",
      arguments: ["A/main.cpp"],
    },
  });
});
