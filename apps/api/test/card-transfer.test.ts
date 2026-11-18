import { TRANSFER_TERMINAL_CODE } from "@foxban/shared";
import { describe, expect, it } from "vitest";
import type { PreparedCardTransferBundle } from "../src/board-do";
import {
  run,
  settle,
  type DestinationParticipant,
  type Reply,
  type RunOutcome,
  type SettleOutcome,
  type SourceParticipant,
} from "../src/card-transfer";

/**
 * The card transfer coordinator against fake participants: each case injects one
 * failure (a status, or a throw) at one step and pins the outcome and the calls made.
 * The DO and Worker transfer tests remain the end-to-end contract.
 */
const ids = { transferId: "t1", sourceBoardId: "src", cardId: "c1", destinationBoardId: "dst" };
const receipt = { transferId: "t1", sourceBoardId: "src", cardId: "c1", taskNumber: 7 };
const foreignReceipt = { ...receipt, cardId: "other" };
const bundle = () =>
  ({
    card: { description: "![shot](/boards/src/attachments/a1)", assigneeId: "u-member" },
    comments: [{ body: "/boards/src/attachments/a1" }],
    attachments: [{ id: "a1", contentType: "image/png", size: 1, objectKey: "src/a1" }],
  }) as unknown as PreparedCardTransferBundle;

type Step = "receipt" | "prepare" | "stage" | "copy" | "import" | "finalize" | "release" | "abort";
type Answer = Reply<any> | "throw" | boolean;
const r = (status: number, body: object = {}): Reply<any> => ({ status, body });

function fakes(overrides: Partial<Record<Step, Answer>> = {}) {
  const calls: Step[] = [];
  const seen: { importInput?: Parameters<DestinationParticipant["import"]>[0] } = {};
  const answer = async (step: Step, fallback: Answer): Promise<any> => {
    calls.push(step);
    const a = step in overrides ? overrides[step]! : fallback;
    if (a === "throw") throw new Error(`${step} unreachable`);
    return a;
  };
  const source: SourceParticipant = {
    prepare: () => answer("prepare", r(200, { bundle: bundle() })),
    finalize: () => answer("finalize", r(200)),
    release: () => answer("release", r(200)),
  };
  const destination: DestinationParticipant = {
    receipt: () => answer("receipt", r(404)),
    abort: () => answer("abort", r(200, { aborted: true, receipt: { ...receipt, taskNumber: -1 } })),
    stageAttachment: () => answer("stage", r(200)),
    copyAttachment: () => answer("copy", true),
    import: (input) => {
      seen.importInput = input;
      return answer("import", r(200, { receipt }));
    },
  };
  return { calls, seen, source, destination };
}

const moved: RunOutcome = { kind: "moved", receipt };
const refused = (status: number, error: string, code?: string) => ({ kind: "refused", status, error, ...(code ? { code } : {}) });
const compensationFailed = refused(500, "transfer compensation failed; retry required");
const full: Step[] = ["receipt", "prepare", "stage", "copy", "import", "finalize"];
const compensated = (failedAt: Step, ...after: Step[]): Step[] => [...full.slice(0, full.indexOf(failedAt) + 1), "abort", ...after];

