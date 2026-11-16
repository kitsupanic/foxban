# 0068 — Remove the subtask trial page

## Status
Accepted — 2026-11-16. Supersedes ADR 0056.

## Context
ADR 0056 kept a dev-only Vite entry (`apps/web/subtask-trial.html`) with in-memory fixtures to try independent subtask statuses before they shipped. ADR 0067 made independent statuses the only mode, so the real board now shows everything the trial showed.

## Decision
Delete the trial page, its component and stylesheet, and its state helpers (`apps/web/src/lib/independent-subtasks.ts`) with their logic test. Nothing in the app imported them.

## Consequences
One less entry point and one less parallel model of subtask state to keep in sync. Exploring a new subtask behaviour now means a throwaway prototype branch, not a committed page.
