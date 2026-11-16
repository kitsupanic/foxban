# 0002 — React SPA, no SSR

## Status
Accepted — 2026-08-30

## Context
Authenticated internal tool; no SEO or public pages. Frontend framework needed for an interactive board UI.

## Decision
React + Vite as a pure SPA, with TanStack Router and TanStack Query.

## Consequences
Simple build and deploy; no server rendering pipeline. Rejected: Angular (switched away to React); SSR / TanStack Start (unneeded for an authenticated internal tool with no SEO).
