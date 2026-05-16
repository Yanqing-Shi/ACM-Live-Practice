const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildFileTree,
  getEmptyWorkspaceMessage,
  getWorkspaceTreeEntries,
  shouldShowItemActions,
} = require("../workspaceTree");

test("empty workspace builds an empty tree without creating main.cpp", () => {
  assert.deepEqual(buildFileTree([], []), {});
  assert.deepEqual(getWorkspaceTreeEntries([], []), []);
  assert.equal(getEmptyWorkspaceMessage(), "No files yet.");
});

test("workspace tree nests files under explicit and implicit folders", () => {
  const tree = buildFileTree(
    ["A/tests"],
    [
      { path: "A/main.cpp", content: "" },
      { path: "notes.txt", content: "" },
    ]
  );

  assert.equal(tree.A.__type, "folder");
  assert.equal(tree.A.children["main.cpp"].__type, "file");
  assert.equal(tree.A.children.tests.__type, "folder");
  assert.equal(tree["notes.txt"].path, "notes.txt");
});

test("workspace tree entries sort folders before files by name", () => {
  const entries = getWorkspaceTreeEntries(
    ["B", "A"],
    [
      { path: "z.txt", content: "" },
      { path: "a.txt", content: "" },
    ]
  );

  assert.deepEqual(
    entries.map(([name]) => name),
    ["A", "B", "a.txt", "z.txt"]
  );
});

test("tree mutation actions only show for selected controller items", () => {
  assert.equal(shouldShowItemActions(true, true), true);
  assert.equal(shouldShowItemActions(true, false), false);
  assert.equal(shouldShowItemActions(false, true), false);
});
