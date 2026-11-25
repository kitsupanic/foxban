import { expect, test } from "@playwright/test";
import {
  addCard, addColumn, cardIn, columnByTitle, createBoard, signup, uniqueEmail,
  generateAccountInvite, inviteMember, getBoardUuid, dragCardTo, settleAnimationFrames,
  touchDragCardTo,
} from "./helpers";
import { mobileViewport } from "./fixtures";

test.describe("column editing and drag placement", () => {
  test("column dragging remains usable after concurrent equal-position creates", async ({ page }) => {
    await signup(page, uniqueEmail("column-ties"));
    const name = `Column ties ${Date.now()}`;
    const key = await createBoard(page, name);
    const boardId = await getBoardUuid(page, name);
    const errors: string[] = [];
    const moves: { id: string; position: string }[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "column.move") moves.push(message);
    }));
    await page.goto(`/board/${key}`);
    await page.evaluate(async (id) => {
      const socket = new WebSocket(`${location.origin.replace("http", "ws")}/boards/${id}/ws?realtimeVersion=14`);
      await new Promise<void>(resolve => socket.addEventListener("message", function ready(event) {
        if (JSON.parse(event.data).type === "snapshot") { socket.removeEventListener("message", ready); resolve(); }
      }));
      for (const [id, title, position] of [["first", "First", "a0"], ["equal-a", "Equal A", "a1"], ["equal-b", "Equal B", "a1"]]) {
        const mutationId = crypto.randomUUID();
        await new Promise<void>((resolve, reject) => {
          const receive = (event: MessageEvent) => {
            const message = JSON.parse(event.data);
            if (message.mutationId !== mutationId) return;
            socket.removeEventListener("message", receive);
            message.type === "error" ? reject(new Error(message.message)) : resolve();
          };
          socket.addEventListener("message", receive);
          socket.send(JSON.stringify({ type: "column.create", mutationId, id, title, position }));
        });
      }
      socket.close();
    }, boardId);
    const headers = page.locator("section header h2");
    await expect(headers).toHaveText(["First", "Equal A", "Equal B"]);
    await columnByTitle(page, "First").getByRole("button", { name: "Move column First", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("column-drag-preview")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await settleAnimationFrames(page);
    await page.keyboard.press("Space");
    await expect(headers).toHaveText(["Equal A", "Equal B", "First"]);
    expect(errors).toEqual([]);
    expect(moves).toHaveLength(1);
    expect(moves[0].id).toBe("first");
    expect(moves[0].position > "a1").toBe(true);
    await page.reload();
    await expect(headers).toHaveText(["Equal A", "Equal B", "First"]);
  });

  test("ordinary members cannot manage columns but can collaborate on cards", async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const memberContext = await browser.newContext();
    try {
      const owner = await ownerContext.newPage();
      const member = await memberContext.newPage();
      await signup(owner, uniqueEmail("column-owner"));
      const { token } = await generateAccountInvite(owner);
      const memberEmail = uniqueEmail("column-member", "user.test");
      await signup(member, memberEmail, "Column Member", token);
      expect(await (await member.request.get("/me")).json()).toMatchObject({ isAdmin: false });
      const name = `Column collaboration ${Date.now()}`;
      const key = await createBoard(owner, name);
      await inviteMember(owner, name, memberEmail);
      await owner.goto(`/board/${key}`);
      await addColumn(owner, "Todo");
      await addColumn(owner, "Done");
      await addCard(owner, "Todo", "Seeded card");
      const todoId = await columnByTitle(owner, "Todo").getAttribute("data-column-id");
      const doneId = await columnByTitle(owner, "Done").getAttribute("data-column-id");
      await member.goto(`/board/${key}`);
      const todo = member.locator(`section[data-column-id="${todoId}"]`);
      const done = member.locator(`section[data-column-id="${doneId}"]`);
      await expect(todo.getByRole("heading", { name: "Todo", exact: true })).toBeVisible();
      await expect(todo.getByText("1 card", { exact: true })).toBeAttached();
      await expect(todo.locator("[data-card-id]").filter({ hasText: "Seeded card" })).toBeVisible();
      await expect(member.getByRole("button", { name: /^(Move column|Rename column|Column actions for|Add column)/ })).toHaveCount(0);
      await todo.getByRole("heading", { name: "Todo", exact: true }).click();
      await todo.getByRole("heading", { name: "Todo", exact: true }).dblclick();
      await member.getByRole("button", { name: "Keyboard shortcuts", exact: true }).focus();
      await member.keyboard.press("c");
      await settleAnimationFrames(member);
      await expect(member.locator("section header input")).toHaveCount(0);
      await expect(member.getByTestId("column-drag-preview")).toHaveCount(0);
      await expect(member.locator("section header h2")).toHaveText(["Todo", "Done"]);
      await member.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
      const help = member.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
      await expect(help).not.toContainText("Add column");
      await expect(help).not.toContainText("rename");
      await member.keyboard.press("Escape");
      // Card creation is a plain member's to use: the column's own Add card opens the form.
      await todo.getByRole("button", { name: "Add card", exact: true }).click();
      const createDialog = member.getByRole("dialog", { name: "Create a card" });
      await createDialog.getByLabel("Title").fill("Member card");
      await createDialog.getByRole("button", { name: "Create card" }).click();
      await expect(createDialog).toHaveCount(0);
      const card = todo.locator("[data-card-id]").filter({ hasText: "Member card" });
      await card.click();
      const modal = member.getByRole("dialog");
      await modal.getByRole("button", { name: "Edit title", exact: true }).click();
      await modal.getByLabel("Card title").fill("Member edited card");
      await modal.getByRole("button", { name: "Save title & description", exact: true }).click();
      await expect(modal).toHaveCount(0);
      const edited = todo.locator("[data-card-id]").filter({ hasText: "Member edited card" });
      const [todoBox, doneBox] = await Promise.all([todo.boundingBox(), done.boundingBox()]);
      expect(todoBox).not.toBeNull();
      expect(doneBox).not.toBeNull();
      const moveTowardDone =
        Math.abs(doneBox!.x - todoBox!.x) >= Math.abs(doneBox!.y - todoBox!.y)
          ? "ArrowRight"
          : "ArrowDown";
      await edited.focus();
      await member.keyboard.press("Space");
      await expect(member.getByTestId("card-drag-preview")).toBeVisible();
      await member.keyboard.press(moveTowardDone);
      await settleAnimationFrames(member);
      await member.keyboard.press("Space");
      await expect(done.locator("[data-card-id]").filter({ hasText: "Member edited card" })).toBeVisible();
      // Empty the source through the permitted card path, then pointer-drop back.
      await todo.locator("[data-card-id]").filter({ hasText: "Seeded card" }).click();
      await member.getByRole("dialog").getByRole("button", { name: "Delete card", exact: true }).click();
      await member.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
      await expect(member.getByRole("dialog")).toHaveCount(0);
      await expect(todo.locator("[data-card-id]")).toHaveCount(0);
      await dragCardTo(member, done.locator("[data-card-id]").filter({ hasText: "Member edited card" }), todo.locator("ul").first());
      for (const page of [owner, member]) {
        const source = page.locator(`section[data-column-id="${todoId}"]`);
        await expect(source.locator("[data-card-id]").filter({ hasText: "Member edited card" })).toBeVisible();
        await expect(page.locator("section header h2")).toHaveText(["Todo", "Done"]);
        await page.reload();
        await expect(source.locator("[data-card-id]").filter({ hasText: "Member edited card" })).toBeVisible();
        await expect(page.locator("section header h2")).toHaveText(["Todo", "Done"]);
      }
    } finally {
      await ownerContext.close();
      await memberContext.close();
    }
  });

  test("non-admin owners and outside admins can manage columns", async ({ browser }) => {
    const adminContext = await browser.newContext();
    const ownerContext = await browser.newContext();
    try {
      const admin = await adminContext.newPage();
      const owner = await ownerContext.newPage();
      await signup(admin, uniqueEmail("column-outside-admin"));
      const { token } = await generateAccountInvite(admin);
      await signup(owner, uniqueEmail("column-ordinary-owner", "user.test"), "Ordinary Owner", token);
      expect(await (await owner.request.get("/me")).json()).toMatchObject({ isAdmin: false });
      const adminUser = await (await admin.request.get("/me")).json();
      expect(adminUser.isAdmin).toBe(true);
      const name = `Managed columns ${Date.now()}`;
      const key = await createBoard(owner, name);
      const uuid = await getBoardUuid(owner, name);
      const { members } = await (await admin.request.get(`/boards/${uuid}/members`)).json();
      expect(members.some((member: { id: string }) => member.id === adminUser.id)).toBe(false);
      await owner.goto(`/board/${key}`);
      await addColumn(owner, "Surviving");
      await admin.goto(`/board/${key}`);
      await expect(columnByTitle(admin, "Surviving")).toBeVisible();
      for (const [index, manager] of [owner, admin].entries()) {
        const title = `Managed ${index}`;
        const renamed = `Renamed ${index}`;
        await addColumn(manager, title);
        const id = await columnByTitle(manager, title).getAttribute("data-column-id");
        const section = manager.locator(`section[data-column-id="${id}"]`);
        await section.getByRole("button", { name: `Rename column ${title}`, exact: true }).click();
        await section.locator("header input").fill(renamed);
        await section.locator("header input").press("Enter");
        await section.getByRole("button", { name: `Move column ${renamed}`, exact: true }).focus();
        await manager.keyboard.press("Space");
        await expect(manager.getByTestId("column-drag-preview")).toBeVisible();
        // KeyboardSensor installs its key listener in the next event loop;
        // the preview can render before that listener and measurements are ready.
        await settleAnimationFrames(manager);
        await manager.keyboard.press("ArrowLeft");
        await settleAnimationFrames(manager);
        await manager.keyboard.press("Space");
        for (const peer of [owner, admin]) {
          await expect(peer.locator("section header h2")).toHaveText([renamed, "Surviving"]);
          await peer.reload();
          await expect(peer.locator("section header h2")).toHaveText([renamed, "Surviving"]);
        }
        await section.getByRole("button", { name: `Column actions for ${renamed}`, exact: true }).click();
        await manager.getByRole("menuitem", { name: "Delete", exact: true }).click();
        await manager.getByRole("alertdialog").getByRole("button", { name: "Delete column", exact: true }).click();
        for (const peer of [owner, admin]) {
          await expect(peer.locator("section header h2")).toHaveText(["Surviving"]);
          await peer.reload();
          await expect(peer.locator("section header h2")).toHaveText(["Surviving"]);
        }
      }
    } finally {
      await ownerContext.close();
      await adminContext.close();
    }
  });

  test("accessible column rename with button trigger, keyboard Enter/Space, select-all, Escape cancellation, and focus restoration", async ({
    page,
  }) => {
    await signup(page, uniqueEmail("col-rename"), "Column User");
    const boardKey = await createBoard(page, `Rename Board ${Date.now()}`);
    await page.goto(`/board/${boardKey}`);

    await addColumn(page, "Original Title");
    const initialSection = columnByTitle(page, "Original Title");
    const columnId = await initialSection.getAttribute("data-column-id");
    expect(columnId).toBeTruthy();
    // Stable locator that does not rely on title button presence during title editing
    const section = page.locator(`section[data-column-id="${columnId}"]`);

    // Accessible rename button trigger named "Rename column <title>"
    const renameTrigger = section.getByRole("button", { name: "Rename column Original Title" });
    await expect(renameTrigger).toBeVisible();

    // 1. Enter or Space enters edit mode and selects all text
    await renameTrigger.focus();
    await page.keyboard.press("Enter");

    const input = section.locator("header input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // Typing immediately replaces selected text
    await page.keyboard.type("Updated Title");

    // 2. Escape cancels without sending and restores focus to rename button
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Rename column Original Title", exact: true })).toBeVisible();
    await expect(renameTrigger).toBeFocused();

    // 3. Re-enter via Space, type new title, commit with Enter
    await page.keyboard.press("Space");
    await expect(input).toBeVisible();
    await page.keyboard.type("Confirmed Title");
    await page.keyboard.press("Enter");

    await expect(input).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Rename column Confirmed Title", exact: true })).toBeVisible();
    const newRenameTrigger = section.getByRole("button", { name: "Rename column Confirmed Title" });
    await expect(newRenameTrigger).toBeFocused();
  });

  test("column reordering with dedicated drag handle, keyboard sensor Left/Right, live sync and reload persistence", async ({
    page,
  }) => {
    await signup(page, uniqueEmail("col-dnd"), "ColDnD User");
    const boardKey = await createBoard(page, `DnD Board ${Date.now()}`);
    await page.goto(`/board/${boardKey}`);

    await addColumn(page, "First Col");
    await addColumn(page, "Second Col");
    await addColumn(page, "Third Col");

    // Reload page to ensure all three created columns have settled through the socket lifecycle
    await page.reload();
    await expect(page.getByText(/^(Live|reconnecting…)$/)).toHaveText("Live");

    const col1 = columnByTitle(page, "First Col");
    await expect(col1).toBeVisible();
    // Dedicated drag handle exists on column with accessible name "Move column <title>"
    const handle1 = col1.getByRole("button", { name: "Move column First Col" });
    await expect(handle1).toBeVisible();

    // Move First Col to the right using keyboard accessibility
    await handle1.focus();
    await expect(handle1).toBeFocused();
    await page.keyboard.press("Space"); // Lift
    const preview = page.getByTestId("column-drag-preview");
    await expect(preview).toBeVisible();
    const initialBox = await preview.boundingBox();
    expect(initialBox).not.toBeNull();

    // Press ArrowRight to move past Second Col and wait for preview to shift rightwards
    await page.keyboard.press("ArrowRight");
    await expect(async () => {
      const currentBox = await preview.boundingBox();
      expect(currentBox).not.toBeNull();
      expect(currentBox!.x).toBeGreaterThan(initialBox!.x);
    }).toPass();

    await page.keyboard.press("Space"); // Drop
    await expect(preview).toHaveCount(0);
    const allHeaders = page.locator("section header h2");
    await expect(allHeaders.nth(0)).toContainText("Second Col");
    await expect(allHeaders.nth(1)).toContainText("First Col");
    await expect(allHeaders.nth(2)).toContainText("Third Col");

    // Reload page to verify persistence across sessions
    await page.reload();
    const headersAfterReload = page.locator("section header h2");
    await expect(headersAfterReload.nth(0)).toContainText("Second Col");
    await expect(headersAfterReload.nth(1)).toContainText("First Col");
    await expect(headersAfterReload.nth(2)).toContainText("Third Col");
  });

  test("column reordering follows the axis the row is laid out on", async ({ page }) => {
    // Above the 600px stacking breakpoint the columns still run left to right,
    // so the horizontal key reorders them and the vertical one does nothing.
    await page.setViewportSize({ width: 700, height: 800 });
    await signup(page, uniqueEmail("col-axis"), "Column Axis User");
    const boardKey = await createBoard(page, `Axis Board ${Date.now()}`);
    await page.goto(`/board/${boardKey}`);
    await addColumn(page, "First Col");
    await addColumn(page, "Second Col");
    await page.reload();
    await expect(page.getByText(/^(Live|reconnecting…)$/)).toHaveText("Live");

    const firstHandle = columnByTitle(page, "First Col").getByRole("button", {
      name: "Move column First Col",
    });
    const columnOrder = () =>
      page
        .locator("[data-column-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-column-title")));

    await firstHandle.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("column-drag-preview")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("column-drag-preview")).toHaveCount(0);
    expect(await columnOrder()).toEqual(["First Col", "Second Col"]);

    await firstHandle.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect.poll(columnOrder).toEqual(["Second Col", "First Col"]);

    await page.reload();
    await expect.poll(columnOrder).toEqual(["Second Col", "First Col"]);
  });

  test("mobile touch: stacked full-width columns keep aligned geometry with no horizontal overflow, a reachable footer, 16px inputs, and card drag between columns", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: mobileViewport,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    await signup(page, uniqueEmail("col-mobile"), "Column Mobile User");
    const boardKey = await createBoard(page, `Mobile Cols ${Date.now()}`);
    await page.goto(`/board/${boardKey}`);

    // Create three columns
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
    await addColumn(page, "Col One");
    await addColumn(page, "Col Two");

    const colOne = columnByTitle(page, "Col One");
    const colTwo = columnByTitle(page, "Col Two");
    const addColumnBtn = page.getByRole("button", { name: "Add column", exact: true });

    // 1. The columns and the Add column control are one aligned, full-width stack:
    //    same x, same width, and each below the previous without overlapping.
    const [oneBox, twoBox, addBox] = await Promise.all([
      colOne.boundingBox(),
      colTwo.boundingBox(),
      addColumnBtn.boundingBox(),
    ]);
    expect(oneBox).not.toBeNull();
    expect(twoBox).not.toBeNull();
    expect(addBox).not.toBeNull();
    for (const box of [oneBox!, twoBox!, addBox!]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(mobileViewport.width + 1);
      expect(box.width).toBeGreaterThan(300);
    }
    expect(Math.abs(oneBox!.x - twoBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(oneBox!.width - twoBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(oneBox!.width - addBox!.width)).toBeLessThanOrEqual(1);
    expect(twoBox!.y).toBeGreaterThanOrEqual(oneBox!.y + oneBox!.height);
    expect(addBox!.y).toBeGreaterThanOrEqual(twoBox!.y + twoBox!.height);

    // 2. The board scrolls vertically on the document, and never sideways.
    await addColumnBtn.scrollIntoViewIfNeeded();
    await expect(addColumnBtn).toBeVisible();
    const pageHasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(pageHasHorizontalOverflow).toBe(false);

    // 3. A tall card list keeps the column's footer Add card reachable.
    for (const title of ["Tall card 1", "Tall card 2", "Tall card 3", "Tall card 4"]) {
      await addCard(page, "Col One", title);
    }
    const colOneFooter = colOne.getByRole("button", { name: "Add card", exact: true });
    await colOneFooter.scrollIntoViewIfNeeded();
    await expect(colOneFooter).toBeVisible();

    // 4. The create form's own controls are 16px, so focusing one never zooms the page.
    await colOneFooter.click();
    const createDialog = page.getByRole("dialog", { name: "Create a card" });
    const titleInput = createDialog.getByLabel("Title");
    await expect(titleInput).toBeFocused();
    const dialogFontSize = await titleInput.evaluate((el) => window.getComputedStyle(el).fontSize);
    expect(parseFloat(dialogFontSize)).toBeGreaterThanOrEqual(16);
    await createDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(createDialog).toHaveCount(0);

    // The inline rename editor keeps the same mobile font size.
    await colOne.getByRole("button", { name: "Rename column Col One" }).click();
    const titleEditor = colOne.locator("header input");
    await expect(titleEditor).toBeVisible();
    const titleFontSize = await titleEditor.evaluate((el) => window.getComputedStyle(el).fontSize);
    expect(parseFloat(titleFontSize)).toBeGreaterThanOrEqual(16);
    await page.keyboard.press("Escape");

    // 5. A touch drag moves a card from the first stacked column into the second.
    await touchDragCardTo(page, cardIn(colOne, "Tall card 1"), colTwo.locator("ul").first(), { beforeDrop: async () => { await expect(page.getByTestId("card-drag-preview")).toBeVisible(); } });
    await expect(cardIn(colTwo, "Tall card 1")).toBeVisible();

    await context.close();
  });
});
