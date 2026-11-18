import { authTest as test, expect, type Page } from "./fixtures";
import { createBoard, getBoardUuid, columnByTitle, dragCardTo, touchDragCardTo, settleAnimationFrames } from "./helpers";

const body = (page: Page, id: string) => page.locator(`[data-card-body="${id}"]`);
async function longFamily(page: Page) {
  const name = `Long family drag ${Date.now()}`;
  await createBoard(page, name);
  const id = await getBoardUuid(page, name);
  await page.getByRole("link", { name, exact: true }).click();
  // Seed only this test's newly created board through the actual BoardDO socket.
  await page.evaluate(async ({ id }) => {
    const socket = new WebSocket(`${location.origin.replace("http", "ws")}/boards/${id}/ws?realtimeVersion=11`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("fixture socket failed")), { once: true });
      socket.addEventListener("message", function ready(event) {
        if (JSON.parse(event.data).type === "snapshot") { socket.removeEventListener("message", ready); resolve(); }
      });
    });
    const send = async (data: Record<string, unknown>) => {
      const mutationId = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const receive = (event: MessageEvent) => {
          const message = JSON.parse(event.data);
          if (message.type === "error") { socket.removeEventListener("message", receive); reject(new Error(message.error ?? message.message)); }
          if (message.mutationId === mutationId) { socket.removeEventListener("message", receive); resolve(); }
        };
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ ...data, mutationId }));
      });
    };
    for (const [columnId, title, position] of [["todo", "Todo", "a0"], ["work", "Work", "a1"], ["done", "Done", "a2"]]) await send({ type: "column.create", id: columnId, title, position });
    // The roles follow the board's ends: todo starts work and done finishes it.
    await send({ type: "card.create", id: "parent", title: "Long parent", columnId: "todo", position: "a0" });
    // Interleaved root and child keys expose visual-order versus flat-order bugs.
    await send({ type: "card.create", id: "root", title: "Unrelated root", columnId: "todo", position: "a1" });
    for (let n = 0; n < 20; n++) await send({ type: "subtask.create", id: `child-${n}`, relationId: `relation-${n}`, parentCardId: "parent", title: `Child ${n}`, position: `a${"23456789ABCDEFGHIJKL"[n]}` });
    await send({ type: "subtask.create", id: "return", relationId: "return-relation", parentCardId: "parent", title: "Returning child", position: "as" });
    await send({ type: "card.move", id: "return", columnId: "work", position: "a0" });
    socket.close();
  }, { id });
  await expect(body(page, "child-19")).toBeAttached();
  return name;
}