describe("CardTransfer.run", () => {
  const cases: { name: string; inject: Partial<Record<Step, Answer>>; outcome: object; calls: Step[] }[] = [
    { name: "moves the card", inject: {}, outcome: moved, calls: full },

    // Receipt lookup
    { name: "receipt names another transfer", inject: { receipt: r(409) }, outcome: refused(409, "transfer id already used for another transfer", TRANSFER_TERMINAL_CODE), calls: ["receipt"] },
    { name: "receipt is an abort tombstone", inject: { receipt: r(410) }, outcome: refused(410, "transfer operation was aborted", TRANSFER_TERMINAL_CODE), calls: ["receipt"] },
    { name: "receipt already committed: only finalizes", inject: { receipt: r(200, { receipt }) }, outcome: moved, calls: ["receipt", "finalize"] },
    { name: "committed receipt, finalize fails", inject: { receipt: r(200, { receipt }), finalize: r(500) }, outcome: refused(500, "transfer needs retry"), calls: ["receipt", "finalize"] },
    { name: "receipt of another operation", inject: { receipt: r(200, { receipt: foreignReceipt }) }, outcome: refused(409, "transfer operation identity mismatch", TRANSFER_TERMINAL_CODE), calls: ["receipt"] },
    { name: "receipt answer without a receipt: retryable", inject: { receipt: r(200) }, outcome: refused(500, "transfer needs retry"), calls: ["receipt"] },
    // Pinned as-is: any other lookup failure reads as "no receipt yet".
    { name: "receipt lookup errors: carries on", inject: { receipt: r(500) }, outcome: moved, calls: full },

    // Prepare
    { name: "prepare: card not found", inject: { prepare: r(404) }, outcome: refused(404, "not found"), calls: ["receipt", "prepare"] },
    { name: "prepare: forbidden", inject: { prepare: r(403) }, outcome: refused(403, "forbidden"), calls: ["receipt", "prepare"] },
    { name: "prepare: access changing", inject: { prepare: r(503, { code: "access_change_pending" }) }, outcome: refused(503, "Board access is changing. Please retry.", "access_change_pending"), calls: ["receipt", "prepare"] },
    { name: "prepare: terminal conflict", inject: { prepare: r(409, { error: "transfer id already used for another card", code: TRANSFER_TERMINAL_CODE }) }, outcome: refused(409, "transfer id already used for another card", TRANSFER_TERMINAL_CODE), calls: ["receipt", "prepare"] },
    { name: "prepare: card has links", inject: { prepare: r(409, { error: "remove card links before transferring" }) }, outcome: refused(409, "remove card links before transferring"), calls: ["receipt", "prepare"] },
    { name: "prepare: locked by another transfer", inject: { prepare: r(409, { error: "whatever" }) }, outcome: refused(409, "card transfer already in progress"), calls: ["receipt", "prepare"] },
    { name: "prepare: other failure", inject: { prepare: r(500) }, outcome: refused(500, "could not prepare card transfer"), calls: ["receipt", "prepare"] },

    // Attachments
    { name: "stage fails: fence and release", inject: { stage: r(500) }, outcome: refused(500, "could not transfer attachments"), calls: [...compensated("stage"), "release"] },
    { name: "copy fails: fence and release", inject: { copy: false }, outcome: refused(500, "could not transfer attachments"), calls: [...compensated("copy"), "release"] },

    // Import
    { name: "import: column gone", inject: { import: r(400, { error: "destination column not found" }) }, outcome: refused(400, "destination column not found"), calls: [...compensated("import"), "release"] },
    { name: "import: forbidden", inject: { import: r(403) }, outcome: refused(403, "forbidden"), calls: [...compensated("import"), "release"] },
    { name: "import: access changing", inject: { import: r(503, { code: "access_change_pending" }) }, outcome: refused(503, "Board access is changing. Please retry.", "access_change_pending"), calls: [...compensated("import"), "release"] },
    { name: "import: terminal conflict", inject: { import: r(409, { code: TRANSFER_TERMINAL_CODE }) }, outcome: refused(409, "transfer operation is no longer usable", TRANSFER_TERMINAL_CODE), calls: [...compensated("import"), "release"] },
    { name: "import: plain conflict", inject: { import: r(409, { error: "lease expired" }) }, outcome: refused(409, "lease expired"), calls: [...compensated("import"), "release"] },
    { name: "import: other failure", inject: { import: r(500) }, outcome: refused(500, "could not import card"), calls: [...compensated("import"), "release"] },

    // Compensation
    { name: "import fails but the fence finds it committed: finalizes", inject: { import: r(500), abort: r(200, { committed: true, receipt }) }, outcome: moved, calls: compensated("import", "finalize") },
    { name: "compensation finalize fails", inject: { import: r(500), abort: r(200, { committed: true, receipt }), finalize: r(500) }, outcome: refused(500, "transfer needs retry"), calls: compensated("import", "finalize") },
    { name: "fence unreachable: lock kept", inject: { import: r(500), abort: "throw" }, outcome: compensationFailed, calls: compensated("import") },
    { name: "fence refused: lock kept", inject: { import: r(500), abort: r(500) }, outcome: compensationFailed, calls: compensated("import") },
    { name: "fence answers another operation: lock kept", inject: { import: r(500), abort: r(200, { aborted: true, receipt: foreignReceipt }) }, outcome: compensationFailed, calls: compensated("import") },
    { name: "release fails after fence", inject: { stage: r(500), release: r(500) }, outcome: compensationFailed, calls: [...compensated("stage"), "release"] },

    // Finalize
    { name: "finalize fails after import", inject: { finalize: r(500) }, outcome: refused(500, "transfer needs retry"), calls: full },
  ];

  it.each(cases)("$name", async ({ inject, outcome, calls }) => {
    const f = fakes(inject);
    expect(await run(ids, f.source, f.destination, "col", new Set(["u-member"]))).toEqual(outcome);
    expect(f.calls).toEqual(calls);
  });

  it("rewrites attachment URLs to the destination and keeps a member assignee", async () => {
    const f = fakes();
    await run(ids, f.source, f.destination, "col", new Set(["u-member"]));
    expect(f.seen.importInput?.assigneeId).toBe("u-member");
    expect(f.seen.importInput?.destinationColumnId).toBe("col");
    expect(f.seen.importInput?.bundle.card.description).toBe("![shot](/boards/dst/attachments/a1)");
  });

  it("drops an assignee the destination does not admit", async () => {
    const f = fakes();
    await run(ids, f.source, f.destination, "col", new Set());
    expect(f.seen.importInput?.assigneeId).toBeNull();
  });

  it("lets a thrown source call propagate", async () => {
    const f = fakes({ prepare: "throw" });
    await expect(run(ids, f.source, f.destination, "col", new Set())).rejects.toThrow("prepare unreachable");
  });

  it("releases the losing source when two transfers share a transferId", async () => {
    // One destination's receipt table; receipt, import and abort answer as the BoardDO does.
    const table = new Map<string, typeof receipt>();
    const anotherTransfer = r(409, { error: "transfer id already used for another transfer", code: TRANSFER_TERMINAL_CODE });
    let firstSettled!: () => void;
    const firstDone = new Promise<void>((resolve) => (firstSettled = resolve));
    const transfer = (op: typeof ids, gate?: Promise<void>) => {
      const mine = (x: typeof receipt) => x.sourceBoardId === op.sourceBoardId && x.cardId === op.cardId;
      const card = { locked: false, gone: false };
      const source: SourceParticipant = {
        prepare: async () => ((card.locked = true), r(200, { bundle: bundle() })),
        finalize: async () => ((card.locked = false), (card.gone = true), r(200)),
        release: async () => ((card.locked = false), r(200)),
      };
      const destination: DestinationParticipant = {
        ...fakes().destination,
        receipt: async () => {
          const x = table.get(op.transferId);
          return !x ? r(404) : mine(x) ? r(200, { receipt: x }) : r(409);
        },
        import: async () => {
          await gate;
          const x = table.get(op.transferId);
          if (x) return mine(x) ? r(200, { receipt: x }) : anotherTransfer;
          const written = { transferId: op.transferId, sourceBoardId: op.sourceBoardId, cardId: op.cardId, taskNumber: table.size + 1 };
          table.set(op.transferId, written);
          return r(200, { receipt: written });
        },
        abort: async () => {
          const x = table.get(op.transferId);
          if (x && !mine(x)) return anotherTransfer;
          if (x) return r(200, { committed: x.taskNumber >= 0, aborted: x.taskNumber < 0, receipt: x });
          const tombstone = { transferId: op.transferId, sourceBoardId: op.sourceBoardId, cardId: op.cardId, taskNumber: -1 };
          table.set(op.transferId, tombstone);
          return r(200, { aborted: true, receipt: tombstone });
        },
      };
      return { card, source, destination };
    };

    const first = { ...ids, sourceBoardId: "s1", cardId: "c1" };
    const second = { ...ids, sourceBoardId: "s2", cardId: "c2" };
    const a = transfer(first);
    const b = transfer(second, firstDone);
    // Both pass the receipt lookup before either imports; the second import then meets the first's receipt.
    const [outcomeA, outcomeB] = await Promise.all([
      run(first, a.source, a.destination, "col", new Set()).finally(firstSettled),
      run(second, b.source, b.destination, "col", new Set()),
    ]);

    expect(outcomeA.kind).toBe("moved");
    expect(outcomeB).toEqual(refused(409, "transfer id already used for another transfer", TRANSFER_TERMINAL_CODE));
    expect(a.card).toEqual({ locked: false, gone: true });
    expect(b.card).toEqual({ locked: false, gone: false });
    expect([...table.values()].filter((x) => x.taskNumber >= 0).map((x) => x.cardId)).toEqual(["c1"]);
  });
});

