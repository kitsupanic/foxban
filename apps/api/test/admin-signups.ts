import { vi } from "vitest";

/**
 * `ADMIN_EMAILS` lists exact addresses only (ADR 0071), but most of this suite's accounts are made on
 * `@foxban.test` and expect to be admins, with addresses it invents as it goes. So a signup on that domain
 * first lists its own address, as a deployer would. The Worker and the Durable Objects read the same
 * `env`, so both see it. Any other domain stays plain, and so does an address the config only wildcards.
 */
const ADMIN_DOMAIN = "@foxban.test";

vi.mock("cloudflare:test", async (importOriginal) => {
  const original = await importOriginal<typeof import("cloudflare:test")>();
  const fetchSelf = original.SELF.fetch.bind(original.SELF);
  const SELF = new Proxy(original.SELF, {
    get: (target, property) =>
      property !== "fetch"
        ? Reflect.get(target, property)
        : (input: Parameters<typeof fetchSelf>[0], init?: Parameters<typeof fetchSelf>[1]) => {
            if (typeof input === "string" && input.endsWith("/auth/signup") && typeof init?.body === "string") {
              const email: unknown = JSON.parse(init.body).email;
              if (typeof email === "string" && email.trim().toLowerCase().endsWith(ADMIN_DOMAIN)) original.env.ADMIN_EMAILS += `,${email}`;
            }
            return fetchSelf(input, init);
          },
  });
  return { ...original, SELF };
});
