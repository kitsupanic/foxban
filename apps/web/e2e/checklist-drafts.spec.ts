import { expect, test, type Page } from "@playwright/test";
import { addCard, addColumn, cardIn, columnByTitle, createBoard, signup, uniqueEmail } from "./helpers";

async function openCard(page: Page) {
  await signup(page, uniqueEmail("checklist-draft"), "Checklist Author");
  const name = `Checklist drafts ${Date.now()}`;
  await createBoard(page, name);
  await page.getByRole("link", { name }).click();
  await addColumn(page, "Todo");
  await addCard(page, "Todo", "Checklist recovery");
  await cardIn(columnByTitle(page, "Todo"), "Checklist recovery").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add item", exact: true }).click();
  return dialog;
}

for (const lane of ["add", "edit"] as const) {
  test(`checklist ${lane} validates length and preserves rejected raw drafts`, async ({ page }) => {
    let reject = false;
    let attempts = 0;
    await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (reject && frame.type === (lane === "add" ? "checklist.create" : "checklist.update")) {
          attempts++;
          ws.send(JSON.stringify({ type: "error", mutationId: frame.mutationId, message: "Checklist save refused" }));
          return;
        }
        server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });
    const dialog = await openCard(page);
    const add = dialog.getByRole("textbox", { name: "Add checklist item", exact: true });
    if (lane === "edit") {
      await add.fill("Original item");
      await add.press("Enter");
      await expect(add).toHaveValue("");
      await add.fill("Another item");
      await add.press("Enter");
      await expect(add).toHaveValue("");
      await dialog.getByRole("button", { name: "Edit checklist item Original item", exact: true }).click();
    }
    const editor = lane === "add" ? add : dialog.getByRole("textbox", { name: "Edit checklist item text", exact: true });
    const longDraft = `  ${"x".repeat(201)}  `;
    await editor.fill(longDraft);
    await editor.press("Enter");
    await expect(editor).toHaveValue(longDraft);
    await expect(dialog.getByRole("alert")).toContainText("1–200 characters");
    if (lane === "edit") await expect(dialog.getByRole("button", { name: "Edit checklist item Another item", exact: true })).toBeDisabled();
    expect(attempts).toBe(0);
    reject = true;
    const draft = "  preserved rejected text  ";
    await editor.fill(draft);
    await editor.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("Checklist save refused");
    await expect(editor).toHaveValue(draft);
    await expect(editor).not.toHaveAttribute("readonly", "");
    if (lane === "edit") await expect(dialog.getByRole("button", { name: "Edit checklist item Another item", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(editor).toHaveValue(draft);
    reject = false;
    await editor.press("Enter");
    if (lane === "add") await expect(editor).toHaveValue("");
    else await expect(editor).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Edit checklist item preserved rejected text", exact: true })).toBeVisible();
    if (lane === "edit") {
      await dialog.getByRole("button", { name: "Edit checklist item preserved rejected text", exact: true }).click();
      await editor.fill("Discard this edit explicitly");
      await editor.press("Escape");
      await dialog.getByRole("button", { name: "Edit checklist item Another item", exact: true }).click();
      await expect(editor).toHaveValue("Another item");
    }
  });

  for (const stored of [false, true]) {
    test(`checklist ${lane} reconnect verifies ${stored ? "acceptance" : "absence and explicit retry"}`, async ({ page }) => {
      let interrupt = false;
      let holdSnapshot = false;
      let releaseSnapshot: (() => void) | undefined;
      let frames = 0;
      await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (interrupt && frame.type === (lane === "add" ? "checklist.create" : "checklist.update")) {
            frames++;
            if (!stored && !holdSnapshot) {
              holdSnapshot = true;
              ws.close({ code: 1012, reason: "checklist delivery interrupted" });
              return;
            }
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (interrupt && stored && frame.type === (lane === "add" ? "checklist.create" : "checklist.update") && !holdSnapshot) {
            holdSnapshot = true;
            ws.close({ code: 1012, reason: "checklist echo interrupted" });
            return;
          }
          if (frame.type === "snapshot" && holdSnapshot) {
            releaseSnapshot = () => ws.send(message);
            return;
          }
          ws.send(message);
        });
      });
      const dialog = await openCard(page);
      const add = dialog.getByRole("textbox", { name: "Add checklist item", exact: true });
      if (lane === "edit") {
        await add.fill("Original item");
        await add.press("Enter");
        await expect(add).toHaveValue("");
        await dialog.getByRole("button", { name: "Edit checklist item Original item", exact: true }).click();
      }
      interrupt = true;
      const editor = lane === "add" ? add : dialog.getByRole("textbox", { name: "Edit checklist item text", exact: true });
      const draft = "  retained reconnect draft  ";
      await editor.fill(draft);
      await editor.press("Enter");
      await expect(dialog.getByRole("status").filter({ hasText: "Checking whether checklist" })).toBeVisible();
      await expect(editor).toHaveValue(draft);
      await expect(editor).toHaveAttribute("readonly", "");
      await editor.press("Escape");
      await expect(editor).toHaveValue(draft);
      if (lane === "edit") await expect(add).toBeEditable();
      await expect.poll(() => Boolean(releaseSnapshot)).toBe(true);
      releaseSnapshot!();
      if (!stored) {
        await expect(dialog.getByRole("alert")).toContainText("Sync could not verify checklist save");
        await expect(editor).toHaveValue(draft);
        await expect(editor).toBeEditable();
        expect(frames).toBe(1);
        await editor.press("Enter");
      }
      if (lane === "add") await expect(editor).toHaveValue("");
      else await expect(editor).toHaveCount(0);
      expect(frames).toBe(stored ? 1 : 2);
      await expect(dialog.getByRole("button", { name: "Edit checklist item retained reconnect draft", exact: true })).toHaveCount(1);
      holdSnapshot = false;
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.reload();
      await cardIn(columnByTitle(page, "Todo"), "Checklist recovery").click();
      await expect(page.getByRole("button", { name: "Edit checklist item retained reconnect draft", exact: true })).toHaveCount(1);
    });
  }
}

