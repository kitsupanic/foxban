import { createExecutionContext, env } from "cloudflare:test";

import worker from "../src/index";

const ORIGIN = "https://foxban.test";

/**
 * The test's D1 binding, paused before every statement or batch: `hook(n)` runs before
 * the n-th query through it and the query continues when it returns. Hand it to anything
 * that takes a `DB` (a Worker's env, or a Durable Object's own).
 */
export function pausedD1(hook: (n: number) => Promise<void>): { db: D1Database; queries: () => number } {
  let n = 0;
  const pause = () => hook(n++);
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "first" || property === "run" || property === "all" || property === "raw") {
          return async (...args: unknown[]) => {
            await pause();
            return (target[property] as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    unwrapped.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await pause();
          return target.batch(statements.map((statement) => unwrapped.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, queries: () => n };
}

/**
 * The Worker as the test's own client, with its D1 binding paused (see `pausedD1`): a
 * concurrent request cannot be aimed at the gap between two queries, but a hook that makes
 * it can, at every gap in turn.
 */
export function workerWithPausedD1(hook: (n: number) => Promise<void>) {
  const paused = pausedD1(hook);
  return {
    fetch: (path: string, method: string, by: { cookie: string }, body?: unknown) =>
      worker.fetch!(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { cookie: by.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }) as never,
        { ...env, DB: paused.db } as unknown as typeof env,
        createExecutionContext(),
      ) as Promise<Response>,
    queries: paused.queries,
  };
}

/** How many queries `request` makes when nothing interferes: the gaps to try. */
export async function queriesOf(request: (hooked: ReturnType<typeof workerWithPausedD1>) => Promise<unknown>): Promise<number> {
  const counting = workerWithPausedD1(async () => {});
  await request(counting);
  return counting.queries();
}
