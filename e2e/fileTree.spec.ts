import { expect, test, type Locator, type Page } from "@playwright/test";

function row(page: Page, path: string): Locator {
  return page.locator(`.tree-row[data-path="${path}"]`);
}

async function left(locator: Locator): Promise<number> {
  return Math.round(((await locator.boundingBox()) as { x: number }).x);
}

test("files and folders are created inline in the tree, nested with indentation", async ({
  browser,
}) => {
  const alice = await (await browser.newContext()).newPage();

  await alice.goto("/");
  await alice.getByLabel("Your name").fill("Alice");
  await alice.getByRole("button", { name: "Create a new room" }).click();

  const code = ((await alice.getByTestId("room-code").textContent()) as string).replace("-", "");
  const newFile = alice.getByLabel("Workspace files").getByRole("button", { name: "New File" });
  const newFolder = alice.getByLabel("Workspace files").getByRole("button", { name: "New Folder" });

  // A new room is an empty workspace with the two buttons ready.
  await expect(alice.getByText("No files yet.")).toBeVisible();
  await expect(newFile).toBeEnabled();
  await expect(newFolder).toBeEnabled();

  // --- New Folder: the name is typed in the tree itself -------------------------
  await newFolder.click();
  await expect(alice.getByLabel("New folder name")).toBeFocused();
  await expect(alice.locator("dialog[open]")).toHaveCount(0);
  await alice.getByLabel("New folder name").fill("A");
  await alice.getByLabel("New folder name").press("Enter");
  await expect(row(alice, "A")).toHaveAttribute("data-depth", "0");

  // --- New File goes into the selected folder, one level in ----------------------
  await newFile.click();
  await expect(alice.locator(".tree-row.editing")).toHaveAttribute("data-depth", "1");
  await alice.getByLabel("New file name").fill("main.cpp");
  await alice.getByLabel("New file name").press("Enter");
  await expect(row(alice, "A/main.cpp")).toHaveAttribute("data-depth", "1");
  await expect(alice.locator(".editor-path")).toHaveText("A/main.cpp");

  // --- With a file selected, new entries go beside it ----------------------------
  await newFolder.click();
  await alice.getByLabel("New folder name").fill("tests");
  await alice.getByLabel("New folder name").press("Enter");
  await expect(row(alice, "A/tests")).toHaveAttribute("data-depth", "1");

  await newFile.click();
  await alice.getByLabel("New file name").fill("1.in");
  await alice.getByLabel("New file name").press("Enter");
  await expect(row(alice, "A/tests/1.in")).toHaveAttribute("data-depth", "2");

  // --- Each level is indented by the same step, with a guide line per level ------
  const nameOf = (path: string) => row(alice, path).locator(".tree-name");
  const step = (await left(nameOf("A/tests"))) - (await left(nameOf("A")));

  expect(step).toBe(16);
  expect((await left(nameOf("A/tests/1.in"))) - (await left(nameOf("A/tests")))).toBe(16);
  // A file lines up with a folder at the same level.
  expect(await left(nameOf("A/main.cpp"))).toBe(await left(nameOf("A/tests")));
  await expect(row(alice, "A").locator(".tree-indent")).toHaveCount(0);
  await expect(row(alice, "A/main.cpp").locator(".tree-indent")).toHaveCount(1);
  await expect(row(alice, "A/tests/1.in").locator(".tree-indent")).toHaveCount(2);

  // --- A name that is taken is refused in place; Escape abandons it ---------------
  await row(alice, "A").click(); // selects A (and collapses it)
  await row(alice, "A").click(); // expands it again
  await newFile.click();
  await alice.getByLabel("New file name").fill("main.cpp");
  await alice.getByLabel("New file name").press("Enter");
  await expect(alice.getByText(/already exists here/)).toBeVisible();
  await expect(alice.getByLabel("New file name")).toBeFocused();
  await alice.getByLabel("New file name").press("Escape");
  await expect(alice.getByLabel("New file name")).toHaveCount(0);
  await expect(alice.locator(".tree-row.file")).toHaveCount(2);

  // --- Clicking the empty part of the tree targets the top level ------------------
  await alice.locator(".tree-scroll").click({ position: { x: 100, y: 300 } });
  await newFile.click();
  await expect(alice.locator(".tree-row.editing")).toHaveAttribute("data-depth", "0");
  await alice.getByLabel("New file name").fill("notes.txt");
  await alice.getByLabel("New file name").press("Enter");
  await expect(row(alice, "notes.txt")).toHaveAttribute("data-depth", "0");

  // --- A path typed as a name creates the folders on the way ----------------------
  await alice.locator(".tree-scroll").click({ position: { x: 100, y: 300 } });
  await newFile.click();
  await alice.getByLabel("New file name").fill("B/sub/b.py");
  await alice.getByLabel("New file name").press("Enter");
  await expect(row(alice, "B/sub/b.py")).toHaveAttribute("data-depth", "2");

  // --- Rename happens in place too -------------------------------------------------
  await row(alice, "A/main.cpp").hover();
  await alice.getByRole("button", { name: "Rename A/main.cpp" }).click();

  const rename = alice.getByLabel("New name for A/main.cpp");

  await expect(rename).toHaveValue("main.cpp");
  await rename.fill("sol.cpp");
  await rename.press("Enter");
  await expect(row(alice, "A/sol.cpp")).toBeVisible();
  await expect(row(alice, "A/main.cpp")).toHaveCount(0);

  // --- Folders collapse and expand ---------------------------------------------------
  await row(alice, "B").click();
  await expect(row(alice, "B/sub")).toHaveCount(0);
  await row(alice, "B").click();
  await expect(row(alice, "B/sub/b.py")).toBeVisible();

  // --- An observer sees the same tree but cannot create ------------------------------
  const bob = await (await browser.newContext()).newPage();

  await bob.goto(`/r/${code}`);
  await bob.getByLabel("Your name").fill("Bob");
  await bob.getByRole("button", { name: "Join room" }).click();

  await expect(row(bob, "A/tests/1.in")).toHaveAttribute("data-depth", "2");
  await expect(row(bob, "A/sol.cpp")).toHaveAttribute("data-depth", "1");
  await expect(row(bob, "notes.txt")).toHaveAttribute("data-depth", "0");
  await expect(bob.getByLabel("Workspace files").getByRole("button", { name: "New File" })).toBeDisabled();
  await expect(bob.getByLabel("Workspace files").getByRole("button", { name: "New Folder" })).toBeDisabled();
  await expect(bob.getByRole("button", { name: /^Rename / })).toHaveCount(0);
});
