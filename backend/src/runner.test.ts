import assert from "assert/strict";
import { spawnSync } from "child_process";
import test from "node:test";
import { runCodeInRoom } from "./runner";
import type { FileItem, Room, RunResultMessage } from "./types";

function commandExists(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookupCommand, [command], {
    stdio: "ignore",
  });

  return result.status === 0;
}

function hasPython(): boolean {
  return commandExists(process.platform === "win32" ? "python" : "python3");
}

function createRoom(
  files: FileItem[],
  activeFilePath: string,
  options: Partial<Pick<Room, "consoleInput" | "stdinMode">> = {}
): Room {
  return {
    clients: [],
    currentController: "Alice",
    controlRequests: [],
    files,
    folders: [],
    activeFilePath,
    consoleInput: options.consoleInput ?? "",
    stdinMode: options.stdinMode ?? "console",
    runHistory: [],
    controlTimeline: [],
    auditEvents: [],
  };
}

async function runRoom(room: Room): Promise<{
  result: RunResultMessage;
  progress: RunResultMessage[];
}> {
  const progress: RunResultMessage[] = [];
  const result = await runCodeInRoom(room, "Alice", (message) => {
    progress.push(message);
  });

  return { result, progress };
}

function assertSuccessfulRun(result: RunResultMessage): void {
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.exitCode, 0, result.output);
}

test("runs C++ with console stdin", { skip: !commandExists("g++") }, async () => {
  const room = createRoom(
    [
      {
        path: "main.cpp",
        content: `
#include <bits/stdc++.h>
using namespace std;

int main() {
  int a, b;
  cin >> a >> b;
  cout << a + b << "\\n";
}
`,
      },
    ],
    "main.cpp",
    {
      consoleInput: "2 5\n",
    }
  );

  const { result, progress } = await runRoom(room);

  assert.equal(progress.length, 1);
  assertSuccessfulRun(result);
  assert.match(result.stdout, /7/);
  assert.equal(room.runHistory.length, 1);
  assert.equal(room.runHistory[0].runner, "Alice");
  assert.equal(room.runHistory[0].filePath, "main.cpp");
  assert.equal(room.runHistory[0].language, "cpp");
  assert.match(room.runHistory[0].output, /stdout:\n7/);
  assert.equal(
    room.auditEvents.some((event) => event.type === "run_started"),
    true
  );
  assert.equal(
    room.auditEvents.some((event) => event.type === "run_finished"),
    true
  );
});

test("runs Python with console stdin", { skip: !hasPython() }, async () => {
  const room = createRoom(
    [
      {
        path: "main.py",
        content: "a, b = map(int, input().split())\nprint(a * b)\n",
      },
    ],
    "main.py",
    {
      consoleInput: "3 4\n",
    }
  );

  const { result } = await runRoom(room);

  assertSuccessfulRun(result);
  assert.match(result.stdout, /12/);
});

test("runs Java Main.java", { skip: !commandExists("javac") }, async () => {
  const room = createRoom(
    [
      {
        path: "Main.java",
        content: `
import java.util.*;

class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    System.out.println(sc.nextInt() - sc.nextInt());
  }
}
`,
      },
    ],
    "Main.java",
    {
      consoleInput: "10 6\n",
    }
  );

  const { result } = await runRoom(room);

  assertSuccessfulRun(result);
  assert.match(result.stdout, /4/);
});

test(
  "runs Java class Main from a non-Main file",
  { skip: !commandExists("javac") },
  async () => {
    const room = createRoom(
      [
        {
          path: "solution.java",
          content: `
class Main {
  public static void main(String[] args) {
    System.out.println("java-fallback-main");
  }
}
`,
        },
      ],
      "solution.java"
    );

    const { result } = await runRoom(room);

    assertSuccessfulRun(result);
    assert.match(result.stdout, /java-fallback-main/);
  }
);

test("runs Kotlin", { skip: !commandExists("kotlinc") }, async () => {
  const room = createRoom(
    [
      {
        path: "main.kt",
        content: `
fun main() {
  val values = readLine()!!.split(" ").map { it.toInt() }
  println(values[0] + values[1])
}
`,
      },
    ],
    "main.kt",
    {
      consoleInput: "8 9\n",
    }
  );

  const { result } = await runRoom(room);

  assertSuccessfulRun(result);
  assert.match(result.stdout, /17/);
});

test("uses input.in next to the active file", { skip: !commandExists("g++") }, async () => {
  const room = createRoom(
    [
      {
        path: "A/main.cpp",
        content: `
#include <bits/stdc++.h>
using namespace std;

int main() {
  int x;
  cin >> x;
  cout << x * x << "\\n";
}
`,
      },
      {
        path: "A/input.in",
        content: "11\n",
      },
      {
        path: "input.in",
        content: "2\n",
      },
    ],
    "A/main.cpp",
    {
      stdinMode: "file",
    }
  );

  const { result } = await runRoom(room);

  assertSuccessfulRun(result);
  assert.match(result.stdout, /121/);
});

test("keeps only the latest 50 run history records", { skip: !hasPython() }, async () => {
  const room = createRoom(
    [
      {
        path: "main.py",
        content: "print('history')\n",
      },
    ],
    "main.py"
  );

  for (let i = 0; i < 51; i++) {
    const { result } = await runRoom(room);
    assertSuccessfulRun(result);
  }

  assert.equal(room.runHistory.length, 50);
  assert.equal(room.runHistory[0].runner, "Alice");
  assert.match(room.runHistory[0].output, /history/);
});
