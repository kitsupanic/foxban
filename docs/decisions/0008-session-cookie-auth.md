# 0008 — Session-cookie auth

## Status
Accepted — 2026-08-30. Its "GitHub is not authentication" stance is reversed by ADR 0065.

## Context
Two known users need to log in; nothing more.

## Decision
Email+password or a shared invite code; session cookie with sessions stored in D1. Middleware checks session + board membership before any DO access.

## Consequences
Auth stays a thin middleware layer. Rejected: OAuth providers — overkill for 2 users initially.
