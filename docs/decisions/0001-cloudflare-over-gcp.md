# 0001 — Cloudflare over GCP

## Status
Accepted — 2026-08-30

## Context
Hosting for a low-traffic internal tool used by 2 people. Cost matters more than scale.

## Decision
Host on Cloudflare: Workers for the API, Durable Objects for real-time board state, D1 for global data. Deploy via Wrangler (Workers static assets or Pages for the SPA).

## Consequences
Free/cheap tier fits the traffic profile. Rejected: Cloud SQL / GCP — cost is disproportionate for a 2-user tool.
