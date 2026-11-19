import { authTest as test, expect, type Page } from "./fixtures";
import { createBoard, getBoardUuid, columnByTitle, dragCardTo } from "./helpers";

const body = (page: Page, id: string) => page.locator(`[data-card-body="${id}"]`);
async function send(page: Page, boardId: string, commands: Record<string, unknown>[]) {
  await page.evaluate(async ({boardId, commands}) => {
    const ws=new WebSocket(`${location.origin.replace("http","ws")}/boards/${boardId}/ws?realtimeVersion=12`);
    await new Promise<void>(resolve=>ws.addEventListener("message",function ready(event){if(JSON.parse(event.data).type==="snapshot"){ws.removeEventListener("message",ready);resolve();}}));
    for (const command of commands) {
      const mutationId=crypto.randomUUID();
      await new Promise<void>((resolve,reject)=>{const receive=(event:MessageEvent)=>{const msg=JSON.parse(event.data);if(msg.mutationId===mutationId){ws.removeEventListener("message",receive);msg.type==="error"?reject(new Error(msg.message)):resolve();}};ws.addEventListener("message",receive);ws.send(JSON.stringify({...command,mutationId}));});
    }
    ws.close();
  },{boardId,commands});
}
async function fixture(page: Page) {
  const name=`Family finish ${Date.now()}`; await createBoard(page,name); const id=await getBoardUuid(page,name); await page.getByRole("link",{name,exact:true}).click();
  await send(page,id,[
    ...[["todo","Todo","a0"],["work","Work","a1"],["done","Done","a2"]].map(([id,title,position])=>({type:"column.create",id,title,position})),
    // The roles follow the board's ends: todo starts work and done finishes it.
    {type:"card.create",id:"parent",title:"Family parent",columnId:"todo",position:"a0"},
    {type:"subtask.create",id:"child",relationId:"r1",parentCardId:"parent",title:"Todo child",position:"a1"},
    {type:"subtask.create",id:"remote",relationId:"r2",parentCardId:"parent",title:"Work child",position:"a2"},
    {type:"card.move",id:"remote",columnId:"work",position:"a0"},
    {type:"subtask.create",id:"finished",relationId:"r3",parentCardId:"parent",title:"Finished child",position:"a3"},
    {type:"card.move",id:"finished",columnId:"done",position:"a0"},
  ]); await expect(body(page,"remote")).toBeVisible(); return id;
}
async function status(page:Page,column:string){await page.getByRole("dialog",{name:"Family parent",exact:true}).getByRole("button",{name:"Status",exact:true}).click();await page.getByRole("option",{name:column,exact:true}).click();}
const choice=(page:Page)=>page.getByRole("dialog",{name:"Finish “Family parent”?",exact:true});

