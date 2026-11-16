import { describe, expect, test } from "vitest";
import type { ContestState, RoomStateMessage } from "../protocol";
import {
  applyLocalFileEdit,
  applyServerMessage,
  initialRoomClientState,
  type LocalEditContext,
} from "../state/roomReducer";
import { formatClock, formatDuration, getContestClock, parseDuration } from "./contest";
import { editorLanguageForPath, isRunnablePath } from "./language";
import {
  getActionAvailabilityState,
  getEditorDisplayState,
  getEditorPermissionState,
} from "./permissions";
import { createSessionStore } from "./sessionStore";
import { applyTextEdit, minimalEdit } from "./textDiff";
import {
  cleanRoomInput,
  formatRoomCode,
  isJoinableRoomInput,
  isValidRoomId,
  isValidUserName,
  normalizeRoomCode,
  readRoomFromLocation,
  roomPath,
} from "./validation";
import {
  baseName,
  buildFileTree,
  creationParent,
  getEmptyWorkspaceMessage,
  parentFolders,
  parentOf,
  resolveNewEntry,
  shouldShowItemActions,
} from "./workspaceTree";

// --- ported from frontend/tests/validation.test.js ----------------------------

describe("validation", () => {
  test("room id allows expected shareable ids", () => {
    expect(isValidRoomId("abc")).toBe(true);
    expect(isValidRoomId("room-123_ABC")).toBe(true);
  });

  test("room id rejects empty, short, long, and unsafe ids", () => {
    expect(isValidRoomId("")).toBe(false);
    expect(isValidRoomId("ab")).toBe(false);
    expect(isValidRoomId("a".repeat(65))).toBe(false);
    expect(isValidRoomId("room/abc")).toBe(false);
    expect(isValidRoomId("room abc")).toBe(false);
  });

  test("user name allows concise visible names", () => {
    expect(isValidUserName("Alice")).toBe(true);
    expect(isValidUserName("Team 1")).toBe(true);
  });

  test("user name rejects empty, long, and control-character names", () => {
    expect(isValidUserName("")).toBe(false);
    expect(isValidUserName("a".repeat(33))).toBe(false);
    expect(isValidUserName("Alice\nBob")).toBe(false);
  });

  test("team codes are normalized, formatted and read from the URL", () => {
    expect(normalizeRoomCode("abc-def")).toBe("ABCDEF");
    expect(normalizeRoomCode("abc def ")).toBe("ABCDEF");
    expect(normalizeRoomCode("ABCDE0")).toBe(null);
    expect(cleanRoomInput(" abc-def ")).toBe("ABCDEF");
    expect(cleanRoomInput(" room-12ab34cd ")).toBe("room-12ab34cd");
    expect(isJoinableRoomInput("abc def")).toBe(true);
    expect(isJoinableRoomInput("a b")).toBe(false);
    expect(formatRoomCode("ABCDEF")).toBe("ABC-DEF");
    expect(formatRoomCode("room-12ab34cd")).toBe("room-12ab34cd");
    expect(roomPath("ABCDEF")).toBe("/r/ABCDEF");
    expect(readRoomFromLocation({ pathname: "/r/ABCDEF", search: "" })).toBe("ABCDEF");
    expect(readRoomFromLocation({ pathname: "/room/old-id/", search: "" })).toBe("old-id");
    expect(readRoomFromLocation({ pathname: "/", search: "?room=abc" })).toBe("abc");
    expect(readRoomFromLocation({ pathname: "/", search: "" })).toBe("");
  });
});

// --- ported from frontend/tests/workspaceTree.test.js -------------------------

