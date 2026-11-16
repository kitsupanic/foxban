# 0009 — Pin TypeScript to ^6 (not 7) at the workspace root

## Status
Accepted — 2026-08-30

## Context
`typescript@latest` is 7.x, the native Go port. It ships no `lib/tsserver.js`, so `typescript-language-server` hard-fails on initialize ("provides no tsserver.js"), breaking editor/agent LSP auto-detection. TS 7's built-in `--lsp` mode exists but isn't wired into our tooling.

## Decision
Root devDep `typescript` pinned to `^6` (resolves 6.0.3), keeping `typescript-language-server` functional. All packages typecheck identically under 6 and 7.

## Consequences
Repo stays on the JS-based tsc until the LSP toolchain supports TS 7 natively; revisit when editors/harnesses launch `tsgo --lsp` directly. Rejected: dropping typescript-language-server in favor of TS 7 — fails the milestone's LSP requirement today.