for (const pending of [false, true]) {
  test(`update above family completion: ${pending ? "accepted completion closes first" : "Escape closes update first"}`, async ({ page }) => {
    let stale = false;
    await page.route("**/foxban-version.json*", async (route) => {
      const current = new URL(route.request().url()).searchParams.get("current");
      await route.fulfill({ json: { buildId: stale ? "family-update-build" : current } });
    });
    await fixture(page);
    await body(page, "parent").click();
    await status(page, "Done");
    await expect(choice(page).getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    if (pending) {
      await page.evaluate(() => {
        const original = WebSocket.prototype.send;
        let held: { socket: WebSocket; data: string } | undefined;
        WebSocket.prototype.send = function(data) {
          if (typeof data === "string" && JSON.parse(data).type === "card.finish") held = { socket: this, data };
          else original.call(this, data);
        };
        Object.assign(window, { __releaseFinish: () => {
          WebSocket.prototype.send = original;
          if (!held) throw new Error("Completion was not held");
          original.call(held.socket, held.data);
        } });
      });
      await choice(page).getByRole("button", { name: "Finish all", exact: true }).click();
      await expect(choice(page).getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    }
    stale = true;
    await page.evaluate(() => window.dispatchEvent(new Event("foxban:update-check")));
    const update = page.getByRole("dialog", { name: "Foxban updated", exact: true });
    await expect(update.getByRole("button", { name: "Refresh Foxban" })).toBeFocused();
    await expect(update.getByRole("button", { name: "Refresh Foxban" })).toBeInViewport();
    await expect.poll(() => update.evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      return dialog.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await page.screenshot({ path: `test-results/family-update-${pending ? "pending" : "idle"}.png` });
    await page.keyboard.press("Tab");
    await expect(update.getByRole("button", { name: "Later", exact: true })).toBeFocused();
    if (pending) {
      await page.evaluate(() => (window as unknown as { __releaseFinish: () => void }).__releaseFinish());
      await expect(page.getByRole("dialog", { name: "Finish “Family parent”?", exact: true, includeHidden: true })).toHaveCount(0);
      await expect(page.locator("#root")).toHaveAttribute("inert", "");
      await update.getByRole("button", { name: "Later", exact: true }).click();
    } else {
      await page.keyboard.press("Escape");
      await expect(update).toHaveCount(0);
      await expect(choice(page)).toBeVisible();
      await expect(page.locator("#root")).toHaveAttribute("inert", "");
      await choice(page).getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await expect(update).toHaveCount(0);
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
    const card = page.getByRole("dialog", { name: "Family parent", exact: true });
    await card.getByRole("button", { name: "Close card", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByLabel("Search cards").fill("Family parent");
    await expect(body(page, "parent")).toBeVisible();
  });
}

test("status completion: cancel/Escape/focus, live count, Finish all, reopen and zero-open bypass",async({page})=>{
  const id=await fixture(page); await body(page,"parent").click(); await status(page,"Done");
  await expect(choice(page)).toContainText("2 unfinished subtasks"); await page.screenshot({path:"test-results/family-completion-modal.png"}); await expect(choice(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  await expect(columnByTitle(page,"Todo").locator('[data-card-body="parent"]')).toBeAttached();
  await page.keyboard.press("Tab"); await expect(choice(page).getByRole("button",{name:"Finish all",exact:true})).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(choice(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  await page.keyboard.press("Escape"); await expect(choice(page)).toHaveCount(0); await expect(page.getByRole("dialog",{name:"Family parent",exact:true}).getByRole("button",{name:"Status",exact:true})).toBeFocused();
  await status(page,"Done"); await choice(page).getByRole("button",{name:"Cancel",exact:true}).click(); await expect(choice(page)).toHaveCount(0);
  await status(page,"Done");
  await send(page,id,[{type:"subtask.create",id:"new",relationId:"r4",parentCardId:"parent",title:"Peer child",position:"a4"}]); await expect(choice(page)).toContainText("3 unfinished subtasks");
  await choice(page).getByRole("button",{name:"Finish all",exact:true}).focus(); await page.keyboard.press("Enter"); await expect(choice(page)).toHaveCount(0);
  for(const child of ["parent","child","remote","new","finished"]) await expect(columnByTitle(page,"Done").locator(`[data-card-body="${child}"]`)).toBeAttached();
  await status(page,"Todo"); await expect(columnByTitle(page,"Todo").locator('[data-card-body="parent"]')).toBeAttached(); await expect(columnByTitle(page,"Done").locator('[data-card-body="remote"]')).toBeAttached();
  await status(page,"Done"); await expect(choice(page)).toHaveCount(0); await page.keyboard.press("Escape"); await page.reload(); await expect(columnByTitle(page,"Done").locator('[data-card-body="parent"]')).toBeVisible();
});

test("drag completion: no early move, Escape returns focus, Finish only parent persists",async({page})=>{
  await fixture(page); const target=columnByTitle(page,"Done").locator("ul").first();
  await dragCardTo(page,body(page,"parent"),target); await expect(choice(page)).toContainText("2 unfinished subtasks"); await expect(columnByTitle(page,"Todo").locator('[data-card-body="parent"]')).toBeAttached();
  await page.keyboard.press("Escape"); await expect(body(page,"parent")).toBeFocused();
  await dragCardTo(page,body(page,"parent"),target); await page.waitForTimeout(60); // dnd-kit suppresses the drop click for 50ms.
  await choice(page).getByRole("button",{name:"Finish only parent",exact:true}).click();
  await expect(choice(page)).toHaveCount(0); await expect(columnByTitle(page,"Done").locator('[data-card-body="parent"]')).toBeVisible(); await expect(columnByTitle(page,"Todo").locator('[data-card-body="child"]')).toBeVisible(); await expect(columnByTitle(page,"Work").locator('[data-card-body="remote"]')).toBeVisible();
  await page.reload(); await expect(columnByTitle(page,"Todo").locator('[data-card-body="child"]')).toBeVisible();
});

test("short viewport keeps completion choices reachable",async({page})=>{
  const id=await fixture(page); await body(page,"parent").click(); await status(page,"Done"); await send(page,id,[{type:"card.update",id:"parent",title:"A long completion title ".repeat(10).slice(0,200)}]); await page.setViewportSize({width:640,height:240});
  const dialog=page.getByRole("dialog",{name:/^Finish “/});
  await dialog.getByRole("button",{name:"Finish only parent",exact:true}).scrollIntoViewIfNeeded(); const bounds=await dialog.getByRole("button",{name:"Finish only parent",exact:true}).boundingBox(); expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(240);
  await dialog.getByRole("button",{name:"Cancel",exact:true}).click(); await expect(dialog).toHaveCount(0);
});

test("concurrent change rejects held Finish all and keeps the choice recoverable",async({page})=>{
  const id=await fixture(page);
  await page.evaluate(()=>{
    const original=WebSocket.prototype.send, parked:{socket:WebSocket,data:string}[]=[];
    WebSocket.prototype.send=function(data){if(typeof data==="string" && JSON.parse(data).type==="card.finish") parked.push({socket:this,data}); else original.call(this,data);};
    Object.assign(window,{__completionHold:{count:()=>parked.length,release:()=>{WebSocket.prototype.send=original;for(const frame of parked) original.call(frame.socket,frame.data);parked.length=0;}}});
  });
  await body(page,"parent").click(); await status(page,"Done");
  await choice(page).getByRole("button",{name:"Finish all",exact:true}).click();
  await expect(choice(page).getByRole("button",{name:"Finish all",exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as unknown as {__completionHold:{count:()=>number}}).__completionHold.count())).toBe(1);
  await send(page,id,[{type:"card.move",id:"child",columnId:"work",position:"a5"}]);
  await page.evaluate(()=>(window as unknown as {__completionHold:{release:()=>void}}).__completionHold.release());
  await expect(choice(page).getByRole("alert")).toContainText("Subtasks changed");
  await expect(columnByTitle(page,"Todo").locator('[data-card-body="parent"]')).toBeAttached(); await expect(columnByTitle(page,"Work").locator('[data-card-body="child"]')).toBeAttached();
  await choice(page).getByRole("button",{name:"Cancel",exact:true}).click(); await expect(choice(page)).toHaveCount(0);
  await page.keyboard.press("Escape"); await page.reload(); await expect(columnByTitle(page,"Todo").locator('[data-card-body="parent"]')).toBeVisible();
});

test("unconfirmed completion waits for snapshot and requires an explicit new choice",async({page})=>{
  await fixture(page); await page.clock.install();
  await page.evaluate(()=>{
    const original=WebSocket.prototype.send;
    WebSocket.prototype.send=function(data){if(typeof data==="string" && JSON.parse(data).type==="card.finish")return; original.call(this,data);};
    Object.assign(window,{__restoreCompletionSend:()=>{WebSocket.prototype.send=original;}});
  });
  await body(page,"parent").click(); await status(page,"Done"); await choice(page).getByRole("button",{name:"Finish all",exact:true}).click();
  await expect(choice(page).getByRole("button",{name:"Finish all",exact:true})).toBeDisabled(); await page.clock.fastForward(5001);
  await expect(choice(page).getByRole("button",{name:"Finish all",exact:true})).toBeEnabled();
  await expect(choice(page).getByRole("alert")).toContainText("not confirmed"); await expect(columnByTitle(page,"Todo").locator('[data-card-body="parent"]')).toBeAttached();
  await page.evaluate(()=>(window as unknown as {__restoreCompletionSend:()=>void}).__restoreCompletionSend());
  await choice(page).getByRole("button",{name:"Finish only parent",exact:true}).click(); await expect(choice(page)).toHaveCount(0); await expect(columnByTitle(page,"Todo").locator('[data-card-body="child"]')).toBeAttached();
});