describe("workspace tree", () => {
  test("empty workspace builds an empty tree without creating main.cpp", () => {
    expect(buildFileTree([], [])).toEqual([]);
    expect(getEmptyWorkspaceMessage()).toBe("No files yet.");
  });

  test("workspace tree nests files under explicit and implicit folders", () => {
    const tree = buildFileTree(
      ["A/tests"],
      [{ path: "A/main.cpp" }, { path: "notes.txt" }]
    );
    const folderA = tree[0];

    expect(folderA).toMatchObject({ type: "folder", name: "A", path: "A" });
    if (folderA.type !== "folder") throw new Error("expected folder");
    expect(folderA.children).toEqual([
      { type: "folder", name: "tests", path: "A/tests", children: [] },
      { type: "file", name: "main.cpp", path: "A/main.cpp" },
    ]);
    expect(tree[1]).toEqual({ type: "file", name: "notes.txt", path: "notes.txt" });
  });

  test("workspace tree entries sort folders before files by name", () => {
    const tree = buildFileTree(["B", "A"], [{ path: "z.txt" }, { path: "a.txt" }]);

    expect(tree.map((node) => node.name)).toEqual(["A", "B", "a.txt", "z.txt"]);
  });

  test("tree mutation actions only show for selected controller items", () => {
    expect(shouldShowItemActions(true, true)).toBe(true);
    expect(shouldShowItemActions(true, false)).toBe(false);
    expect(shouldShowItemActions(false, true)).toBe(false);
  });

  test("parent folders are listed outermost first", () => {
    expect(parentFolders("A/tests/1.in")).toEqual(["A", "A/tests"]);
    expect(parentFolders("main.cpp")).toEqual([]);
    expect(parentOf("A/tests/1.in")).toBe("A/tests");
    expect(parentOf("main.cpp")).toBe("");
    expect(baseName("A/tests/1.in")).toBe("1.in");
    expect(baseName("main.cpp")).toBe("main.cpp");
  });

  test("a new entry goes into the selected folder, or beside the selected file", () => {
    expect(creationParent(null)).toBe("");
    expect(creationParent({ type: "folder", path: "A/tests" })).toBe("A/tests");
    expect(creationParent({ type: "file", path: "A/main.cpp" })).toBe("A");
    expect(creationParent({ type: "file", path: "notes.txt" })).toBe("");
  });

  test("a typed name becomes a path inside its parent folder", () => {
    const existing = new Set(["A", "A/main.cpp", "notes.txt"]);

    expect(resolveNewEntry("b.cpp", "", existing)).toEqual({ ok: true, path: "b.cpp" });
    expect(resolveNewEntry("  b.cpp ", "A", existing)).toEqual({ ok: true, path: "A/b.cpp" });
    // A name may create folders on the way, as in an editor.
    expect(resolveNewEntry("tests/1.in", "A", existing)).toEqual({
      ok: true,
      path: "A/tests/1.in",
    });
  });

  test("names that cannot be used are explained", () => {
    const existing = new Set(["A", "A/main.cpp", "notes.txt"]);
    const error = (name: string, parent = "") => {
      const resolved = resolveNewEntry(name, parent, existing);
      return resolved.ok ? null : resolved.error;
    };

    expect(error("")).toMatch(/required/);
    expect(error("   ")).toMatch(/required/);
    expect(error("notes.txt")).toMatch(/already exists/);
    expect(error("main.cpp", "A")).toMatch(/already exists/);
    expect(error("A")).toMatch(/already exists/);
    expect(error("a\\b")).toMatch(/Use \//);
    expect(error("/abs")).toMatch(/start or end/);
    expect(error("dir/")).toMatch(/start or end/);
    expect(error("../up")).toMatch(/two dots/);
    expect(error("a//b")).toMatch(/not a valid name/);
    expect(error("./a")).toMatch(/not a valid name/);
    expect(error("x".repeat(201))).toMatch(/too long/);
    expect(error("main.cpp")).toBe(null);
  });

  test("renaming to the same name is not a clash, to another entry is", () => {
    const existing = new Set(["A/main.cpp", "A/other.cpp"]);

    expect(resolveNewEntry("main.cpp", "A", existing, "A/main.cpp")).toEqual({
      ok: true,
      path: "A/main.cpp",
    });
    expect(resolveNewEntry("other.cpp", "A", existing, "A/main.cpp").ok).toBe(false);
    expect(resolveNewEntry("solution.cpp", "A", existing, "A/main.cpp")).toEqual({
      ok: true,
      path: "A/solution.cpp",
    });
  });
});

// --- ported from frontend/tests/workspaceState.test.js ------------------------

describe("permissions and editor display", () => {
  test("empty workspace has read-only editor copy without requiring main.cpp", () => {
    const display = getEditorDisplayState([], "", "");
    const permission = getEditorPermissionState({
      currentController: "Alice",
      currentUserName: "Alice",
      activeFilePath: "",
      displayedFilePath: display.path,
    });

    expect(display.hasFile).toBe(false);
    expect(display.path).toBe("");
    expect(display.content).toMatch(/No file selected/);
    expect(permission.canEdit).toBe(false);
    expect(permission.statusText).toBe("Editing status: no file selected");
  });

  test("run code is disabled when the controller has no active file", () => {
    const availability = getActionAvailabilityState({
      joined: true,
      currentControllerName: "Alice",
      currentUserName: "Alice",
      activeFilePath: "",
    });

    expect(availability.canControl).toBe(true);
    expect(availability.hasActiveFile).toBe(false);
    expect(availability.runCodeDisabled).toBe(true);
    expect(availability.createFileDisabled).toBe(false);
    expect(availability.createFolderDisabled).toBe(false);
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

    expect(display.content).toBe("int main() {}");
    expect(availability.runCodeDisabled).toBe(true);
    expect(availability.createFileDisabled).toBe(true);
    expect(availability.consoleInputDisabled).toBe(true);
    expect(availability.stdinModeDisabled).toBe(true);
    expect(permission.canEdit).toBe(false);
    expect(permission.statusText).toBe("Editing status: read-only");
  });

  test("observer can display a locally selected file without changing active file", () => {
    const files = [
      { path: "A/main.cpp", content: "active" },
      { path: "B/main.cpp", content: "local" },
    ];
    const display = getEditorDisplayState(files, "A/main.cpp", "B/main.cpp");

    expect(display.path).toBe("B/main.cpp");
    expect(display.content).toBe("local");
  });

  test("a deleted local file falls back to the active file", () => {
    const files = [{ path: "A/main.cpp", content: "active" }];

    expect(getEditorDisplayState(files, "A/main.cpp", "gone.cpp").path).toBe("A/main.cpp");
  });

  test("the run button is disabled while a run is in progress", () => {
    const availability = getActionAvailabilityState({
      joined: true,
      currentControllerName: "Alice",
      currentUserName: "Alice",
      activeFilePath: "a.cpp",
      running: true,
    });

    expect(availability.runCodeDisabled).toBe(true);
  });
});

// --- new client logic ---------------------------------------------------------

describe("minimal text edits", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["abc", "abc"],
    ["", "abc"],
    ["abc", ""],
    ["hello world", "hello brave world"],
    ["hello brave world", "hello world"],
    ["aaaa", "aaa"],
    ["aaa", "aaaa"],
    ["int main(){}", "int main(){ return 0; }"],
    ["line1\nline2\nline3", "line1\nLINE2\nline3"],
    ["a😀b", "a😁b"],
    ["😀", "😀😀"],
  ];

  test.each(cases)("%j -> %j round-trips", (before, after) => {
    expect(applyTextEdit(before, minimalEdit(before, after))).toBe(after);
  });

  test("only the changed span is replaced", () => {
    expect(minimalEdit("hello world", "hello brave world")).toEqual({
      start: 6,
      end: 6,
      text: "brave ",
    });
    expect(minimalEdit("same", "same")).toBe(null);
  });

  test("surrogate pairs are never split", () => {
    const edit = minimalEdit("a😀b", "a😁b");

    expect(edit).toEqual({ start: 1, end: 3, text: "😁" });
  });
});