test("offline checklist edit keeps the exact draft when sending fails", async ({ page }) => {
  let disconnect: (() => void) | undefined;
  let disconnected = false;
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    if (disconnected) {
      ws.close({ code: 1012, reason: "offline checklist test" });
      return;
    }
    const server = ws.connectToServer();
    disconnect = () => {
      disconnected = true;
      ws.close({ code: 1012, reason: "offline checklist test" });
    };
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });
  const dialog = await openCard(page);
  const add = dialog.getByRole("textbox", { name: "Add checklist item", exact: true });
  await add.fill("Original item");
  await add.press("Enter");
  await expect(add).toHaveValue("");
  await dialog.getByRole("button", { name: "Edit checklist item Original item", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "Edit checklist item text", exact: true });
  const draft = "  edit while disconnected  ";
  await editor.fill(draft);
  disconnect!();
  await expect(dialog.getByRole("status").filter({ hasText: "Not connected" })).toBeVisible();
  await editor.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Not connected — try again.");
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeEditable();
});

test("a deleted checklist item preserves its edit for explicit recreation", async ({ page }) => {
  let deleteItem: (() => void) | undefined;
  await page.routeWebSocket(/\/boards\/[^/]+\/ws(?:\?.*)?$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.type === "checklist.create") {
        deleteItem = () => server.send(JSON.stringify({ type: "checklist.delete", mutationId: crypto.randomUUID(), id: frame.id }));
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  const dialog = await openCard(page);
  const add = dialog.getByRole("textbox", { name: "Add checklist item", exact: true });
  await add.fill("Original item");
  await add.press("Enter");
  await expect(add).toHaveValue("");
  await dialog.getByRole("button", { name: "Edit checklist item Original item", exact: true }).click();
  const draft = "  surviving deleted item  ";
  await dialog.getByRole("textbox", { name: "Edit checklist item text", exact: true }).fill(draft);
  deleteItem!();
  const recovery = dialog.getByRole("textbox", { name: "Preserved checklist edit", exact: true });
  await expect(recovery).toHaveValue(draft);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await dialog.getByRole("button", { name: "Save as new item", exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Edit checklist item surviving deleted item", exact: true })).toHaveCount(1);
});
