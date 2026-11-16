# 0070 — No CI or deploy workflow for now

## Status
Accepted — 2026-11-16. Supersedes the GitHub Actions parts of ADRs 0031, 0032 and 0063.

## Context
After the move to a public repo, the CI workflow failed on `main` because some API tests time out on GitHub runners. The deploy workflow also expected per-instance GitHub Environments that a new fork does not have.

## Decision
Remove `.github/workflows/` for now. Contributors run `pnpm typecheck` and `pnpm test` locally before a pull request. Instances deploy with `pnpm run deploy` from a computer or with the Deploy to Cloudflare button, which builds on each push to the copy it makes.

## Consequences
Nothing checks pull requests automatically, so reviewers must ask for local results. Bring CI back once the API suite is stable on hosted runners; that will be a new ADR.