function roomState(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return {
    type: "room_state",
    roomId: "ABCDEF",
    members: ["Alice", "Bob"],
    memberStates: [
      { name: "Alice", connected: true },
      { name: "Bob", connected: true },
    ],
    currentController: "Alice",
    controlRequests: [],
    files: [{ path: "main.cpp", content: "v1" }],
    folders: [],
    activeFilePath: "main.cpp",
    consoleInput: "",
    stdinMode: "console",
    runHistory: [],
    controlTimeline: [],
    contest: contest(),
    running: false,
    serverTime: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function contest(overrides: Partial<ContestState> = {}): ContestState {
  return {
    durationMinutes: 300,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function editContext(overrides: Partial<LocalEditContext> = {}): LocalEditContext {
  return {
    userName: "Alice",
    unackedPaths: new Set(),
    consoleUnacked: false,
    ...overrides,
  };
}

describe("room state reducer", () => {
  const joined = applyServerMessage(initialRoomClientState, roomState(), 0, editContext());

  test("the server clock offset is taken from room updates", () => {
    const at = Date.parse("2026-11-01T09:59:58.000Z");
    const state = applyServerMessage(initialRoomClientState, roomState(), at, editContext());

    expect(state.serverTimeOffsetMs).toBe(2000);
  });

  test("the typing controller keeps text the server has not acknowledged", () => {
    const typed = applyLocalFileEdit(joined, "main.cpp", "v1 plus more typing");
    const next = applyServerMessage(
      typed,
      roomState({ files: [{ path: "main.cpp", content: "v1 plus" }], controlRequests: ["Bob"] }),
      0,
      editContext({ unackedPaths: new Set(["main.cpp"]) })
    );

    expect(next.room?.files[0].content).toBe("v1 plus more typing");
    expect(next.room?.controlRequests).toEqual(["Bob"]);
    expect(next.remoteRevs["main.cpp"]).toBe(joined.remoteRevs["main.cpp"]);
  });

  test("a state from before the first keystroke does not wipe what was typed", () => {
    // The file was just created empty; the controller has typed, and an
    // update generated before the server saw any of it arrives late.
    const created = applyServerMessage(
      initialRoomClientState,
      roomState({ files: [{ path: "main.cpp", content: "" }] }),
      0,
      editContext()
    );
    const typed = applyLocalFileEdit(created, "main.cpp", "line 0 abc");
    const next = applyServerMessage(
      typed,
      roomState({ files: [{ path: "main.cpp", content: "" }] }),
      0,
      editContext({ unackedPaths: new Set(["main.cpp"]) })
    );

    expect(next.room?.files[0].content).toBe("line 0 abc");
  });

  test("once every edit is acknowledged the server's text is authoritative", () => {
    const typed = applyLocalFileEdit(joined, "main.cpp", "local");
    const next = applyServerMessage(
      typed,
      roomState({ files: [{ path: "main.cpp", content: "imported snapshot" }] }),
      0,
      editContext()
    );

    expect(next.room?.files[0].content).toBe("imported snapshot");
    expect(next.remoteRevs["main.cpp"]).toBe((typed.remoteRevs["main.cpp"] || 0) + 1);
  });

  test("unacknowledged edits to one file do not shield another file", () => {
    const two = applyServerMessage(
      initialRoomClientState,
      roomState({
        files: [
          { path: "main.cpp", content: "a" },
          { path: "out.txt", content: "old" },
        ],
      }),
      0,
      editContext()
    );
    const typed = applyLocalFileEdit(two, "main.cpp", "ab");
    const next = applyServerMessage(
      typed,
      roomState({
        files: [
          { path: "main.cpp", content: "a" },
          { path: "out.txt", content: "written by the run" },
        ],
      }),
      0,
      editContext({ unackedPaths: new Set(["main.cpp"]) })
    );

    expect(next.room?.files.map((file) => file.content)).toEqual(["ab", "written by the run"]);
  });

  test("an observer always takes the server's text", () => {
    const bob = editContext({ userName: "Bob", unackedPaths: new Set(["main.cpp"]) });
    const state = applyServerMessage(initialRoomClientState, roomState(), 0, bob);
    const next = applyServerMessage(
      state,
      roomState({ files: [{ path: "main.cpp", content: "v2" }] }),
      0,
      bob
    );

    expect(next.room?.files[0].content).toBe("v2");
  });

  test("someone who just received control starts from the server's text", () => {
    const bob = editContext({ userName: "Bob", unackedPaths: new Set(["main.cpp"]) });
    const state = applyServerMessage(initialRoomClientState, roomState(), 0, bob);
    const next = applyServerMessage(
      state,
      roomState({ currentController: "Bob", files: [{ path: "main.cpp", content: "handed over" }] }),
      0,
      bob
    );

    expect(next.room?.files[0].content).toBe("handed over");
  });

  test("the console input follows the same rule", () => {
    const typed = { ...joined, room: { ...joined.room!, consoleInput: "1 2 3" } };
    const stale = roomState({ consoleInput: "1 2" });

    expect(
      applyServerMessage(typed, stale, 0, editContext({ consoleUnacked: true })).room
        ?.consoleInput
    ).toBe("1 2 3");
    expect(applyServerMessage(typed, stale, 0, editContext()).room?.consoleInput).toBe("1 2");
  });

  test("file and console updates from the controller patch the room", () => {
    let state = applyServerMessage(
      joined,
      { type: "file_updated", path: "main.cpp", content: "v2", updatedBy: "Alice" },
      0,
      editContext({ userName: "Bob" })
    );
    state = applyServerMessage(
      state,
      { type: "console_input_updated", consoleInput: "1 2\n", updatedBy: "Alice" },
      0,
      editContext({ userName: "Bob" })
    );

    expect(state.room?.files[0].content).toBe("v2");
    expect(state.room?.consoleInput).toBe("1 2\n");
    expect(state.remoteRevs["main.cpp"]).toBe((joined.remoteRevs["main.cpp"] || 0) + 1);
  });

  test("typing locally never counts as a server revision", () => {
    const typed = applyLocalFileEdit(joined, "main.cpp", "typed here");

    expect(typed.remoteRevs).toBe(joined.remoteRevs);
  });

  test("run results set the output with a status, including legacy messages", () => {
    const base = { type: "run_result" as const, stdout: "", stderr: "", runner: "Alice" };
    const outputStatus = (message: Record<string, unknown>) =>
      applyServerMessage(joined, { ...base, ...message } as never, 5, editContext()).output
        ?.status;

    expect(outputStatus({ output: "x", exitCode: 0, timedOut: false, status: "memory_limit" })).toBe("memory_limit");
    expect(outputStatus({ output: "[Running by Alice...]\n", exitCode: null, timedOut: false })).toBe("running");
    expect(outputStatus({ output: "[Compile failed]\n", exitCode: 1, timedOut: false })).toBe("compile_error");
    expect(outputStatus({ output: "x", exitCode: 0, timedOut: false })).toBe("ok");
    expect(outputStatus({ output: "x", exitCode: 3, timedOut: false })).toBe("runtime_error");
    expect(outputStatus({ output: "x", exitCode: null, timedOut: true })).toBe("time_limit");
  });
});

describe("contest clock", () => {
  const start = Date.parse("2026-11-01T10:00:00.000Z");
  const running = contest({ startedAt: "2026-11-01T10:00:00.000Z" });

  test("before the start the full duration remains", () => {
    expect(getContestClock(contest(), start)).toEqual({
      phase: "not_started",
      elapsedMs: 0,
      remainingMs: 300 * 60_000,
      timeUp: false,
    });
  });

  test("a running contest counts down and finishes when time is up", () => {
    const mid = getContestClock(running, start + 90 * 60_000);

    expect(mid.phase).toBe("running");
    expect(formatClock(mid.remainingMs)).toBe("3:30:00");

    const over = getContestClock(running, start + 301 * 60_000);

    expect(over.phase).toBe("finished");
    expect(over.timeUp).toBe(true);
    expect(over.remainingMs).toBe(0);
  });

  test("an ended contest freezes at its end time", () => {
    const ended = contest({
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: "2026-11-01T11:00:00.000Z",
    });
    const clock = getContestClock(ended, start + 200 * 60_000);

    expect(clock.phase).toBe("finished");
    expect(clock.timeUp).toBe(false);
    expect(formatClock(clock.elapsedMs)).toBe("1:00:00");
  });

  test("clock and duration formatting", () => {
    expect(formatClock(0)).toBe("0:00:00");
    expect(formatClock(999)).toBe("0:00:01");
    expect(formatClock(5 * 3600_000)).toBe("5:00:00");
    expect(formatClock(-5)).toBe("0:00:00");
    expect(formatDuration(300)).toBe("5 h");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(150)).toBe("2 h 30 min");
  });

  test("a contest length can be anything from a minute to thirty days", () => {
    expect(parseDuration("5", "0")).toEqual({ ok: true, minutes: 300 });
    expect(parseDuration("", "20")).toEqual({ ok: true, minutes: 20 });
    expect(parseDuration("2", "")).toEqual({ ok: true, minutes: 120 });
    expect(parseDuration("0", "90")).toEqual({ ok: true, minutes: 90 });
    expect(parseDuration("72", "0")).toEqual({ ok: true, minutes: 4320 });
    expect(parseDuration("720", "0")).toEqual({ ok: true, minutes: 43200 });
    expect(parseDuration("720", "1").ok).toBe(false);
    expect(parseDuration("0", "0").ok).toBe(false);
    expect(parseDuration("", "").ok).toBe(false);
    expect(parseDuration("1.5", "0").ok).toBe(false);
    expect(parseDuration("-1", "30").ok).toBe(false);
    expect(parseDuration("abc", "0").ok).toBe(false);
  });

  test("long contests show hours past 24 on the clock", () => {
    const long = contest({ durationMinutes: 72 * 60, startedAt: "2026-11-01T10:00:00.000Z" });
    const clock = getContestClock(long, start + 60_000);

    expect(clock.phase).toBe("running");
    expect(formatClock(clock.remainingMs)).toBe("71:59:00");
    expect(formatDuration(72 * 60)).toBe("72 h");
  });
});

describe("session store", () => {
  function memoryStorage() {
    const data = new Map<string, string>();

    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  }

  test("tokens are shared across tabs, the seat in use is per tab", () => {
    const local = memoryStorage();
    const tabOne = createSessionStore(local, memoryStorage());
    const tabTwo = createSessionStore(local, memoryStorage());

    tabOne.saveToken("ABCDEF", "Alice", "t-alice");
    tabOne.setTabUser("ABCDEF", "Alice");
    tabOne.setLastName("Alice");

    expect(tabTwo.getToken("ABCDEF", "Alice")).toBe("t-alice");
    expect(tabTwo.getToken("ABCDEF", "Bob")).toBe(undefined);
    expect(tabTwo.getToken("OTHER1", "Alice")).toBe(undefined);
    expect(tabTwo.getTabUser("ABCDEF")).toBe("");
    expect(tabOne.getTabUser("ABCDEF")).toBe("Alice");
    expect(tabTwo.getLastName()).toBe("Alice");

    tabOne.forgetToken("ABCDEF", "Alice");
    tabOne.clearTabUser("ABCDEF");
    expect(tabTwo.getToken("ABCDEF", "Alice")).toBe(undefined);
    expect(tabOne.getTabUser("ABCDEF")).toBe("");
  });

  test("blocked storage degrades to no saved session instead of throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createSessionStore(broken, broken);

    expect(store.getToken("ABCDEF", "Alice")).toBe(undefined);
    expect(() => store.saveToken("ABCDEF", "Alice", "t")).not.toThrow();
    expect(store.getTabUser("ABCDEF")).toBe("");
    expect(store.getLastName()).toBe("");
  });
});

describe("editor language", () => {
  test("paths map to editor languages and runnable types", () => {
    expect(editorLanguageForPath("A/main.cpp")).toBe("cpp");
    expect(editorLanguageForPath("a.py")).toBe("python");
    expect(editorLanguageForPath("Main.java")).toBe("java");
    expect(editorLanguageForPath("a.kt")).toBe("kotlin");
    expect(editorLanguageForPath("input.in")).toBe("plaintext");
    expect(isRunnablePath("A/main.cpp")).toBe(true);
    expect(isRunnablePath("input.in")).toBe(false);
  });
});
