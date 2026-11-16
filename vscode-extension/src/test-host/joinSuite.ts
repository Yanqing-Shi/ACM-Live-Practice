// Tests the Join Room flow across windows, including two members of the same
// room joining from one VS Code.
//
// VS Code starts this file in the window the launcher opened (an ordinary
// folder) and again in every room window that Join Room opens. The first copy
// does what the Join Room command does after its prompts, twice: once as
// Alice and once as Bob. Each room window then checks, from the inside, that
// it joined by itself as the right person and that the other one is in the
// room too. VS Code quits with the result of whichever copy finishes, so the
// first one just waits.
import * as assert from "assert";
import * as vscode from "vscode";
import type { ExtensionApi } from "../extension";
import { seatFolderName } from "../roomUris";

const identity = JSON.parse(process.env.ICPC_LIVE_TEST_JOIN as string) as {
  serverUrl: string;
  roomId: string;
};

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("icpc-live.icpc-live-vscode");

  assert.ok(extension);

  const api = await extension.activate();
  const folder = vscode.workspace.workspaceFolders?.[0];

  assert.ok(folder, "a folder is open");

  if (folder.uri.scheme === "icpc-room") {
    // --- A room window ---------------------------------------------------------
    const started = Date.now();
    const bothOnline = () =>
      ["Alice", "Bob"].every((name) => api.client.state?.members.includes(name));

    while (!bothOnline()) {
      if (Date.now() - started > 30_000) {
        throw new Error(
          `Room window "${folder.name}": expected Alice and Bob online, got ${JSON.stringify(
            api.client.state?.members
          )} (status: ${api.client.status})`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // This window is one of the two, and knows which: its folder is named
    // after its own member, and that is who it joined as.
    const me = api.client.userName;

    assert.ok(me === "Alice" || me === "Bob", `unexpected member "${me}"`);
    assert.equal(folder.name, seatFolderName({ roomId: identity.roomId, userName: me }));
    assert.equal(api.client.roomId, identity.roomId);
    // Both names were seated by the first window; taking one again needs the
    // token it saved for that name, so each window found its own seat.
    assert.deepEqual(
      api.client.state?.memberStates.map((member) => member.name).sort(),
      ["Alice", "Bob"]
    );
    console.log(
      `  ✓ window "${folder.name}" joined by itself as ${me}; Alice and Bob are both in the room`
    );
    return;
  }

  // --- The window where Join Room was run --------------------------------------------
  // The code is typed in lower case with a dash, as a person might.
  const typed = `${identity.roomId.slice(0, 3)}-${identity.roomId.slice(3)}`.toLowerCase();

  await api.enterRoom({ serverUrl: identity.serverUrl, roomId: typed, userName: "Alice" });
  // Joining the same room again under another name is a second member. It
  // must get its own window, not be sent to Alice's.
  await api.enterRoom({ serverUrl: identity.serverUrl, roomId: typed, userName: "Bob" });

  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.toString(), folder.uri.toString());
  assert.equal(api.client.state, null);
  console.log("  ✓ the window that ran Join Room twice keeps its own folder");

  await new Promise((resolve) => setTimeout(resolve, 60_000));
  throw new Error("No room window reported that both members joined");
}
