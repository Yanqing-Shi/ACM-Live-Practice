import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

async function join(browser: Browser, baseURL: string, room: string, name: string): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto(room ? `/r/${room}` : "/");
  await page.getByLabel("Your name").fill(name);
  await page
    .getByRole("button", { name: room ? "Join room" : "Create a new room" })
    .click();
  await expect(page.getByTestId("room-code")).toBeVisible();
  return page;
}

/** The exact text in the editor, read from Monaco's model rather than the DOM. */
async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".editor-host .view-line"));

    return lines
      .map((line) => ({
        top: (line as HTMLElement).offsetTop,
        text: (line.textContent || "").replace(/ /g, " "),
      }))
      .sort((a, b) => a.top - b.top)
      .map((line) => line.text)
      .join("\n");
  });
}

test("fast typing is never lost or rolled back while the room is busy", async ({
  browser,
  baseURL,
}) => {
  const alice = await join(browser, baseURL as string, "", "Alice");
  const code = ((await alice.getByTestId("room-code").textContent()) as string).replace("-", "");
  const bob = await join(browser, baseURL as string, code, "Bob");

  await alice.getByLabel("Workspace files").getByRole("button", { name: "New File" }).click();
  await alice.getByLabel("New file name").fill("notes.txt");
  await alice.getByLabel("New file name").press("Enter");
  await alice.locator(".editor-host").click();

  // Bob keeps the server sending full room updates to everyone while Alice
  // types, by changing the contest length over and over. Each update carries
  // a copy of the file that is slightly behind what she has typed.
  await bob.getByTestId("contest-clock-button").click();

  let churning = true;
  const churn = (async () => {
    for (let round = 0; churning; round++) {
      await bob.getByLabel("Contest hours").fill(String(1 + (round % 9)));
      await bob.getByLabel("Contest hours").press("Enter");
      await bob.waitForTimeout(15);
    }
  })();

  const lines = Array.from({ length: 12 }, (_, index) => `line ${index} abcdefghijklmnopqrstuvwxyz`);

  for (const line of lines) {
    await alice.keyboard.type(line, { delay: 3 });
    await alice.keyboard.press("Enter");
  }

  churning = false;
  await churn;

  const expected = `${lines.join("\n")}\n`;

  await expect.poll(() => editorValue(alice)).toBe(expected);
  await expect.poll(() => editorValue(bob)).toBe(expected);
});

test("everyone gets their seat back after the server restarts", async ({ browser }) => {
  const port = 3300 + Math.floor(Math.random() * 400);
  const baseURL = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-e2e-restart-"));
  let server: ChildProcess | null = null;

  async function start(): Promise<void> {
    server = spawn("node", ["backend/dist/index.js"], {
      env: {
        ...process.env,
        PORT: String(port),
        ICPC_DATA_DIR: dataDir,
        RUNNER_MODE: "direct",
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${baseURL}/health`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true);
  }

  async function stop(signal: NodeJS.Signals): Promise<void> {
    const child = server;

    server = null;
    if (!child) return;

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill(signal);
    });
  }

  try {
    await start();

    const alice = await join(browser, baseURL, "", "Alice");
    const code = ((await alice.getByTestId("room-code").textContent()) as string).replace("-", "");
    const bob = await join(browser, baseURL, code, "Bob");

    await alice.getByLabel("Workspace files").getByRole("button", { name: "New File" }).click();
    await alice.getByLabel("New file name").fill("main.py");
    await alice.getByLabel("New file name").press("Enter");
    await alice.locator(".editor-host").click();
    await alice.keyboard.type("print('before restart')");
    await expect.poll(() => editorValue(bob)).toBe("print('before restart')");

    // A clean shutdown, as on a deploy: rooms are saved, sockets drop.
    await stop("SIGTERM");
    await expect(alice.getByText("Reconnecting…")).toBeVisible();
    await expect(bob.getByText("Reconnecting…")).toBeVisible();

    // Editing is paused while offline: nothing can be typed and then lost.
    await expect(alice.getByText("Editing paused · reconnecting")).toBeVisible();
    await alice.keyboard.type("  # typed offline");
    await expect.poll(() => editorValue(alice)).toBe("print('before restart')");

    await start();

    for (const page of [alice, bob]) {
      await expect(page.getByText("Reconnecting…")).toBeHidden({ timeout: 30_000 });
      await expect(page.getByLabel("Members").getByRole("listitem")).toHaveCount(2);
      await expect(page.getByTestId("room-code")).toHaveText(
        `${code.slice(0, 3)}-${code.slice(3)}`
      );
      // Nothing that reached the server before the restart is lost.
      await expect.poll(() => editorValue(page)).toBe("print('before restart')");
    }

    // Whoever reconnects first holds control, and exactly one of them does.
    await expect
      .poll(
        async () =>
          (await alice.getByText("You have control").count()) +
          (await bob.getByText("You have control").count())
      )
      .toBe(1);

    // The room is fully usable again: the controller can keep editing.
    const controller = (await alice.getByText("You have control").count()) === 1 ? alice : bob;
    const observer = controller === alice ? bob : alice;

    await controller.locator(".editor-host").click();
    await controller.keyboard.press("Control+End");
    await controller.keyboard.type("  # after restart");
    await expect.poll(() => editorValue(observer)).toBe("print('before restart')  # after restart");
  } finally {
    await stop("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
