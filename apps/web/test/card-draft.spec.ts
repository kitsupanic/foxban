import { expect, test } from "@playwright/test";
import type { ClientMessage } from "@foxban/shared";
import type { BoardState } from "../src/lib/apply-mutation";
import { createAuthoredScope, type AuthoredTransport } from "../src/lib/authored-operation";
import { createCardDraft } from "../src/lib/card-draft";
import type { MutationSettledStatus } from "../src/lib/socket";

// Callbacks stay reachable after unsubscribe so the tests can prove the core ignores them itself.
function fakeTransport() {
  const sends: ClientMessage[] = [];
  const subscribed: string[] = [];
  const callbacks = new Map<string, Parameters<AuthoredTransport["subscribe"]>[1]>();
  const state = { connected: true, board: undefined as BoardState | undefined };
  return {
    state,
    sends,
    ids: subscribed,
    fire(mutationId: string, status: MutationSettledStatus, error?: string) {
      callbacks.get(mutationId)?.({ mutationId, status, error });
    },
    transport: {
      send(message) {
        if (!state.connected) return false;
        sends.push(message);
        return true;
      },
      subscribe(mutationId, callback) {
        subscribed.push(mutationId);
        callbacks.set(mutationId, callback);
        return () => {};
      },
      retire: () => {},
      readBoard: () => state.board,
    } satisfies AuthoredTransport,
  };
}

function setup(seedDescription?: string) {
  const fake = fakeTransport();
  const scope = createAuthoredScope(fake.transport);
  const env = {
    card: { id: "card-1", title: "Ship it", description: "Notes" },
    // Markers removed from the description, standing in for confirmed attachment deletions.
    stripped: [] as string[],
    deletePending: false,
    keepsOpen: false,
    closed: 0,
  };
  const draft = createCardDraft(
    scope,
    {
      card: () => env.card,
      descriptionFor: (text) => env.stripped.reduce((next, marker) => next.split(marker).join(""), text),
      attachmentDeletePending: () => env.deletePending,
      keepsOpen: () => env.keepsOpen,
      close: () => void env.closed++,
    },
    { title: env.card.title, description: seedDescription ?? env.card.description },
  );
  const last = () => fake.ids[fake.ids.length - 1];
  return { fake, env, draft, last };
}

const update = (mutationId: string, fields: { title?: string; description?: string }): ClientMessage => ({
  type: "card.update",
  mutationId,
  id: "card-1",
  ...fields,
});

test("an untouched field is never sent, and an emptied title is a slip", () => {
  const { fake, draft, last } = setup();
  draft.save();
  expect(fake.sends).toEqual([]);

  draft.setDescription("Better notes");
  expect(draft.getState()).toMatchObject({ titleHasChanges: false, descriptionHasChanges: true, unsavedTextMessage: "Unsaved description" });
  draft.save();
  expect(fake.sends).toEqual([update(last(), { description: "Better notes" })]);
  fake.fire(last(), "accepted");

  // An emptied title keeps the old one: nothing to send, nothing unsaved.
  draft.setTitle("   ");
  expect(draft.getState()).toMatchObject({ title: "   ", titleHasChanges: false, hasWork: false });
  draft.save();
  expect(fake.sends).toHaveLength(1);

  // Typing the original text back is not an edit either.
  draft.setTitle("Renamed");
  expect(draft.getState().unsavedTextMessage).toBe("Unsaved title");
  draft.setTitle("Ship it");
  expect(draft.getState().titleHasChanges).toBe(false);
  draft.setDescription("Notes");
  draft.setDescription("Better notes");
  expect(draft.getState().descriptionHasChanges).toBe(false);
});

test("both edited fields go in one frame, the title trimmed", () => {
  const { fake, draft, last } = setup();
  draft.setTitle("  New title ");
  draft.setDescription("New notes");
  expect(draft.getState()).toMatchObject({ unsavedTextMessage: "Unsaved title and description", hasWork: true });
  draft.save();
  expect(fake.sends).toEqual([update(last(), { title: "New title", description: "New notes" })]);
  expect(draft.getState().saveLane).toMatchObject({ pending: true, uncertain: false, error: null, recovery: null });
  expect(draft.hasWork()).toBe(true);
});

