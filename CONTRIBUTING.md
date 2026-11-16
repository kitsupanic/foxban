# Contributing to foxban

Thanks for helping. Small, focused pull requests are easiest to review.

## Set up

You need Node.js 22 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev:api   # Worker on wrangler dev
pnpm dev:web   # Vite SPA
```

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
```

UI changes should also pass the browser suite: `pnpm --filter @foxban/web test:e2e`.
See [docs/testing.md](docs/testing.md) for what each layer covers.

## How the project works

- Read [docs/architecture.md](docs/architecture.md) first, and the rules in [AGENTS.md](AGENTS.md).
  They apply to people too: board state lives only in the board's Durable Object, never in D1.
- A choice that is hard to undo gets an ADR in [docs/decisions/](docs/decisions/).
- Project words are defined in [GLOSSARY.md](GLOSSARY.md).
- Never commit instance values (emails, domains, Cloudflare ids). See ADR 0063.

## Security bugs

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
