import assert from "assert/strict";
import test from "node:test";
import { createDefaultRoom, createFile, updateActiveFileContent } from "./roomActions";
import { buildWorkspaceZip } from "./workspaceExport";

test("workspace zip contains room files and metadata entries", () => {
  const room = createDefaultRoom();

  createFile(room, "A/main.cpp");
  updateActiveFileContent(room, "int main() { return 0; }\n");

  const zip = buildWorkspaceZip("room-test", room);
  const content = zip.toString("latin1");

  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.match(content, /A\/main\.cpp/);
  assert.match(content, /_icpc_export\/run-history\.json/);
  assert.match(content, /_icpc_export\/control-timeline\.json/);
  assert.match(content, /_icpc_export\/room-snapshot\.json/);
});