test("a peer's update re-seeds an untouched field but not an edited one", () => {
  const { env, draft } = setup();
  draft.setDescription("Mine");
  // Only the card changes; the draft hears about it through followCard, as the hook's effect does.
  env.card = { ...env.card, title: "Peer title", description: "Peer notes" };
  draft.followCard();
  expect(draft.getState()).toMatchObject({ title: "Peer title", titleHasChanges: false, description: "Mine", descriptionHasChanges: true });

  // The untouched title keeps following, and its baseline with it; once edited it stops.
  env.card = { ...env.card, title: "Peer title 2" };
  draft.followCard();
  expect(draft.getState().title).toBe("Peer title 2");
  draft.setTitle("Peer title 2 edited");
  env.card = { ...env.card, title: "Peer title 3" };
  draft.followCard();
  expect(draft.getState()).toMatchObject({ title: "Peer title 2 edited", titleHasChanges: true, description: "Mine" });
});

test("a mount seed that differs from the card is an unsaved draft", () => {
  // A seed that reverses an optimistic attachment cleanup differs from the card, so it is unsaved work from the start.
  const { fake, draft, last } = setup("Notes with image");
  expect(draft.getState()).toMatchObject({ description: "Notes with image", descriptionHasChanges: true, hasWork: true });
  draft.save();
  expect(fake.sends).toEqual([update(last(), { description: "Notes with image" })]);
});

test("the effective description follows confirmed attachment deletions", () => {
  const { fake, env, draft, last } = setup("Notes[img-1]");
  // The strip is the same text as the card: no edit yet.
  env.stripped = ["[img-1]"];
  expect(draft.getState()).toMatchObject({ description: "Notes", descriptionHasChanges: false, hasWork: false });

  env.stripped = [];
  const embedded = draft.getState();
  expect(embedded).toMatchObject({ description: "Notes[img-1]", descriptionHasChanges: true });
  expect(draft.getState()).toBe(embedded);

  // The view changes without a notification, and the next read sees it with a new identity.
  env.stripped = ["[img-1]"];
  const stripped = draft.getState();
  expect(stripped).not.toBe(embedded);
  expect(stripped).toMatchObject({ description: "Notes", descriptionHasChanges: false });
  expect(draft.getState()).toBe(stripped);

  // Typing is compared with the text the editor shows, and what is sent is that text.
  draft.setDescription("Notes[img-2]");
  draft.save();
  expect(fake.sends).toEqual([update(last(), { description: "Notes[img-2]" })]);
});

test("Save waits for an attachment delete, an upload, a write in flight and a recovery", () => {
  const { fake, env, draft, last } = setup();
  draft.setTitle("New title");

  env.deletePending = true;
  draft.save();
  expect(fake.sends).toEqual([]);
  env.deletePending = false;

  expect(draft.beginUpload()).toBe(true);
  expect(draft.beginUpload()).toBe(false);
  expect(draft.getState()).toMatchObject({ uploading: true, hasWork: true });
  draft.save();
  expect(fake.sends).toEqual([]);
  draft.endUpload();
  expect(draft.getState().uploading).toBe(false);

  draft.save();
  draft.save();
  expect(fake.sends).toHaveLength(1);
  fake.fire(last(), "timeout");
  expect(draft.getState().saveLane).toMatchObject({ pending: true, uncertain: true });
  draft.save();
  expect(fake.sends).toHaveLength(1);
  fake.fire(last(), "verified-retry");
  expect(draft.getState().saveLane.recovery).toMatchObject({ error: "Sync could not verify save. You can retry sending.", submittedTitle: "New title" });
  draft.save();
  expect(fake.sends).toHaveLength(1);
});

test("a description over 100,000 bytes is refused without sending, until typing dismisses it", () => {
  const { fake, draft, last } = setup();
  draft.setDescription("é".repeat(50_001));
  draft.save();
  expect(fake.sends).toEqual([]);
  expect(draft.getState().saveLane).toMatchObject({ pending: false, error: "Description must be 100,000 bytes or fewer." });
  expect(draft.getState().descriptionHasChanges).toBe(true);

  draft.setDescription("x".repeat(100_000));
  draft.clearError();
  expect(draft.getState().saveLane.error).toBeNull();
  draft.save();
  expect(fake.sends).toHaveLength(1);
  expect(fake.sends[0]).toMatchObject({ type: "card.update", mutationId: last() });
});

