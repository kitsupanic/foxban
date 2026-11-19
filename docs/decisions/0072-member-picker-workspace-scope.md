# 0072 — Member pickers never list the instance

## Status
Accepted — 2026-11-18.

## Context
`GET /boards/:id/membership-candidates` listed every registered user who held no `board_members` row on the board. Anyone who could open any board could read the name and email of every account on the instance, workspace or not. `GET /workspaces/:id/membership-candidates`, behind the workspace's Add member dialog, did the same for every workspace admin, and any signed-in user can create a workspace and so be its admin.

## Decision
- The board list holds only members of the board's workspace who hold no `board_members` row on it.
- To add a Guest from outside the workspace, the person types a full email address: `GET /boards/:id/membership-candidates?email=<address>` returns at most the one account with exactly that address (trimmed, lower case), unless it already holds a grant. A partial address finds nothing.
- The workspace route has no list at all: `GET /workspaces/:id/membership-candidates?email=<address>` returns at most the one account with exactly that address, unless it already holds a membership there; without an address it returns nothing.
- The Add member dialogs ask only when the typed text is a full email address. The board dialog also lists the workspace's people, but only to a member of that workspace (amended: a Guest, an instance Admin outside the workspace included, sees only the exact-email lookup); the workspace dialog shows only what the lookup found.
- An exact-email lookup is limited per signed-in user (10 a minute, the `AUTH_RATE_LIMITER` binding keyed `lookup:<userId>`, both routes sharing it), so it cannot be run down a list of guesses. Requests with no client address, such as local development and tests, are not limited, as for the auth routes.
- Who may add members does not change: anyone who can open the board, and a workspace's admins. Adding is still `POST` with a user id.

## Consequences
Knowing an address is the key to adding an outside person, which fits how a Guest is invited. The exact lookup still tells someone who may add members whether an address has an account, and shows that account's name and GitHub login. Signup does not say this to a stranger: without an invitation, a non-admin signup is refused before any account row is read or written. So the lookup is a small disclosure of its own. It needs an address the person already holds, it is limited per user, and it is no list to browse.
