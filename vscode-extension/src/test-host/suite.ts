// Runs inside a real VS Code whose folder is an ICPC Live room, joined as
// "Alice". A second member, "Bob", is a plain WebSocket client driven from
// here. Everything Alice does goes through the same VS Code APIs the
// Explorer and editors use.
import * as assert from "assert";
import * as vscode from "vscode";
import WebSocket from "ws";
import type { ExtensionApi } from "../extension";
import type { ClientMessage, RoomStateMessage, RunResultMessage, ServerMessage } from "../protocol";
import { inputUri, roomUri } from "../roomFileSystemProvider";
import { seatFolderName } from "../roomUris";

const identity = JSON.parse(process.env.ICPC_LIVE_TEST_IDENTITY as string) as {
  serverUrl: string;
  roomId: string;
  userName: string;
};

async function until<T>(
  label: string,
  check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 8000
): Promise<T> {
  const started = Date.now();

  for (;;) {
    const value = await check();

    if (value) return value;

    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function rejects(label: string, action: () => Thenable<unknown>, pattern: RegExp): Promise<void> {
  try {
    await action();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const text = error instanceof Error ? `${error.name} ${String(code)} ${error.message}` : String(error);

    assert.ok(pattern.test(text), `${label}: unexpected error "${text}"`);
    return;
  }

  assert.fail(`${label}: expected it to be refused`);
}

/** Bob: a teammate using nothing but the wire protocol. */
class Teammate {
  state: RoomStateMessage | null = null;
  readonly messages: ServerMessage[] = [];
  private socket: WebSocket | undefined;

  async join(name: string): Promise<void> {
    const socket = new WebSocket(identity.serverUrl.replace(/^http/, "ws"));

    this.socket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;

      this.messages.push(message);

      if (message.type === "room_state") this.state = message;

      if (message.type === "file_updated" && this.state) {
        this.state = {
          ...this.state,
          files: this.state.files.map((file) =>
            file.path === message.path ? { ...file, content: message.content } : file
          ),
        };
      }

      if (message.type === "console_input_updated" && this.state) {
        this.state = { ...this.state, consoleInput: message.consoleInput };
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    this.send({ type: "join_room", roomId: identity.roomId, userName: name });
    await until("teammate to join", () => this.state?.members.includes(name));
  }

  send(message: ClientMessage): void {
    if (!this.socket) throw new Error("The teammate has not joined yet");

    this.socket.send(JSON.stringify(message));
  }

  content(path: string): string | undefined {
    return this.state?.files.find((file) => file.path === path)?.content;
  }

  close(): void {
    this.socket?.terminate();
  }
}

export async function run(): Promise<void> {
  const steps: string[] = [];
  const step = (name: string) => {
    steps.push(name);
    console.log(`  ✓ ${name}`);
  };

  const extension = vscode.extensions.getExtension<ExtensionApi>("icpc-live.icpc-live-vscode");

  assert.ok(extension, "extension is installed");

  const api = await extension.activate();
  const { client } = api;
  const bob = new Teammate();

  try {
    // --- The window is the room ---------------------------------------------------
    await until("the extension to join the room", () => client.state !== null, 15_000);

    const folder = vscode.workspace.workspaceFolders?.[0];

    assert.ok(folder, "a workspace folder is open");
    assert.equal(folder.uri.scheme, "icpc-room");
    // The Explorer and the window title say who this window is.
    assert.equal(folder.name, seatFolderName(identity));
    assert.match(folder.name, /\(Alice\)$/);
    assert.equal(client.isController, true);
    assert.deepEqual(await vscode.workspace.fs.readDirectory(folder.uri), []);
    step("opening the room folder joins the room; the workspace starts empty");

    const fs = vscode.workspace.fs;
    const at = (path: string) => roomUri(identity, path);
    const text = (value: string) => Buffer.from(value, "utf8");

    // --- New Folder / New File, as the Explorer does them ----------------------------
    await fs.createDirectory(at("A"));
    await fs.writeFile(at("A/main.cpp"), text(""));

    const newFile = new vscode.WorkspaceEdit();

    newFile.createFile(at("A/tests/1.in"), { contents: text("1 2\n") });
    assert.equal(await vscode.workspace.applyEdit(newFile), true);

    assert.deepEqual(await fs.readDirectory(folder.uri), [["A", vscode.FileType.Directory]]);
    assert.deepEqual(await fs.readDirectory(at("A")), [
      ["tests", vscode.FileType.Directory],
      ["main.cpp", vscode.FileType.File],
    ]);
    assert.equal(Buffer.from(await fs.readFile(at("A/tests/1.in"))).toString(), "1 2\n");
    assert.equal((await fs.stat(at("A/main.cpp"))).permissions, undefined, "writable for the controller");
    // This is the switch the Explorer's New File and New Folder buttons obey.
    assert.equal(fs.isWritableFileSystem("icpc-room"), true, "the room is writable with control");
    // VS Code treats "create folder" as "make sure it exists".
    await fs.createDirectory(at("A"));
    await rejects("writing a file over a folder", () => fs.writeFile(at("A"), text("x")), /directory|EISDIR|exists/i);
    await rejects("reading a missing file", () => fs.readFile(at("nope.txt")), /FileNotFound|not found/i);
    step("New Folder and New File create nested entries in the room");

    await bob.join("Bob");
    assert.deepEqual(bob.state?.files.map((file) => file.path).sort(), ["A/main.cpp", "A/tests/1.in"]);
    step("a teammate sees the same files");

    // --- Rename and delete ------------------------------------------------------------
    await fs.rename(at("A/main.cpp"), at("A/sol.cpp"));
    await fs.rename(at("A/tests"), at("A/cases"));
    await until("the renames to reach the teammate", () =>
      bob.content("A/sol.cpp") !== undefined && bob.content("A/cases/1.in") === "1 2\n"
    );
    await fs.delete(at("A/cases"), { recursive: true });
    await until("the delete to reach the teammate", () => bob.state?.files.length === 1);
    assert.deepEqual(await fs.readDirectory(at("A")), [["sol.cpp", vscode.FileType.File]]);
    step("rename and delete work on files and folders");

    // --- Typing is shared live, saving never conflicts ---------------------------------
    const document = await vscode.workspace.openTextDocument(at("A/sol.cpp"));
    const editor = await vscode.window.showTextDocument(document);

    assert.equal(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "int main() {}\n")), true);
    await until("typed text to reach the teammate without saving", () =>
      bob.content("A/sol.cpp") === "int main() {}\n"
    );
    assert.equal(document.isDirty, true, "typing does not auto-save");
    assert.equal(await document.save(), true, "saving after live typing must not conflict");
    assert.equal(document.isDirty, false);

    // Real keystrokes this time, as a person would type them.
    editor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
    await vscode.commands.executeCommand("type", { text: "// second\n" });
    await until("the typed keystrokes to reach the teammate", () =>
      bob.content("A/sol.cpp") === "int main() {}\n// second\n"
    );
    assert.equal(await document.save(), true, "saving a second time must not conflict either");
    step("typing reaches the teammate live; saving works every time");

    // --- Handing control over ------------------------------------------------------------
    assert.equal(await editor.edit((edit) => edit.insert(new vscode.Position(2, 0), "// unsaved\n")), true);
    assert.equal(document.isDirty, true);

    bob.send({ type: "request_control" });
    await until("the control request to arrive", () => client.state?.controlRequests.includes("Bob"));
    await vscode.commands.executeCommand("icpcLive.approveControl");
    await until("control to move to the teammate", () => client.state?.currentController === "Bob");

    assert.equal(bob.content("A/sol.cpp"), "int main() {}\n// second\n// unsaved\n", "nothing typed is lost");
    await until("the document to be clean after the hand-over", () => !document.isDirty);
    step("giving control away first delivers and saves what was typed");

    // --- Without control everything is read-only ------------------------------------------
    await until("files to report read-only", async () =>
      (await fs.stat(at("A/sol.cpp"))).permissions === vscode.FilePermission.Readonly
    );
    // The whole room is declared read-only, so VS Code greys out New File,
    // New Folder, Rename and Delete instead of letting a name be typed first.
    await until("the room to be declared read-only", () => fs.isWritableFileSystem("icpc-room") === false);
    await rejects("writing without control", () => fs.writeFile(at("A/sol.cpp"), text("hacked")), /NoPermissions|control/i);
    await rejects("creating without control", () => fs.writeFile(at("new.txt"), text("")), /NoPermissions|control/i);
    await rejects("deleting without control", () => fs.delete(at("A/sol.cpp")), /NoPermissions|control/i);
    await rejects("renaming without control", () => fs.rename(at("A/sol.cpp"), at("A/x.cpp")), /NoPermissions|control/i);

    const before = document.getText();

    const locked = await vscode.window.showTextDocument(document);
    let sawForeignText = false;
    const watcher = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && document.getText().includes("HACKED")) sawForeignText = true;
    });

    await vscode.commands.executeCommand("type", { text: "HACKED" });
    await locked.edit((edit) => edit.insert(new vscode.Position(0, 0), "HACKED"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    watcher.dispose();
    assert.equal(sawForeignText, false, "the editor is locked, not edited and then reverted");
    assert.equal(document.getText(), before, "typing does nothing in a read-only room file");
    assert.equal(bob.content("A/sol.cpp"), before);
    step("without control, files cannot be edited, created, renamed or deleted");

    // --- Watching the controller ------------------------------------------------------------
    bob.send({ type: "update_file", path: "A/sol.cpp", content: "// bob's version\n" });
    await until("the open document to show the controller's text", () =>
      document.getText() === "// bob's version\n"
    );
    assert.equal(document.isDirty, false);

    bob.send({ type: "create_file", path: "B/b.py", content: "print('b')\n" });
    await until("the new file to appear", async () => {
      try {
        return (await fs.stat(at("B/b.py"))).type === vscode.FileType.File;
      } catch {
        return false;
      }
    });
    await until("the editor to follow the controller to the new file", () =>
      vscode.window.visibleTextEditors.some(
        (visible) => visible.document.uri.toString() === at("B/b.py").toString()
      )
    );
    step("an observer's editor shows the controller's edits and follows their file");

    // --- Getting control back ----------------------------------------------------------------
    // The command behind the Request Control buttons next to the file tree
    // and at the top of a read-only editor.
    await vscode.commands.executeCommand("icpcLive.requestControlButton");
    await until("the teammate to see the request", () => bob.state?.controlRequests.includes("Alice"));
    bob.send({ type: "approve_control", targetUserName: "Alice" });
    await until("control to come back", () => client.canEdit);
    await until("files to be writable again", async () =>
      (await fs.stat(at("A/sol.cpp"))).permissions === undefined
    );
    await until("the room to be declared writable again", () => fs.isWritableFileSystem("icpc-room") === true);

    const again = await vscode.window.showTextDocument(document);

    again.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    await vscode.commands.executeCommand("type", { text: "int mine; " });
    await until("the editor to accept typing again", () =>
      document.getText() === "int mine; // bob's version\n"
    ).catch((error: Error) => {
      throw new Error(`${error.message}; the document is ${JSON.stringify(document.getText())}`);
    });
    await until("the typing to reach the teammate", () =>
      bob.content("A/sol.cpp") === "int mine; // bob's version\n"
    );
    assert.equal(await document.save(), true);
    assert.ok(again);
    step("after getting control back, typing works again");

    // --- Program input and Run -----------------------------------------------------------------
    await fs.writeFile(at("run.py"), text("a, b = map(int, input().split())\nprint('answer', a * b)\n"));

    const input = await vscode.workspace.openTextDocument(inputUri(identity.roomId));
    const inputEditor = await vscode.window.showTextDocument(input);

    assert.equal(await inputEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), "6 7\n")), true);
    await until("the program input to reach the teammate", () => bob.state?.consoleInput === "6 7\n");

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(at("run.py")));
    await until("the room to switch to the open file", () => client.state?.activeFilePath === "run.py");
    await vscode.commands.executeCommand("icpcLive.runCode");

    const result = await until(
      "the run result",
      () =>
        bob.messages.find(
          (message): message is RunResultMessage =>
            message.type === "run_result" && message.status !== "running" && message.status !== "queued"
        ),
      30_000
    );

    assert.equal(result.status, "ok", result.output);
    assert.match(result.stdout, /answer 42/);
    await until("the run to appear in the history", () => client.state?.runHistory.length === 1);
    step("Run executes the open file with the typed input; everyone gets the result");

    console.log(`\n  ${steps.length} steps passed in real VS Code ${vscode.version}`);
  } catch (error) {
    console.error(`\n  ✗ failed after ${steps.length} step(s):`, error);
    throw error;
  } finally {
    bob.close();
  }
}