test("a first attempt that never left is an inline error, and a rejection is a recovery that typing leaves alone", () => {
  const { fake, draft, last } = setup();
  draft.setTitle("New title");
  fake.state.connected = false;
  draft.save();
  expect(draft.getState().saveLane).toMatchObject({ pending: false, error: "Not connected — changes won't send.", recovery: null });
  draft.clearError();
  expect(draft.getState().saveLane.error).toBeNull();

  fake.state.connected = true;
  draft.save();
  fake.fire(last(), "rejected");
  expect(draft.getState().saveLane).toMatchObject({
    pending: false,
    error: null,
    recovery: { error: "Server rejected save.", submittedTitle: "New title" },
  });
  expect(draft.getState().hasWork).toBe(true);
  draft.clearError();
  expect(draft.getState().saveLane.recovery).not.toBeNull();
});

test("a retry re-diffs against the live card and drops a field a peer already saved", () => {
  const { fake, env, draft, last } = setup();
  draft.setTitle("New title");
  draft.setDescription("New notes");
  draft.save();
  fake.fire(last(), "rejected");

  env.card = { ...env.card, title: "New title" };
  draft.retry();
  expect(fake.sends).toHaveLength(2);
  expect(fake.sends[1]).toEqual(update(last(), { description: "New notes" }));
  expect(draft.getState().saveLane).toMatchObject({ pending: true, recovery: { error: "Server rejected save." } });

  // Nothing left to send once the peer saved both: the lineage settles and its recovery goes with it.
  const both = setup();
  both.draft.setTitle("New title");
  both.draft.setDescription("New notes");
  both.draft.save();
  both.fake.fire(both.last(), "rejected");
  both.env.card = { ...both.env.card, title: "New title", description: "New notes" };
  both.draft.retry();
  expect(both.fake.sends).toHaveLength(1);
  expect(both.draft.getState().saveLane).toMatchObject({ pending: false, error: null, recovery: null });
});

test("a retry after discard is not sent", () => {
  const { fake, draft, last } = setup();
  draft.setTitle("New title");
  draft.save();
  fake.fire(last(), "rejected");
  draft.discardRecovery();
  expect(draft.getState().saveLane.recovery).toBeNull();
  draft.retry();
  expect(fake.sends).toHaveLength(1);
  // The draft itself is kept and can be saved again as a new lineage.
  expect(draft.getState()).toMatchObject({ title: "New title", titleHasChanges: true });
  draft.save();
  expect(fake.sends).toHaveLength(2);
});

test("a late acceptance updates the baselines for exactly the fields its attempt carried", () => {
  // Attempt 1 carries both fields and fails as unverified; a peer then saves the same title, so the
  // retry carries only the description.
  const first = setup();
  first.draft.setTitle("New title");
  first.draft.setDescription("New notes");
  first.draft.save();
  const attempt1 = first.last();
  first.fake.fire(attempt1, "verified-retry");
  first.env.card = { ...first.env.card, title: "New title" };
  first.draft.retry();
  const attempt2 = first.last();
  expect(first.fake.sends[1]).toEqual(update(attempt2, { description: "New notes" }));

  // The retry's acceptance settles the description only: the title was not part of it.
  first.fake.fire(attempt2, "accepted");
  expect(first.draft.getState()).toMatchObject({ titleHasChanges: true, descriptionHasChanges: false, hasWork: true });
  expect(first.env.closed).toBe(0);

  // The earlier attempt, accepted late, settles both: it carried both.
  const second = setup();
  second.draft.setTitle("New title");
  second.draft.setDescription("New notes");
  second.draft.save();
  const early = second.last();
  second.fake.fire(early, "verified-retry");
  second.env.card = { ...second.env.card, title: "New title" };
  second.draft.retry();
  second.fake.fire(early, "accepted");
  expect(second.draft.getState()).toMatchObject({ titleHasChanges: false, descriptionHasChanges: false, hasWork: false });
  expect(second.env.closed).toBe(0);
});