describe("CardTransfer.settle", () => {
  const { destinationBoardId: _, ...lockIds } = ids;
  const cases: { name: string; inject: Partial<Record<Step, Answer>>; outcome: SettleOutcome; calls: Step[] }[] = [
    { name: "destination committed: finalize", inject: { abort: r(200, { committed: true, receipt }) }, outcome: { kind: "finalized" }, calls: ["abort", "finalize"] },
    { name: "destination fenced: release", inject: {}, outcome: { kind: "released", cleared: true }, calls: ["abort", "release"] },
    { name: "lock moved on before release", inject: { release: r(409) }, outcome: { kind: "released", cleared: false }, calls: ["abort", "release"] },
    { name: "destination unreachable", inject: { abort: "throw" }, outcome: { kind: "retry", why: "unreachable" }, calls: ["abort"] },
    { name: "destination refused", inject: { abort: r(500) }, outcome: { kind: "retry", why: "refused" }, calls: ["abort"] },
    { name: "fence answers another operation", inject: { abort: r(200, { committed: true, receipt: foreignReceipt }) }, outcome: { kind: "retry", why: "mismatch" }, calls: ["abort"] },
    { name: "fence answers neither committed nor aborted", inject: { abort: r(200, { receipt }) }, outcome: { kind: "retry", why: "refused" }, calls: ["abort"] },
  ];

  it.each(cases)("$name", async ({ inject, outcome, calls }) => {
    const f = fakes(inject);
    expect(await settle(lockIds, f.source, [f.destination])).toEqual(outcome);
    expect(f.calls).toEqual(calls);
  });

  describe("a legacy lock over several candidate boards", () => {
    it("finalizes on a committed receipt without fencing anyone", async () => {
      const a = fakes();
      const b = fakes({ receipt: r(200, { receipt }) });
      expect(await settle(lockIds, a.source, [a.destination, b.destination], true)).toEqual({ kind: "finalized" });
      expect([a.calls, b.calls]).toEqual([["receipt", "finalize"], ["receipt"]]);
    });

    it("ignores an abort tombstone or another operation's receipt, then fences every board", async () => {
      const a = fakes({ receipt: r(410) });
      const b = fakes({ receipt: r(200, { receipt: foreignReceipt }) });
      expect(await settle(lockIds, a.source, [a.destination, b.destination], true)).toEqual({ kind: "released", cleared: true });
      expect([a.calls, b.calls]).toEqual([["receipt", "abort", "release"], ["receipt", "abort"]]);
    });

    it("retries when a lookup fails", async () => {
      const a = fakes({ receipt: r(409) });
      expect(await settle(lockIds, a.source, [a.destination], true)).toEqual({ kind: "retry", why: "refused" });
      const b = fakes({ receipt: "throw" });
      expect(await settle(lockIds, b.source, [b.destination], true)).toEqual({ kind: "retry", why: "unreachable" });
    });

    it("finalizes when a later board's fence finds it committed", async () => {
      const a = fakes();
      const b = fakes({ abort: r(200, { committed: true, receipt }) });
      expect(await settle(lockIds, a.source, [a.destination, b.destination], true)).toEqual({ kind: "finalized" });
      expect(a.calls).toEqual(["receipt", "abort", "finalize"]);
    });
  });
});
