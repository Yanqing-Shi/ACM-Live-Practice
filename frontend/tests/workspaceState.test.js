const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getEditorPermissionState,
} = require("../controlView");
const {
  getActionAvailabilityState,
} = require("../roomController");
const {
  getEditorDisplayState,
} = require("../wsClient");

test("empty workspace has read-only editor copy without requiring main.cpp", () => {
  const display = getEditorDisplayState([], "", "");
  const permission = getEditorPermissionState({
    currentController: "Alice",
    currentUserName: "Alice",
    activeFilePath: "",
    displayedFilePath: display.path,
  });

  assert.equal(display.hasFile, false);
  assert.equal(display.path, "");
  assert.match(display.content, /No file selected/);
  assert.equal(permission.canEdit, false);
  assert.equal(permission.statusText, "Editing status: no file selected");
});

test("run code is disabled when the controller has no active file", () => {
  const availability = getActionAvailabilityState({
    joined: true,
    currentControllerName: "Alice",
    currentUserName: "Alice",
    activeFilePath: "",
  });

  assert.equal(availability.canControl, true);
  assert.equal(availability.hasActiveFile, false);
  assert.equal(availability.runCodeDisabled, true);
  assert.equal(availability.createFileDisabled, false);
  assert.equal(availability.createFolderDisabled, false);
});

test("observer controls are read-only while file viewing remains possible", () => {
  const files = [{ path: "A/main.cpp", content: "int main() {}" }];
  const display = getEditorDisplayState(files, "A/main.cpp", "");
  const availability = getActionAvailabilityState({
    joined: true,
    currentControllerName: "Alice",
    currentUserName: "Bob",
    activeFilePath: "A/main.cpp",
  });
  const permission = getEditorPermissionState({
    currentController: "Alice",
    currentUserName: "Bob",
    activeFilePath: "A/main.cpp",
    displayedFilePath: display.path,
  });

  assert.equal(display.content, "int main() {}");
  assert.equal(availability.runCodeDisabled, true);
  assert.equal(availability.createFileDisabled, true);
  assert.equal(availability.consoleInputDisabled, true);
  assert.equal(availability.stdinModeDisabled, true);
  assert.equal(permission.canEdit, false);
  assert.equal(permission.statusText, "Editing status: read-only");
});

test("observer can display a locally selected file without changing active file", () => {
  const files = [
    { path: "A/main.cpp", content: "active" },
    { path: "B/main.cpp", content: "local" },
  ];

  const display = getEditorDisplayState(files, "A/main.cpp", "B/main.cpp");

  assert.equal(display.path, "B/main.cpp");
  assert.equal(display.content, "local");
});