test("acceptance clears an edited field's draft only when the field still holds what was sent", () => {
  const { fake, env, draft, last } = setup();
  draft.setTitle("New title");
  draft.setDescription("New notes");
  draft.save();
  draft.setTitle("New title, more");
  env.card = { ...env.card, description: "New notes" };
  fake.fire(last(), "accepted");

  // The title moved on after submission: it stays a draft against what was sent, and nothing closes.
  expect(draft.getState()).toMatchObject({ title: "New title, more", titleHasChanges: true, descriptionHasChanges: false });
  expect(env.closed).toBe(0);

  // The settled description follows the card again.
  env.card = { ...env.card, description: "Peer notes" };
  draft.followCard();
  expect(draft.getState().description).toBe("Peer notes");
});

test("an accepted first attempt closes the card only when nothing keeps it open and the draft is unchanged", () => {
  const closes = setup();
  closes.draft.setTitle("New title");
  closes.draft.save();
  closes.fake.fire(closes.last(), "accepted");
  expect(closes.env.closed).toBe(1);
  expect(closes.draft.getState()).toMatchObject({ titleHasChanges: false, hasWork: false });

  const kept = setup();
  kept.draft.setTitle("New title");
  kept.draft.save();
  kept.env.keepsOpen = true;
  kept.fake.fire(kept.last(), "accepted");
  expect(kept.env.closed).toBe(0);
  expect(kept.draft.getState().hasWork).toBe(false);

  const edited = setup();
  edited.draft.setDescription("New notes");
  edited.draft.save();
  edited.draft.setDescription("New notes, and more");
  edited.fake.fire(edited.last(), "accepted");
  expect(edited.env.closed).toBe(0);
  expect(edited.draft.getState()).toMatchObject({ descriptionHasChanges: true });

  // A retry's acceptance never closes.
  const retried = setup();
  retried.draft.setTitle("New title");
  retried.draft.save();
  retried.fake.fire(retried.last(), "rejected");
  retried.draft.retry();
  retried.fake.fire(retried.last(), "accepted");
  expect(retried.env.closed).toBe(0);
  expect(retried.draft.getState().hasWork).toBe(false);
});

test("a save seen uncertain or unverified never closes the card", () => {
  const uncertain = setup();
  uncertain.draft.setTitle("New title");
  uncertain.draft.save();
  uncertain.fake.fire(uncertain.last(), "timeout");
  uncertain.fake.fire(uncertain.last(), "accepted");
  expect(uncertain.env.closed).toBe(0);
  expect(uncertain.draft.getState()).toMatchObject({ titleHasChanges: false, hasWork: false });

  const unverified = setup();
  unverified.draft.setTitle("New title");
  unverified.draft.save();
  unverified.fake.fire(unverified.last(), "verified-retry");
  expect(unverified.draft.getState().saveLane.recovery).not.toBeNull();
  unverified.fake.fire(unverified.last(), "accepted");
  expect(unverified.env.closed).toBe(0);
  expect(unverified.draft.getState().saveLane.recovery).toBeNull();

  // A fresh Save is a fresh lineage: what the last one went through does not follow it.
  unverified.draft.setTitle("Another title");
  unverified.draft.save();
  unverified.fake.fire(unverified.last(), "accepted");
  expect(unverified.env.closed).toBe(1);
});

test("the title editor and the upload flag are state, and getState keeps its identity until something changes", () => {
  const { draft } = setup();
  const first = draft.getState();
  expect(draft.getState()).toBe(first);

  let heard = 0;
  const unsubscribe = draft.subscribe(() => void heard++);
  draft.setEditingTitle(true);
  expect(heard).toBe(1);
  const second = draft.getState();
  expect(second).not.toBe(first);
  expect(second.editingTitle).toBe(true);
  draft.setEditingTitle(true);
  expect(heard).toBe(1);
  expect(draft.getState()).toBe(second);

  draft.setDescription("Notes");
  expect(heard).toBe(1);
  draft.setTitle("Renamed");
  expect(heard).toBe(2);
  draft.beginUpload();
  draft.endUpload();
  expect(heard).toBe(4);
  unsubscribe();
  draft.setEditingTitle(false);
  expect(heard).toBe(4);
  expect(draft.getState().editingTitle).toBe(false);
});