async function lift(page: Page, id: string) {
  await body(page, id).scrollIntoViewIfNeeded();
  const rect = (await body(page, id).boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  // Let the down event reach the browser before crossing the sensor threshold.
  await settleAnimationFrames(page);
  await page.mouse.move(rect.x + rect.width / 2 + 8, rect.y + rect.height / 2 + 8);
  await expect(page.getByTestId("card-drag-preview")).toBeVisible();
}

for (const id of ["parent", "child-2"]) {
  test(`cancelled ${id} pointer drag ignores a delayed release click but permits fresh activation`, async ({ page }) => {
    await page.clock.install();
    await longFamily(page);
    const source = body(page, id);
    const preview = page.getByTestId("card-drag-preview");
    await lift(page, id);
    await page.keyboard.press("Escape");
    // Reproduce a held mouse button outliving dnd-kit's 50ms document guard.
    // Advance the actual timer contract rather than relying on machine load.
    await page.clock.fastForward(51);
    await page.mouse.up();
    await settleAnimationFrames(page);
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await source.click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.getByRole("button", { name: "Close card", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await source.focus();
    await page.keyboard.press("Space");
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });
}

test("long families: compact lift, self-drop, child reorder, return, root boundaries and independent parent moves", async ({ page }) => {
  test.setTimeout(90_000);
  await longFamily(page);
  await lift(page, "parent");
  const preview = page.getByTestId("card-drag-preview");
  expect((await preview.boundingBox())!.height).toBeLessThan(320);
  await expect(preview.locator("[data-card-title='Child 0']")).toHaveCount(0);
  await expect(page.locator("[data-drop-placement]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/long-family-lift.png" });
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const childOrder = () => page.locator("#subtask-family-parent [data-card-body]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-card-body")));
  const before = await childOrder();
  await lift(page, "child-2"); await page.mouse.up();
  expect(await childOrder()).toEqual(before);
  await dragCardTo(page, body(page, "child-2"), body(page, "child-0").locator("[data-card-title]"));
  await expect.poll(childOrder).toEqual(["child-2", "child-0", "child-1", ...before.slice(3)]);
  await expect(page.locator(".board-card-item").filter({ has: body(page, "parent") }).first()).not.toHaveAttribute("style", /transform/);
  await body(page, "parent").scrollIntoViewIfNeeded();
  await dragCardTo(page, body(page, "return"), body(page, "parent"));
  await expect(page.locator("#subtask-family-parent [data-card-body='return']")).toBeAttached();
  // A root dropped on a visible child targets the containing family boundary.
  await lift(page, "root");
  await body(page, "child-0").scrollIntoViewIfNeeded();
  const target = (await body(page, "child-0").boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.up();
  await expect.poll(() => columnByTitle(page, "Todo").locator(":scope > ul > li [data-card-body]").evaluateAll(nodes => nodes[0]?.getAttribute("data-card-body"))).toBe("root");
  await body(page, "root").focus(); await page.keyboard.press("Space");
  await expect(preview).toBeVisible();
  // KeyboardSensor attaches after lift; measurements settle on the next frame.
  await settleAnimationFrames(page);
  await page.keyboard.press("ArrowDown");
  await settleAnimationFrames(page);
  await page.keyboard.press("Space");
  await expect.poll(() => columnByTitle(page, "Todo").locator(":scope > ul > li [data-card-body]").evaluateAll(nodes => nodes[0]?.getAttribute("data-card-body"))).toBe("parent");
  await body(page, "root").focus(); await page.keyboard.press("Space");
  await expect(preview).toBeVisible();
  await settleAnimationFrames(page);
  await page.keyboard.press("ArrowUp");
  await settleAnimationFrames(page);
  await page.keyboard.press("Space");
  await expect.poll(() => columnByTitle(page, "Todo").locator(":scope > ul > li [data-card-body]").evaluateAll(nodes => nodes[0]?.getAttribute("data-card-body"))).toBe("root");
  await body(page, "parent").scrollIntoViewIfNeeded();
  await dragCardTo(page, body(page, "parent"), columnByTitle(page, "Done").locator("ul").first());
  await page.waitForTimeout(60); // dnd-kit drop-click suppression ends after 50ms.
  await page.getByRole("dialog", { name: "Finish “Long parent”?" }).getByRole("button", { name: "Finish only parent", exact: true }).click();
  await expect(columnByTitle(page, "Done").locator("[data-card-body='parent']")).toBeVisible();
  await expect(columnByTitle(page, "Todo").locator("[data-card-body='child-0']")).toBeAttached();
  await page.reload();
  await expect(columnByTitle(page, "Done").locator("[data-card-body='parent']")).toBeVisible();
  await expect(columnByTitle(page, "Todo").locator("[data-card-body='return']")).toBeAttached();
});

test("long families: edge scrolling and keyboard child cross-column move", async ({ page }) => {
  test.setTimeout(90_000);
  await longFamily(page);
  await lift(page, "child-0");
  const canvas = page.locator(".board-canvas");
  const rect = (await canvas.boundingBox())!;
  const start = await canvas.evaluate(node => node.scrollTop);
  await page.mouse.move(rect.x + 160, rect.y + rect.height - 6);
  await expect.poll(() => canvas.evaluate(node => node.scrollTop)).toBeGreaterThan(start + 40);
  await page.keyboard.press("Escape"); await page.mouse.up();
  await body(page, "child-19").scrollIntoViewIfNeeded();
  await body(page, "child-19").focus(); await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(columnByTitle(page, "Work").locator("[data-card-body='child-19']")).toBeAttached();
});

test("touch long-family drag and repeated keyboard column navigation", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const name = await longFamily(page);
  const touchContext = await browser.newContext({ baseURL: page.url(), storageState: await page.context().storageState(), hasTouch: true, viewport: { width: 1024, height: 768 } });
  const touch = await touchContext.newPage(); await touch.goto(page.url());
  await expect(touch.getByRole("heading", { name, exact: true })).toBeVisible();
  await touchDragCardTo(touch, body(touch, "child-0"), columnByTitle(touch, "Work").locator("ul").first(), { beforeDrop: async () => {
    expect((await touch.getByTestId("card-drag-preview").boundingBox())!.height).toBeLessThan(320);
  } });
  await expect(columnByTitle(touch, "Work").locator("[data-card-body='child-0']")).toBeVisible();
  await touchContext.close();
  const grip = page.getByRole("button", { name: "Move column Todo", exact: true });
  await grip.scrollIntoViewIfNeeded(); await grip.focus(); await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space");
  await expect.poll(() => page.locator(".board-column-heading h2").allTextContents()).toEqual(["Work", "Done", "Todo"]);
});


test("interior sibling gaps preserve the visible boundary and clipped outside-canvas drops cancel", async ({ page }) => {
  test.setTimeout(90_000);
  await longFamily(page);
  const order = () => page.locator("#subtask-family-parent [data-card-body]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-card-body")));
  const initial = await order();
  await lift(page, "child-5");
  await body(page, "child-0").scrollIntoViewIfNeeded();
  const first = (await body(page, "child-0").boundingBox())!;
  const next = (await body(page, "child-1").boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, (first.y + first.height + next.y) / 2);
  await expect(page.locator("[data-drop-placement='after']").filter({ has: body(page, "child-0") })).toHaveCount(1);
  await page.mouse.up();
  const expected = ["child-0", "child-5", ...initial.slice(1).filter(id => id !== "child-5")];
  await expect.poll(order).toEqual(expected);
  await lift(page, "child-19");
  const canvas = (await page.locator(".board-canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 150, canvas.y - 10);
  await expect(page.locator("[data-drop-placement]")).toHaveCount(0);
  await page.mouse.up();
  expect(await order()).toEqual(expected);
});

test("narrow touch viewport: quick swipe scrolls and long press reorders within a long family", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const name = await longFamily(page);
  const context = await browser.newContext({ storageState: await page.context().storageState(), hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const mobile = await context.newPage(); await mobile.goto(page.url());
  await expect(mobile.getByRole("heading", { name, exact: true })).toBeVisible();
  await body(mobile, "child-4").scrollIntoViewIfNeeded();
  const rect = (await body(mobile, "child-4").boundingBox())!;
  const cdp = await context.newCDPSession(mobile);
  const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
  const startScroll = await mobile.evaluate(() => window.scrollY);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 100, id: 0 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(mobile.getByTestId("card-drag-preview")).toHaveCount(0);
  await expect.poll(() => mobile.evaluate(() => window.scrollY)).toBeGreaterThan(startScroll);
  await body(mobile, "child-0").scrollIntoViewIfNeeded();
  await touchDragCardTo(mobile, body(mobile, "child-0"), body(mobile, "child-2"), { beforeDrop: async () => {
    expect((await mobile.getByTestId("card-drag-preview").boundingBox())!.height).toBeLessThan(320);
    await mobile.screenshot({ path: "test-results/long-family-mobile-drag.png" });
  } });
  await expect.poll(() => mobile.locator("#subtask-family-parent [data-card-body]").first().getAttribute("data-card-body")).not.toBe("child-0");
  await expect(mobile.getByRole("dialog")).toHaveCount(0);
  await context.close();
});


test("midpoint markers track the same target and keyboard can append after destination peers", async ({ page }) => {
  test.setTimeout(90_000);
  await longFamily(page);
  await lift(page, "child-5");
  await body(page, "child-1").scrollIntoViewIfNeeded();
  const rect = (await body(page, "child-1").boundingBox())!;
  const x = rect.x + rect.width / 2;
  await page.mouse.move(x, rect.y + rect.height / 4);
  const item = body(page, "child-1").locator("xpath=ancestor::li[1]");
  await expect(item).toHaveAttribute("data-drop-placement", "before");
  await page.mouse.move(x, rect.y + rect.height * .75);
  await expect(item).toHaveAttribute("data-drop-placement", "after");
  await page.mouse.up();
  await expect.poll(() => page.locator("#subtask-family-parent [data-card-body]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-card-body")))).toEqual(["child-0", "child-1", "child-5", "child-2", "child-3", "child-4", ...Array.from({ length: 14 }, (_, n) => `child-${n + 6}`)]);
  await body(page, "child-19").scrollIntoViewIfNeeded();
  await body(page, "child-19").focus(); await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect.poll(() => columnByTitle(page, "Work").locator("[data-card-body]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-card-body")))).toEqual(["return", "child-19"]);
});
