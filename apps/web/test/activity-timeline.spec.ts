import { expect, test } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import type { Activity, Comment } from "@foxban/shared";
import {
  activityTimeline,
  cardActivityQueryKey,
  recordActivities,
  type ActivityTimelineItem,
  type CommentTimelineItem,
} from "../src/lib/activity";

function comment(id: string, parentCommentId: string | null, createdAt: number): Comment {
  return {
    id,
    cardId: "card-1",
    authorId: "user-1",
    parentCommentId,
    deleted: false,
    body: `body ${id}`,
    createdAt,
    updatedAt: createdAt,
  };
}

test("groups replies under prototype-named roots without leaking between roots", () => {
  const comments = [
    comment("__proto__", null, 1),
    comment("constructor", null, 2),
    comment("ordinary", null, 3),
    comment("r-ordinary-late", "ordinary", 30),
    comment("r-proto", "__proto__", 10),
    comment("r-ctor", "constructor", 20),
    comment("r-ordinary-early", "ordinary", 25),
  ];

  let timeline: ActivityTimelineItem[] = [];
  expect(() => {
    timeline = activityTimeline(comments, []);
  }).not.toThrow();

  const roots = timeline.filter((item): item is CommentTimelineItem => item.kind === "comment");
  const repliesOf = (id: string) =>
    roots.find((item) => item.comment.id === id)?.replies.map((reply) => reply.id);

  expect(roots.map((item) => item.comment.id)).toEqual(["__proto__", "constructor", "ordinary"]);
  expect(repliesOf("__proto__")).toEqual(["r-proto"]);
  expect(repliesOf("constructor")).toEqual(["r-ctor"]);
  expect(repliesOf("ordinary")).toEqual(["r-ordinary-early", "r-ordinary-late"]);
});

const recorded = (sequence: number, cardId = "card-1"): Activity => ({
  id: `act-${cardId}-${sequence}`,
  cardId,
  actorId: "user-1",
  sequence,
  createdAt: sequence,
  detail: { type: "card.created" },
});

test("a recorded frame joins a loaded history in sequence order, once, and skips unloaded cards", () => {
  const client = new QueryClient();
  const key = cardActivityQueryKey("board-1", "card-1");
  client.setQueryData(key, [recorded(1), recorded(3)]);

  recordActivities(client, "board-1", [recorded(2), recorded(3), recorded(9, "card-2")]);

  expect(client.getQueryData<Activity[]>(key)?.map((activity) => activity.sequence)).toEqual([1, 2, 3]);
  expect(client.getQueryData(cardActivityQueryKey("board-1", "card-2"))).toBeUndefined();
  client.clear();
});
