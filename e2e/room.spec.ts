import { expect, test, type Browser, type Page } from "@playwright/test";

async function openAs(browser: Browser, path: string): Promise<Page> {
  // A separate context per person: its own storage, like a separate computer.
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(path);
  return page;
}

async function joinByCode(browser: Browser, code: string, name: string): Promise<Page> {
  const page = await openAs(browser, "/");

  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Team code").fill(code);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.getByTestId("room-code")).toBeVisible();
  return page;
}

function editorText(page: Page) {
  return page.locator(".editor-host .view-lines");
}

test("three people join with one code, share a keyboard, run code and time a contest", async ({
  browser,
}) => {
  // --- Alice creates the room -------------------------------------------------
  const alice = await openAs(browser, "/");

  await alice.getByLabel("Your name").fill("Alice");
  await alice.getByRole("button", { name: "Create a new room" }).click();

  const codeLabel = alice.getByTestId("room-code");
  await expect(codeLabel).toHaveText(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);

  const code = (await codeLabel.textContent()) as string;
  await expect(alice).toHaveURL(new RegExp(`/r/${code.replace("-", "")}$`));
  await expect(alice.getByText("You have control")).toBeVisible();

  // --- Bob types the code, Carol follows the invite link -----------------------
  const bob = await joinByCode(browser, code.toLowerCase(), "Bob");
  const carol = await openAs(browser, `/r/${code.replace("-", "")}`);

  await expect(carol.getByLabel("Team code")).toHaveValue(code);
  await carol.getByLabel("Your name").fill("Carol");
  await carol.getByRole("button", { name: "Join room" }).click();

  for (const page of [alice, bob, carol]) {
    await expect(page.getByLabel("Members").getByRole("listitem")).toHaveCount(3);
  }

  // A name that is taken cannot be used by someone else.
  const impostor = await openAs(browser, "/");
  await impostor.getByLabel("Your name").fill("Alice");
  await impostor.getByLabel("Team code").fill(code);
  await impostor.getByRole("button", { name: "Join room" }).click();
  await expect(impostor.getByRole("alert")).toContainText("already taken");
  await impostor.context().close();

  // --- Only the controller can edit ---------------------------------------------
  await expect(bob.getByTestId("readonly-chip")).toContainText("Alice has control");
  await expect(bob.getByLabel("Workspace files").getByRole("button", { name: "New File" })).toBeDisabled();
  await expect(bob.getByLabel("Workspace files").getByRole("button", { name: "New Folder" })).toBeDisabled();
  await expect(bob.getByRole("button", { name: /Run/ })).toBeDisabled();

  await alice.getByLabel("Workspace files").getByRole("button", { name: "New File" }).click();
  await alice.getByLabel("New file name").fill("A/main.cpp");
  await alice.getByLabel("New file name").press("Enter");
  await expect(alice.getByText("You are editing")).toBeVisible();

  await alice.locator(".editor-host").click();
  await alice.keyboard.insertText(
    '#include <iostream>\nint main() { long long a, b; std::cin >> a >> b; std::cout << "sum=" << a + b << "\\n"; }\n'
  );

  // The observers see the text appear without doing anything.
  await expect(editorText(bob)).toContainText("sum=");
  await expect(editorText(carol)).toContainText("sum=");

  // Typing in a read-only editor changes nothing for anyone.
  await bob.locator(".editor-host").click();
  await bob.keyboard.type("HACKED");
  await expect(editorText(alice)).not.toContainText("HACKED");
  await expect(editorText(bob)).not.toContainText("HACKED");

  // --- Run ----------------------------------------------------------------------
  await alice.getByRole("tab", { name: "Input" }).click();
  await alice.getByLabel("Program input").fill("20 22\n");
  await alice.getByRole("button", { name: "Run", exact: true }).click();

  for (const page of [alice, bob, carol]) {
    await expect(page.getByTestId("run-output")).toContainText("sum=42", { timeout: 30_000 });
    await expect(page.getByTestId("run-output")).toContainText("Exit code: 0");
  }

  await expect(bob.getByRole("tab", { name: "History (1)" })).toBeVisible();

  // --- Control moves on request ---------------------------------------------------
  await bob.getByRole("button", { name: "Request control" }).click();
  await expect(bob.getByRole("button", { name: "Control requested…" })).toBeDisabled();
  await alice.getByRole("button", { name: "Give control to Bob" }).click();

  await expect(bob.getByText("You have control")).toBeVisible();
  await expect(bob.getByText("You are editing")).toBeVisible();
  await expect(alice.getByTestId("readonly-chip")).toContainText("Bob has control");

  // What Alice typed is what Bob now edits.
  await bob.locator(".editor-host").click();
  await bob.keyboard.press("Control+End");
  await bob.keyboard.insertText("// bob was here\n");
  await expect(editorText(alice)).toContainText("bob was here");
  await expect(editorText(alice)).toContainText("sum=");

  // --- Contest clock: any member can use it, and it can be any length ----------------
  await expect(carol.getByTestId("contest-clock")).toHaveText("5:00:00");
  await carol.getByTestId("contest-clock-button").click();

  await carol.getByLabel("Contest hours").fill("2");
  await carol.getByLabel("Contest minutes").fill("30");
  await carol.getByLabel("Contest minutes").blur();
  await expect(alice.getByTestId("contest-clock")).toHaveText("2:30:00");

  await carol.getByLabel("Contest hours").fill("0");
  await carol.getByLabel("Contest minutes").fill("0");
  await carol.getByRole("button", { name: "Start contest" }).click();
  await expect(carol.getByText("The contest must last at least 1 minute")).toBeVisible();
  await expect(alice.getByTestId("contest-clock")).toHaveText("2:30:00");

  // Typing a new length and pressing Start applies it and starts in one go.
  await carol.getByLabel("Contest hours").fill("50");
  await carol.getByRole("button", { name: "Start contest" }).click();

  for (const page of [alice, bob, carol]) {
    await expect(page.getByTestId("contest-clock")).toHaveText(/^49:59:\d\d$/);
    await expect(page.getByTestId("contest-clock-button")).toContainText("left");
  }

  // Ending it stops the clock for everyone; resetting makes it startable again.
  await alice.getByTestId("contest-clock-button").click();
  await alice.getByRole("button", { name: "End contest" }).click();
  await alice.locator("dialog.modal").getByRole("button", { name: "End contest" }).click();
  await expect(bob.getByTestId("contest-clock-button")).toContainText("ended");

  await bob.getByTestId("contest-clock-button").click();
  await bob.getByRole("button", { name: "Reset clock" }).click();
  await bob.locator("dialog.modal").getByRole("button", { name: "Reset clock" }).click();
  await expect(alice.getByTestId("contest-clock")).toHaveText("50:00:00");
  await expect(alice.getByTestId("contest-clock-button")).toContainText("not started");

  // Who held control, and when, is on the Activity tab.
  await carol.getByRole("tab", { name: "Activity" }).click();
  await expect(carol.getByText("Alice gave control to Bob")).toBeVisible();

  // --- A refresh keeps the seat, and control ----------------------------------------
  await bob.reload();
  await expect(bob.getByTestId("room-code")).toHaveText(code);
  await expect(bob.getByText("You have control")).toBeVisible();
  await expect(editorText(bob)).toContainText("bob was here");
  await expect(bob.getByLabel("Members").getByRole("listitem")).toHaveCount(3);
});
