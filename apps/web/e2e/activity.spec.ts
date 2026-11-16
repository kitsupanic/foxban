import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addCard,
  addColumn,
  cardIn,
  columnByTitle,
  createBoard,
  inviteMember,
  signup,
  uniqueEmail,
} from "./helpers";

async function newUser(
  browser: Browser,
  suffix: string,
  name: string,
): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(suffix);
  await signup(page, email, name);
  return { page, email };
}

test("card Activity defaults to Comments and merges attributed history across views and reloads", async ({
  browser,
}) => {
  const ada = await newUser(browser, "activity-ada", "Ada Alpha");
  const bo = await newUser(browser, "activity-bo", "Bo Beta");
  const boardName = `Activity ${Date.now()}`;
  const boardId = await createBoard(ada.page, boardName);
  await inviteMember(ada.page, boardName, bo.email);

  await ada.page.goto(`/board/${boardId}`);
  await expect(ada.page.getByRole("button", { name: "Add column", exact: true })).toBeVisible();
  await addColumn(ada.page, "Todo");
  await addCard(ada.page, "Todo", "Activity card");
  await cardIn(columnByTitle(ada.page, "Todo"), "Activity card").click();
  const adaDialog = ada.page.getByRole("dialog");
  await expect(adaDialog.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(adaDialog.getByRole("tab", { name: /^Comments · \d+$/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    adaDialog.getByRole("button", { name: "Sort activity by date: Oldest first" }),
  ).toBeVisible();

  await bo.page.goto(`/board/${boardId}`);
  await cardIn(columnByTitle(bo.page, "Todo"), "Activity card").click();
  const boDialog = bo.page.getByRole("dialog");
  await expect(boDialog).toBeVisible();
  await expect(boDialog.getByRole("tab", { name: /^Comments · \d+$/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    boDialog.getByRole("button", { name: "Sort activity by date: Oldest first" }),
  ).toBeVisible();

  await boDialog.getByRole("button", { name: "Priority" }).click();
  await boDialog.getByRole("option", { name: "High", exact: true }).click();
  const priorityActivity = adaDialog.getByText(
    "Bo Beta changed priority from Medium to High",
    { exact: true },
  );
  await expect(priorityActivity).toHaveCount(0);
  await adaDialog.getByRole("tab", { name: /^All · \d+$/ }).click();
  await expect(priorityActivity).toBeVisible();

  await adaDialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await adaDialog
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("**important** update");
  await adaDialog.getByRole("button", { name: "Comment", exact: true }).click();

  await adaDialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  await adaDialog
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("follow-up update");
  await adaDialog.getByRole("button", { name: "Comment", exact: true }).click();
  const boComment = boDialog.getByRole("listitem").filter({ hasText: "important update" });
  await expect(boComment.locator("strong")).toHaveText("important");
  await expect(
    boDialog.getByRole("listitem").filter({ hasText: "follow-up update" }),
  ).toBeVisible();

  const boSortButton = boDialog.getByRole("button", {
    name: "Sort activity by date: Oldest first",
  });
  await expect(boSortButton).toBeVisible();
  let commentsRows = await boDialog
    .getByRole("tabpanel")
    .getByRole("listitem")
    .allTextContents();
  let importantIndex = commentsRows.findIndex((text) =>
    text.includes("important update"),
  );
  let followUpIndex = commentsRows.findIndex((text) =>
    text.includes("follow-up update"),
  );
  expect(importantIndex).toBeGreaterThanOrEqual(0);
  expect(followUpIndex).toBeGreaterThan(importantIndex);

  await boSortButton.click();
  const boNewestFirstButton = boDialog.getByRole("button", {
    name: "Sort activity by date: Newest first",
  });
  await expect(boNewestFirstButton).toBeVisible();

  commentsRows = await boDialog
    .getByRole("tabpanel")
    .getByRole("listitem")
    .allTextContents();
  importantIndex = commentsRows.findIndex((text) =>
    text.includes("important update"),
  );
  followUpIndex = commentsRows.findIndex((text) =>
    text.includes("follow-up update"),
  );
  expect(followUpIndex).toBeGreaterThanOrEqual(0);
  expect(importantIndex).toBeGreaterThan(followUpIndex);

  const historyTab = boDialog.getByRole("tab", { name: /^History · \d+$/ });
  await historyTab.click();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await expect(boNewestFirstButton).toBeVisible();
  const historyRows = await boDialog
    .getByRole("tabpanel")
    .getByRole("listitem")
    .allTextContents();
  const historyPriorityIndex = historyRows.findIndex((text) =>
    text.includes("changed priority from Medium to High"),
  );
  const historyCreatedIndex = historyRows.findIndex((text) =>
    text.includes("created this card"),
  );
  expect(historyPriorityIndex).toBeGreaterThanOrEqual(0);
  expect(historyCreatedIndex).toBeGreaterThan(historyPriorityIndex);

  const allTab = boDialog.getByRole("tab", { name: /^All · \d+$/ });
  await allTab.click();
  await expect(allTab).toHaveAttribute("aria-selected", "true");
  await expect(boNewestFirstButton).toBeVisible();
  const allRows = await boDialog
    .getByRole("tabpanel")
    .getByRole("listitem")
    .allTextContents();
  const allFollowUpIndex = allRows.findIndex((text) =>
    text.includes("follow-up update"),
  );
  const allPriorityIndex = allRows.findIndex((text) =>
    text.includes("changed priority from Medium to High"),
  );
  expect(allFollowUpIndex).toBeGreaterThanOrEqual(0);
  expect(allPriorityIndex).toBeGreaterThan(allFollowUpIndex);

  await boNewestFirstButton.click();
  await expect(boSortButton).toBeVisible();
  const initialRows = await boDialog
    .getByRole("tabpanel")
    .getByRole("listitem")
    .allTextContents();
  const initialPriorityIndex = initialRows.findIndex((text) =>
    text.includes("changed priority from Medium to High"),
  );
  const initialImportantIndex = initialRows.findIndex((text) =>
    text.includes("important update"),
  );
  expect(initialPriorityIndex).toBeGreaterThanOrEqual(0);
  expect(initialImportantIndex).toBeGreaterThan(initialPriorityIndex);

  await boDialog.getByRole("textbox", { name: "Add a comment", exact: true }).click();
  const draft = boDialog.getByRole("textbox", { name: "Comment", exact: true });
  await draft.fill("draft survives tabs");
  await historyTab.click();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await expect(boDialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(boDialog.getByText("important", { exact: true })).toHaveCount(0);
  await expect(
    boDialog.getByText("Bo Beta changed priority from Medium to High", { exact: true }),
  ).toBeVisible();

  // Tab order: All -> Comments -> History
  await historyTab.press("ArrowRight");
  await expect(allTab).toBeFocused();
  await expect(allTab).toHaveAttribute("aria-selected", "true");
  await allTab.press("End");
  await expect(historyTab).toBeFocused();
  await historyTab.press("Home");
  await expect(allTab).toBeFocused();
  await allTab.press("ArrowRight");
  const commentsTab = boDialog.getByRole("tab", { name: /^Comments · \d+$/ });
  await expect(commentsTab).toBeFocused();
  await expect(commentsTab).toHaveAttribute("aria-selected", "true");
  await commentsTab.press("ArrowRight");
  await expect(historyTab).toBeFocused();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await commentsTab.click();
  await expect(
    boDialog.getByText("Bo Beta changed priority from Medium to High", { exact: true }),
  ).toHaveCount(0);
  await expect(boDialog.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
    "draft survives tabs",
  );
  await boDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  const adaComment = adaDialog.getByRole("listitem").filter({ hasText: "important update" });
  await adaComment.getByRole("button", { name: "Edit comment" }).click();
  await adaDialog
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("**revised** update");
  await adaDialog.getByRole("button", { name: "Save comment" }).click();
  await expect(boDialog.getByRole("listitem").filter({ hasText: "revised update" })).toBeVisible();
  await expect(adaDialog.getByText("Ada Alpha edited a comment", { exact: true })).toBeVisible();

  const bobsView = boDialog.getByRole("listitem").filter({ hasText: "revised update" });
  await bobsView.getByRole("button", { name: "Delete comment" }).click();
  await expect(adaDialog.getByRole("listitem").filter({ hasText: "revised update" })).toHaveCount(0);
  await expect(adaDialog.getByText("Bo Beta deleted a comment", { exact: true })).toBeVisible();
  const adaSortButton = adaDialog.getByRole("button", {
    name: "Sort activity by date: Oldest first",
  });
  await adaSortButton.click();
  await expect(
    adaDialog.getByRole("button", {
      name: "Sort activity by date: Newest first",
    }),
  ).toBeVisible();

  await ada.page.reload();
  const reloadedDialog = ada.page.getByRole("dialog");
  await expect(reloadedDialog).toBeVisible();
  const reloadedCommentsTab = reloadedDialog.getByRole("tab", { name: /^Comments · \d+$/ });
  await expect(reloadedCommentsTab).toHaveAttribute("aria-selected", "true");
  await expect(
    reloadedDialog.getByRole("button", {
      name: "Sort activity by date: Oldest first",
    }),
  ).toBeVisible();
  await expect(
    reloadedDialog.getByText("Bo Beta changed priority from Medium to High", { exact: true }),
  ).toHaveCount(0);
  await reloadedDialog.getByRole("tab", { name: /^All · \d+$/ }).click();
  await expect(
    reloadedDialog.getByText("Bo Beta changed priority from Medium to High", { exact: true }),
  ).toBeVisible();
  await expect(reloadedDialog.getByText("Ada Alpha edited a comment", { exact: true })).toBeVisible();
  await expect(reloadedDialog.getByText("Bo Beta deleted a comment", { exact: true })).toBeVisible();
  const reloadedRows = await reloadedDialog
    .getByRole("tabpanel")
    .getByRole("listitem")
    .allTextContents();
  const priorityIndex = reloadedRows.findIndex((text) =>
    text.includes("changed priority from Medium to High"),
  );
  const editIndex = reloadedRows.findIndex((text) => text.includes("edited a comment"));
  const deleteIndex = reloadedRows.findIndex((text) => text.includes("deleted a comment"));
  expect(priorityIndex).toBeGreaterThanOrEqual(0);
  expect(editIndex).toBeGreaterThan(priorityIndex);
  expect(deleteIndex).toBeGreaterThan(editIndex);

  await ada.page.setViewportSize({ width: 375, height: 667 });
  for (const name of ["All", "Comments", "History"] as const) {
    const tab = reloadedDialog.getByRole("tab", { name: new RegExp(`^${name} · \\d+$`) });
    await tab.click();
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  const mobileSortButton = reloadedDialog.getByRole("button", {
    name: "Sort activity by date: Oldest first",
  });
  await expect(mobileSortButton).toBeVisible();
  await mobileSortButton.click();
  await expect(
    reloadedDialog.getByRole("button", {
      name: "Sort activity by date: Newest first",
    }),
  ).toBeVisible();
  const documentWidth = await ada.page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(documentWidth.scroll).toBe(documentWidth.client);
  const dialogWidth = await reloadedDialog.evaluate((dialog) => ({
    client: dialog.clientWidth,
    scroll: dialog.scrollWidth,
  }));
  expect(dialogWidth.scroll).toBe(dialogWidth.client);

  await ada.page.context().close();
  await bo.page.context().close();
});
