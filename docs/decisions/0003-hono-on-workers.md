# 0003 — Hono on Workers

## Status
Accepted — 2026-08-30

## Context
API framework must run on the Cloudflare Workers runtime, which is not Node.

## Decision
Hono for the API, with Hono RPC (`hc`) giving the SPA a typed client from the exported `AppType`.

## Consequences
End-to-end type safety without codegen. Rejected: NestJS — incompatible with the Workers runtime.
