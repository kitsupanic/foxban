/// <reference types="node" />
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFile } from "node:child_process";
type ToolSuccess = { ok: true; data: unknown };
type Column = { id: string; title: string };

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function successValue(value: unknown): ToolSuccess {
  const object = objectValue(value, "tool result");
  if (object.ok !== true || !("data" in object)) throw new Error("tool failed");
  return { ok: true, data: object.data };
}

function stringField(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string") throw new Error(`${field} is missing`);
  return value;
}

import { authTest as test, expect } from "./fixtures";
import { addColumn, cardBody, cardIn, columnByTitle, createBoard, getBoardUuid, PASSWORD } from "./helpers";



function transport(token: string): StreamableHTTPClientTransport {
  const apiPort = Number(process.env.API_PORT ?? 8787);
  return new StreamableHTTPClientTransport(new URL(`http://localhost:${apiPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

function runHelper(args: string[], environment: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(
    process.execPath,
    ["../api/scripts/mcp-client.mjs", ...args],
    { env: { ...process.env, ...environment } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
  );
  return promise;
}


test("MCP changes converge with browser edits", async ({ page, browser }) => {
  const boardName = `MCP convergence ${crypto.randomUUID()}`;
  const boardKey = await createBoard(page, boardName);
  const boardId = await getBoardUuid(page, boardName);
  await page.getByRole("link", { name: boardName }).click();
  await addColumn(page, "Todo");
  await addColumn(page, "Review");
  const storageState = await page.context().storageState();
  const peerContext = await browser.newContext({ storageState });
  const peer = await peerContext.newPage();
  await peer.goto(page.url());
  await expect(peer.getByRole("heading", { name: boardName, exact: true })).toBeVisible();


  const issue = await page.request.post("/me/agent-credentials", {
    data: {
      name: "E2E MCP client",
      boardIds: [boardId],
      scopes: ["boards:read", "tasks:write", "comments:write"],
      expiresInDays: 1,
      currentPassword: PASSWORD,
    },
  });
  expect(issue.status()).toBe(201);
  const issueBody = objectValue(await issue.json(), "issuance response");
  const credential = objectValue(issueBody.credential, "credential");
  const issued = { credentialId: stringField(credential, "id"), token: stringField(issueBody, "token") };
  const client = new Client({ name: "foxban-browser-e2e", version: "1.0.0" });
  await client.connect(transport(issued.token));
  try {
    const boardResult = successValue((await client.callTool({ name: "get_board", arguments: { board: { id: boardId } } })).structuredContent);
    const boardData = objectValue(boardResult.data, "board result");
    const columnsData = objectValue(boardData.columns, "columns page");
    if (!Array.isArray(columnsData.items)) throw new Error("columns are missing");
    const discovered: Column[] = columnsData.items.map((value) => {
      const column = objectValue(value, "column");
      return { id: stringField(column, "id"), title: stringField(column, "title") };
    });
    const todo = discovered.find((column) => column.title === "Todo");
    const review = discovered.find((column) => column.title === "Review");
    if (!todo || !review) throw new Error("MCP did not discover both columns");

    const operationKey = crypto.randomUUID();
    const createdCall = await client.callTool({
      name: "create_task",
      arguments: { board: { key: boardKey }, operationKey, columnId: todo.id, title: "MCP live card" },
    });
    const created = successValue(createdCall.structuredContent);
    const createdData = objectValue(created.data, "created result");
    const createdTask = objectValue(createdData.task, "created task");
    const taskId = stringField(createdTask, "id");
    await expect(cardIn(columnByTitle(page, "Todo"), "MCP live card")).toBeVisible();

    const updateOperationKey = crypto.randomUUID();
    const originalUpdate = await client.callTool({
      name: "update_task",
      arguments: { board: { id: boardId }, operationKey: updateOperationKey, task: { id: taskId }, title: "MCP and browser", description: "Visible without reload" },
    });
    await expect(cardIn(columnByTitle(page, "Todo"), "MCP and browser")).toBeVisible();
    await expect(cardIn(columnByTitle(peer, "Todo"), "MCP and browser")).toBeVisible();

    await client.callTool({
      name: "move_task",
      arguments: { board: { id: boardId }, operationKey: crypto.randomUUID(), task: { id: taskId }, columnId: review.id },
    });
    await expect(cardIn(columnByTitle(page, "Review"), "MCP and browser")).toBeVisible();

    await cardBody(cardIn(columnByTitle(page, "Review"), "MCP and browser")).click();
    const dialog = page.getByRole("dialog", { name: "MCP and browser" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("description-view").getByText("Visible without reload", { exact: true })).toBeVisible();
    await client.callTool({
      name: "add_comment",
      arguments: { board: { id: boardId }, operationKey: crypto.randomUUID(), task: { id: taskId }, body: "MCP evidence" },
    });
    await expect(dialog.getByText("MCP evidence", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Edit title" }).click();
    await dialog.getByLabel("Card title").fill("Browser newer");
    await dialog.getByRole("button", { name: "Save title & description" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(cardIn(columnByTitle(page, "Review"), "Browser newer")).toBeVisible();
    await expect(cardIn(columnByTitle(peer, "Review"), "Browser newer")).toBeVisible();
    const oldUpdateReplay = await client.callTool({
      name: "update_task",
      arguments: { board: { id: boardId }, operationKey: updateOperationKey, task: { id: taskId }, title: "MCP and browser", description: "Visible without reload" },
    });
    expect(oldUpdateReplay.structuredContent).toEqual(originalUpdate.structuredContent);
    await expect(cardIn(columnByTitle(page, "Review"), "Browser newer")).toBeVisible();

    // A subtask created through the real UI is completed and reopened from MCP, and
    // both clients follow it without a reload.
    await cardBody(cardIn(columnByTitle(page, "Review"), "Browser newer")).click();
    const cardDialog = page.getByRole("dialog", { name: "Browser newer" });
    await expect(cardDialog).toBeVisible();
    await cardDialog.getByRole("button", { name: "Add subtask" }).click();
    const subtaskComposer = cardDialog.getByLabel("Subtask title").locator("xpath=ancestor::form");
    await subtaskComposer.getByLabel("Subtask title").fill("MCP subtask");
    await subtaskComposer.getByLabel("Subtask title").press("Enter");
    await expect(cardDialog.getByRole("button", { name: "Open subtask MCP subtask" })).toBeVisible();
    // A subtask still being written keeps the card dirty, so closing would park behind the discard strip.
    await expect(cardDialog.getByRole("button", { name: "Adding…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(cardDialog).toHaveCount(0);

    const family = successValue((await client.callTool({
      name: "get_task", arguments: { board: { id: boardId }, task: { id: taskId } },
    })).structuredContent);
    const subtaskPage = objectValue(objectValue(family.data, "task read").subtasks, "subtask page");
    if (!Array.isArray(subtaskPage.items) || subtaskPage.items.length !== 1) {
      throw new Error("MCP did not read the subtask the UI created");
    }
    const subtaskId = stringField(objectValue(subtaskPage.items[0], "subtask"), "id");

    await client.callTool({
      name: "complete_subtask",
      arguments: { board: { id: boardId }, operationKey: crypto.randomUUID(), task: { id: subtaskId }, done: true },
    });
    await expect(
      cardIn(columnByTitle(page, "Review"), "Browser newer").getByRole("button", { name: /Subtasks/ }),
    ).toContainText("1 / 1");
    // Completing moves the child to the completed column (Review, where its parent is).
    await expect(columnByTitle(page, "Review").locator('[data-card-title="MCP subtask"]')).toBeVisible();
    await expect(columnByTitle(peer, "Review").locator('[data-card-title="MCP subtask"]')).toBeVisible();
    await client.callTool({
      name: "complete_subtask",
      arguments: { board: { id: boardId }, operationKey: crypto.randomUUID(), task: { id: subtaskId }, done: false },
    });
    // Reopening moves it back to the starting column (Todo).
    await expect(columnByTitle(page, "Todo").locator('[data-card-title="MCP subtask"]')).toBeVisible();
    await expect(columnByTitle(peer, "Todo").locator('[data-card-title="MCP subtask"]')).toBeVisible();

    // Ordinary label management: create a status label and an unrelated one, assign
    // both, edit the definition, then remove exactly one association.
    const createdDoing = successValue((await client.callTool({
      name: "create_label",
      arguments: {
        board: { id: boardId }, operationKey: crypto.randomUUID(), name: "status:doing", color: "amber",
      },
    })).structuredContent);
    const doingLabelId = stringField(
      objectValue(objectValue(createdDoing.data, "label result").label, "label"), "id",
    );
    const createdUnrelated = successValue((await client.callTool({
      name: "create_label",
      arguments: {
        board: { id: boardId }, operationKey: crypto.randomUUID(), name: "Unrelated", color: "green",
      },
    })).structuredContent);
    const unrelatedLabelId = stringField(
      objectValue(objectValue(createdUnrelated.data, "label result").label, "label"), "id",
    );
    for (const labelId of [doingLabelId, unrelatedLabelId]) {
      await client.callTool({
        name: "assign_label",
        arguments: { board: { id: boardId }, operationKey: crypto.randomUUID(), task: { id: taskId }, labelId },
      });
    }
    const cardPills = () => cardIn(columnByTitle(page, "Review"), "Browser newer").getByTestId("label-pill");
    const peerPills = () => cardIn(columnByTitle(peer, "Review"), "Browser newer").getByTestId("label-pill");
    await expect(cardPills()).toHaveCount(2);
    await expect(peerPills()).toHaveCount(2);

    await client.callTool({
      name: "update_label",
      arguments: {
        board: { id: boardId }, operationKey: crypto.randomUUID(),
        labelId: doingLabelId, name: "status:review", color: "blue",
      },
    });
    await expect(cardPills().filter({ hasText: "status:review" })).toBeVisible();
    await expect(peerPills().filter({ hasText: "status:review" })).toBeVisible();

    const labelled = successValue((await client.callTool({
      name: "get_task",
      arguments: { board: { id: boardId }, task: { id: taskId }, labels: { limit: 100 } },
    })).structuredContent);
    const labelPage = objectValue(objectValue(labelled.data, "task read").labels, "label page");
    if (!Array.isArray(labelPage.items)) throw new Error("MCP did not read the task labels");
    const statusJoin = labelPage.items
      .map((item) => objectValue(item, "task label"))
      .find((item) => stringField(item, "labelId") === doingLabelId);
    if (!statusJoin) throw new Error("the status label was not assigned");
    await client.callTool({
      name: "unassign_label",
      arguments: {
        board: { id: boardId }, operationKey: crypto.randomUUID(),
        task: { id: taskId }, cardLabelId: stringField(statusJoin, "id"),
      },
    });
    // Array form: the list is waited down to exactly this, not a strict single-element match.
    await expect(cardPills()).toHaveText(["Unrelated"]);
    await expect(peerPills()).toHaveText(["Unrelated"]);

    const freshContext = await browser.newContext({ storageState, viewport: { width: 375, height: 812 } });
    const fresh = await freshContext.newPage();
    await fresh.goto(page.url());
    await expect(cardIn(columnByTitle(fresh, "Review"), "Browser newer")).toBeVisible();
    await expect(columnByTitle(fresh, "Todo").locator('[data-card-title="MCP subtask"]')).toBeVisible();
    await expect(
      cardIn(columnByTitle(fresh, "Review"), "Browser newer").getByTestId("label-pill"),
    ).toHaveText("Unrelated");
    await fresh.screenshot({ path: test.info().outputPath("mcp-mobile.png"), fullPage: true });
    await freshContext.close();


    const replay = await client.callTool({
      name: "create_task",
      arguments: { board: { key: boardKey }, operationKey, columnId: todo.id, title: "MCP live card" },
    });
    expect(replay.structuredContent).toEqual(createdCall.structuredContent);
    const readOnlyIssue = await page.request.post("/me/agent-credentials", {
      data: { name: "Helper failure proof", boardIds: [boardId], scopes: ["boards:read"], expiresInDays: 1, currentPassword: PASSWORD },
    });
    expect(readOnlyIssue.status()).toBe(201);
    const readOnlyBody = objectValue(await readOnlyIssue.json(), "read-only issuance");
    const readOnlyCredential = objectValue(readOnlyBody.credential, "read-only credential");
    const helperResult = await runHelper(
      ["call", "create_task", JSON.stringify({
        board: { id: boardId }, operationKey: crypto.randomUUID(), columnId: todo.id, title: "Must not create",
      })],
      {
        FOXBAN_ORIGIN: `http://localhost:${Number(process.env.API_PORT ?? 8787)}`,
        FOXBAN_MCP_TOKEN: stringField(readOnlyBody, "token"),
      },
    );
    expect(helperResult.code).toBe(1);
    expect(helperResult.stdout).toContain("\"code\": \"forbidden\"");
    expect(helperResult.stderr).not.toContain("foxban_mcp_");
    await page.request.delete(`/me/agent-credentials/${stringField(readOnlyCredential, "id")}`);
    await expect(cardIn(columnByTitle(peer, "Review"), "Browser newer")).toBeVisible();
  } finally {
    await client.close();
    await peerContext.close();
    await page.request.delete(`/me/agent-credentials/${issued.credentialId}`);
  }
});
