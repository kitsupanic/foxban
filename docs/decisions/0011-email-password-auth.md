# 0011 — Email+password auth: PBKDF2, open signup, connect-time membership

## Status
Accepted — 2026-08-30

## Context
ADR 0008 fixed session-cookie auth but not the credential mechanism. The Workers runtime rules out bcrypt/argon2 npm packages (native/Node deps); the tool serves two trusted users, so operational simplicity outweighs hardened multi-tenant auth.

## Decision
- **Credentials:** email+password. Hashing via WebCrypto PBKDF2 (SHA-256, 100 000 iterations, 16-byte random salt), stored as `pbkdf2:100000:<salt b64>:<hash b64>`. Verification uses workerd's `crypto.subtle.timingSafeEqual` (present; XOR-accumulate fallback kept for non-workerd typings).
- **Sessions:** 32-byte random hex id in D1, 30-day expiry; cookie `session` HttpOnly/SameSite=Lax/Path=/, Secure only over https.
- **Open signup:** `POST /auth/signup` is unauthenticated. Requirements' "no public signup" non-goal bars multi-tenant onboarding, not registration on an internal 2-user tool; there is no invite-only bootstrap problem to solve.
- **Membership at connect only:** `GET /boards/:id/ws` checks auth + membership before the upgrade (plain curl gets 401/403, never 426). Revoking membership does not terminate live sockets.

## Consequences
- No native-dependency risk; hashing cost is bounded and acceptable per login on Workers.
- Anyone reaching the deployment can register; acceptable ONLY while fully local. **Deploy gate: before the Worker is publicly reachable, signup MUST be gated** (invite code from a deployment secret, two-email allowlist, or Cloudflare Access in front) and auth endpoints rate-limited — open signup on a public URL exposes billable D1/DO resources and contradicts requirements.md's internal-tool boundary. PBKDF2 cost must also be benchmarked on deployed workerd (free-tier 10ms CPU budget) before choosing the iteration count going forward; the stored format encodes the count, so old hashes keep verifying.
- A revoked member (and a logged-out user's other tabs) keeps an already-open socket until it closes; bounded by 2-user trust. Rejected: per-message membership checks (a D1 read per mutation for a non-threat).
- Invariant: **every route that obtains a `BOARD_DO` stub must run `requireAuth` + `requireMember` first.** The DO itself is auth-free by design (hibernation economics); the Worker route is the entire boundary, so a second unguarded route would silently bypass auth.
- Login timing is equalized (unknown email verifies against a dummy hash), but account existence is still disclosed by signup's 409 — intentional under open signup.
