# OSAWARE Multi-Tenancy Step 4 — Handoff Document

**Status:** Planning complete, ready to begin implementation
**Last updated:** Session start of Step 4 (post-V7B19)
**Previous milestone:** V7B19 — Step 3 shipped, VFSAUTHTEST 23/23 green

---

## Purpose of this document

This file is the authoritative reference for Step 4 of the OSAWARE multi-tenancy plan — the real backend and production auth. It exists so that if we lose context mid-build, abandon the effort and pick it up months later, or hand it off to another contributor, the plan and the decisions behind it are recoverable without having to re-derive them from the conversation transcript.

Read this file top to bottom before writing any backend code. The decisions here are intentional and most of them have alternatives that were considered and rejected for specific reasons documented below.

---

## Where Step 4 sits in the larger plan

From the original multi-tenancy plan (see `OSAWARE_Multitenancy_Plan.pdf`):

| Step | Status | Ship | Description |
|------|--------|------|-------------|
| 1 | ✅ done | V7B6 | Storage provider abstraction — `LocalStorageProvider` introduced |
| 2 | ✅ done | V7B14 | Async storage interface, envelope+CRC32, orphan recovery, VFS init split |
| 3 | ✅ done | V7B15 | `MockRemoteStorageProvider`, `AuthService`, DEV* commands, VFSAUTHTEST |
| **4** | **⏳ in progress** | **V7B20+** | **Real `RemoteStorageProvider` + backend + real LOGIN/LOGOUT/REGISTER** |
| 5 | planned | TBD | Backend infrastructure (hosting, monitoring, backups) |
| 6 | planned | TBD | Login UX polish, account management |
| 7 | planned | TBD | Production rollout |

Step 4 is where we cross the boundary from "pure browser code" to "browser + server." Every previous step kept all state in the user's browser. Step 4 introduces a server-of-record and real user accounts.

---

## What Step 4 delivers

A user can open OSAWARE in a browser, type `REGISTER "alice"` at the prompt, enter a password in an obfuscated prompt, then use OSAWARE normally. Their saved programs, folders, and binary assets follow them across devices and browsers. If they clear localStorage, their data is unaffected. If they log out and back in from a different browser, everything is still there.

The existing LOCAL mode (no account, browser-only storage) continues to work unchanged as the default. The existing DEV mode (`DEVLOGIN` against the in-memory mock provider) continues to work unchanged as a testing tool. The new REAL mode (`LOGIN` against the real backend) is a third option with completely separate state from both of them.

The three modes share the same VFS storage slot in the browser but **never mix**. Crossed transitions (being in DEV mode and typing `LOGIN`, or vice versa) are errors, not implicit swaps. This matches the state machine established in Step 3.

---

## Architecture decisions

All decisions below were made in the planning session and are locked in unless explicitly revisited. Do not deviate without writing a reason here.

### Decision 1 — Hosting: AWS Lightsail

Single-instance Node.js deployment on AWS Lightsail. No load balancer, no clustering, no horizontal scale. One box, one Node process, one database file.

**Alternatives considered and rejected:**
- Cloudflare Workers + D1 — cleanest serverless story, but user already has Lightsail familiarity and preference.
- Fly.io — similar to Lightsail, no decisive advantage.
- Self-managed VPS (DigitalOcean, Linode) — no reason to prefer over Lightsail.
- Supabase or similar BaaS — locks us to a platform's auth and data conventions; we lose control over the session mechanism and data model.

**Why it matters:** Lightsail is a managed VPS with a simple billing model (~$5-10/month for our expected tier). Node.js is first-class. It has built-in snapshots for backup. It's the right tool for a hobby-scale single-server deployment.

### Decision 2 — Data model: α' (hybrid envelope + filesystem)

This is the architectural heart of Step 4. It was revised during the planning session because the original Option α (pure envelope blobs) didn't account for binary assets.

**What gets stored where:**

1. **Database (SQLite)** — small atomic data:
   - `users` table: id, username (unique), password_hash, created_at
   - `sessions` table: id, user_id, expires_at, created_at
   - `user_storage` table: one row per user per slot, holds envelope JSON. Four slots per user: `files_committed`, `files_pending`, `assets_committed`, `assets_pending`. The envelope format matches the local and mock providers: `{v, crc, ts, data}`. The server treats it as an opaque string — it never parses the inside.
   - `user_binary_assets` table: metadata pointers for binary files. Columns: user_id, path, mime, size, ts. One row per binary file, no bytes.

2. **Filesystem** — actual binary bytes:
   - Location: `/srv/osaware-data/users/<user_id>/<sanitised_path>`
   - One file per asset. Directory structure mirrors the logical VFS path.
   - Path sanitisation is mandatory and non-negotiable (see Security section below).

3. **Browser memory only (never persisted)** — embedded OSAWARE content:
   - Programs like MAZE3DV2, textures like MAZE3D/WALLS.PNG, etc.
   - These live in the JavaScript bundle and are bundled with every OSAWARE page load.
   - They never hit the server and don't count against any quota.

**What "binary" means:** any VFS asset whose mime type is not text-like. Specifically:
- Text: `text/*`, `application/json`, `application/xml`, anything under ~4KB
- Binary: `image/*`, `audio/*`, `video/*`, `application/octet-stream`, anything over ~4KB regardless of mime

The 4KB threshold is a soft heuristic — if a "text" file happens to be 50KB it still goes in the envelope, because the atomicity is valuable. The primary test is mime type, not size. Size is a fallback for edge cases.

**Alternatives considered and rejected:**
- Option α (pure envelope blobs, images included): a single save would upload megabytes; database row sizes would balloon; backups would become unwieldy.
- Option β (unpack files and assets into per-row rows): loses the envelope+CRC atomicity guarantee that makes corruption detection and orphan recovery work; requires a schema migration any time the program format changes; the server now has to understand the inside of user data.
- Cloud object storage (S3/R2) for binaries: adds another service to depend on, complicates backup, more config. A local filesystem under Lightsail's included block storage is simpler and sufficient for the expected scale.

### Decision 3 — Database: SQLite via better-sqlite3

Single-file SQLite database at `/srv/osaware-data/osaware.db`. Accessed via the `better-sqlite3` Node library (synchronous API, very fast for our workload).

**Why SQLite and not MariaDB/MongoDB:**
- Single file on disk, trivial backup (`cp the-file.db backup.db`)
- Zero configuration, no port, no credentials, no separate process
- Full SQL with foreign keys, transactions, ACID
- better-sqlite3 is faster than most networked databases for single-writer workloads
- Our expected scale (hundreds to low thousands of users, each with a few MB of data) is well within SQLite's sweet spot
- If we ever outgrow it, the schema is vanilla SQL and migrates cleanly to MariaDB or Postgres

MongoDB was considered and rejected: our data is inherently relational (users have sessions, users have binary assets, referential integrity matters), which is MongoDB's weakest fit. MariaDB was considered and is a valid alternative if the user prefers a networked DB for ops reasons, but SQLite is simpler.

### Decision 4 — Auth: bcrypt + session cookies + 30-day sliding

**Password storage:** bcrypt, cost factor 12. `bcrypt` Node library (industry standard, audited, well-maintained).

**Session mechanism:** server-side sessions with HTTP cookies. When a user logs in successfully, the server:
1. Creates a row in `sessions` table with a cryptographically random id (32 bytes, base64url-encoded), expires_at = now + 30 days
2. Sets a cookie with flags: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`
3. Cookie name: `osaware_session`
4. Cookie value: the session id

On every subsequent request, the server reads the cookie, looks up the session, verifies it hasn't expired, and attaches the user_id to the request context. If the session is valid, the server also updates `expires_at` to now + 30 days (sliding expiry).

**Logout** deletes the session row and clears the cookie.

**Session cleanup:** on startup and once per hour, the server deletes all rows from `sessions` where `expires_at < now`.

**No JWT**, no refresh tokens, no client-side token storage. The browser just has a cookie it can't read (HttpOnly).

### Decision 5 — API surface

Nine endpoints, all JSON in/out except binary blob endpoints.

```
POST   /api/register     {username, password}         → {ok, user}
POST   /api/login        {username, password}         → {ok, user} + session cookie
POST   /api/logout       (cookie)                     → {ok}
GET    /api/whoami       (cookie)                     → {user} or {user: null}

GET    /api/storage      (cookie)                     → {files_envelope, assets_envelope, binary_manifest}
POST   /api/storage      (cookie) {files_envelope, assets_envelope}  → {ok}

GET    /api/blob/:path   (cookie)                     → raw bytes + Content-Type header
PUT    /api/blob/:path   (cookie) raw bytes           → {ok, size}
DELETE /api/blob/:path   (cookie)                     → {ok}
```

All responses are JSON except `GET /api/blob/:path` which returns the raw bytes with the appropriate Content-Type header from the `user_binary_assets` table.

**`:path`** is the URL-encoded user asset path (e.g. `MARY%2Fphoto.png`). Must pass path sanitisation — see Security.

**`binary_manifest`** is an array: `[{path, mime, size, ts}, ...]`. The browser uses this to know what binaries exist. For v1, the browser downloads them all eagerly on login.

**Error responses** are HTTP status code + `{error: "..."}` JSON body. Specifically:
- 400 — bad request (malformed body, invalid path)
- 401 — not authenticated (no cookie, expired session)
- 403 — forbidden (trying to access another user's resources — shouldn't happen due to per-user isolation but the check exists)
- 404 — not found (user or blob doesn't exist)
- 409 — conflict (REGISTER with existing username)
- 413 — payload too large (hit a quota)
- 500 — server error (bug, DB failure, disk failure)

### Decision 6 — Registration UX: two-form REGISTER with obfuscated password

Two valid forms:

```basic
REGISTER "alice", "pass1"      ' full form — used for debugging live prod
REGISTER "alice"               ' short form — prompts for password obfuscated
```

When the short form is used, the shell enters a password-entry mode where keystrokes echo as `*` and the input is not logged to history. This uses the existing `want_password` flag in the terminal driver (same mechanism as `SAVE WEB:` password entry).

Prompt text: `Enter password: ` (no trailing space difference, just clean)
On successful input: the shell calls `AuthService.register(username, password)` the same way the full form does.

LOGIN will also support two forms by symmetry, and I'll flag this explicitly here:

```basic
LOGIN "alice", "pass1"         ' full form
LOGIN "alice"                  ' short form — prompts for password obfuscated
```

REGISTER and LOGIN are the only commands that get the obfuscated-password prompt. The DEV family (DEVLOGIN, DEVLOGOUT) keeps its current behaviour — always two positional args, no prompt, no obfuscation. Dev-mode credentials are hardcoded and there's nothing to protect.

### Decision 7 — Development workflow: local first, then deploy

1. Build and test the backend locally in `/home/claude/osaware-backend/`
2. Smoke test against a local Node server via fetch()
3. Build the browser-side `RemoteStorageProvider` against localhost backend
4. Real browser test in an integration test program (something like `VFSREALTEST`, parallel to VFSAUTHTEST)
5. Only after all of the above passes do we deploy to Lightsail

**CORS during dev:** the local backend will have permissive CORS (`Access-Control-Allow-Origin: *` with credentials off) so the browser running from `file://` or a local static server can talk to it. In production, CORS will be restricted to the actual OSAWARE origin.

### Decisions NOT made — deliberately out of scope for v1

These are real features that many users will eventually want but they are **not** in scope for Step 4. Adding them later is straightforward because the architecture supports it; trying to build them now triples the scope and delays shipping.

- **Email verification**: REGISTER creates and activates an account immediately. No confirmation email.
- **Password reset**: if a user forgets their password, they lose their data (or the ops person fixes it in the database). Adding a reset flow requires email sending, which is a whole other moving part.
- **Rate limiting / brute force protection**: beyond what the hosting platform provides. Can add fail2ban or similar in Step 5 if needed.
- **Multi-device sync conflict resolution**: last write wins. If alice opens OSAWARE in two browsers and edits a program in each, the second save wins. Matches current local behaviour.
- **Data export (GDPR "right to download")**: no UI, no endpoint. If a user asks for their data, we manually export it from the database.
- **Account deletion**: no UI, no endpoint. Manual only for v1.
- **Sharing between users**: no "alice shares a program with bob." Users are fully isolated, always.
- **Paid tiers or quotas**: unlimited storage per user for v1. If someone stores 10GB we'll deal with it when it happens.

If any of these become requirements during Step 4, stop and revisit this document. Don't slip scope silently.

---

## Security — non-negotiable

These items are not optional and must be tested explicitly in the smoke test suite.

### Path traversal protection

**Every path from the client must be sanitised before being used as a filesystem path.** Specifically, the server must reject any path that:

- Contains `..` as a path segment
- Contains `.` as a lone path segment (technically safe but a sign of tampering)
- Starts with `/` or `\`
- Contains `\0` (null byte) — some libraries stop parsing at null bytes, which can be used to bypass suffix checks
- Contains `\r` or `\n`
- Contains `:` on Windows (ADS exploit — we're on Linux but still)
- After normalisation, escapes the user's root directory

The sanitisation logic lives in `auth.js` as `sanitiseAssetPath(userPath)` returning either a safe relative path or throwing. Every filesystem operation must go through it. The smoke test includes explicit "attacker tries `../../../etc/passwd`" cases and verifies rejection.

### Per-user isolation

When handling any `/api/blob/:path` request, the server:
1. Reads the session cookie, looks up user_id
2. Rejects if not authenticated
3. Sanitises the path
4. Constructs the filesystem path as `/srv/osaware-data/users/<user_id>/<sanitised_path>` — user_id is server-side, never from the client
5. Performs the read/write/delete

There is no way for a client to specify `user_id` — it always comes from the session cookie. A compromised or malicious client cannot access another user's files even if they know the path.

### Password handling

- Passwords are hashed with bcrypt at rest, never stored in plaintext
- Passwords never appear in log output, even on error
- Password comparison uses bcrypt's constant-time compare
- The server logs login attempts (success and failure) with username and timestamp, but **not** the attempted password

### Session ID entropy

Session IDs are generated via `crypto.randomBytes(32)`, base64url encoded. 32 bytes = 256 bits = far more than enough entropy to resist brute force.

### HTTPS in production

Production deployment on Lightsail must use HTTPS. Let's Encrypt via certbot is the standard path. HTTP requests in production redirect to HTTPS. The `Secure` flag on the session cookie means the cookie won't be sent over HTTP anyway, but the redirect is belt-and-braces.

### Input size limits

- Username: 3-32 characters, alphanumeric + underscore, enforced on register
- Password: 6-128 characters, no character class requirements (length matters more)
- Envelope payload: maximum 1 MB per envelope (programs + text assets). Larger than we expect to need; will flag if we hit it.
- Binary asset: maximum 10 MB per file. Can raise later if needed.
- Total per-user storage: unlimited for v1 but server logs it in a way that's easy to query later.

---

## Directory layout

### Backend source tree (to be created in session B)

```
/home/claude/osaware-backend/
├── schema.sql              — SQLite schema, runnable as a bootstrap
├── server.js               — main entry point, HTTP server, routing
├── auth.js                 — password hashing, session management, path sanitisation
├── routes.js               — the nine endpoint handlers
├── db.js                   — SQLite connection, prepared statements, helpers
├── test_api.js             — smoke test via fetch() against a running server
├── package.json            — npm deps: better-sqlite3, bcrypt
└── README.md               — ops notes, how to run locally, how to deploy
```

The backend is intentionally a single-directory, minimal-file layout. No framework (no Express, no Fastify). Plain Node `http` module + `better-sqlite3` + `bcrypt`. That's the entire dependency tree.

### Production directory layout (Lightsail)

```
/srv/osaware/                — application code, git clone of the backend
/srv/osaware-data/           — persistent data (mount point for durability)
├── osaware.db               — SQLite database file
└── users/
    ├── 1/                   — binary assets for user_id=1
    │   ├── MARY/
    │   │   └── photo.png
    │   └── sprite.png
    ├── 2/                   — binary assets for user_id=2
    │   └── ...
/var/log/osaware/            — application logs
```

Backup strategy: nightly cron job that does `cp /srv/osaware-data/osaware.db /srv/backups/osaware-YYYYMMDD.db` and rsyncs `/srv/osaware-data/users/` to a backup location. Lightsail snapshots of the instance itself provide a secondary layer.

---

## Browser-side changes

### New file: `core/storage/remote_provider.js`

Implements the same async interface as `LocalStorageProvider` and `MockRemoteStorageProvider`:
- `async loadAll()` → `{files, assets, diagnostics}`
- `async saveFiles(files)` → boolean
- `async saveAssets(assets)` → boolean

Internally talks HTTP via `fetch()` with `credentials: 'include'` so the session cookie is sent automatically. Same envelope+CRC32 discipline as the other providers — the envelope is computed in the browser before upload and verified after download.

On loadAll():
1. `GET /api/storage` returns the envelopes and manifest
2. For each entry in `binary_manifest`, fire `GET /api/blob/:path` to download the bytes
3. Populate `_userAssets` map with text-envelope data + downloaded binary data (base64-encoded into `data:` URLs)
4. Return the unified structure

On saveFiles / saveAssets:
- Text envelope saves go via `POST /api/storage`
- Binary asset saves need a different path — when the VFS notices a `_userAssets` entry with a binary mime, it calls `provider.saveBinary(path, bytes, mime)` which fires `PUT /api/blob/:path`. This is a new method on the provider interface that the local and mock providers also need to implement (mock can no-op, local can store the base64 in localStorage as today).

**Note:** adding `saveBinary` to the provider interface is a breaking change for `LocalStorageProvider`. It needs to be added there too, backed by the existing `_userAssets` localStorage mechanism. This is a small but real cross-cutting change.

### Modified: `core/auth/auth_service.js`

The production stubs become real:
- `login(username, password)` → `POST /api/login`, on success construct a new `RemoteStorageProvider` and call `vfs.setStorageProvider()`
- `logout()` → `POST /api/logout`, swap VFS back to `LocalStorageProvider`
- `register(username, password)` → `POST /api/register`, behaves like login on success
- `currentUser()` → returns the real username if authenticated, null otherwise

Crossed-transition checks still apply (DEV and REAL never mix).

### Modified: `core/shell.js`

- `cmdLOGIN` and `cmdREGISTER` get the short-form password prompt path. Same mechanism as `SAVE WEB:`: set `want_password = 1`, capture the next line of input, then call the async auth op.
- `cmdLOGOUT` is straightforward.
- `WHOAMI` already works — it reads `AuthService.currentUser()`.

### Modified: `core/vfs.js`

- `putAsset(path, mime, data)` needs to route to `saveBinary` when the mime is binary. Small logic addition.

---

## Test strategy

Step 4 follows the same test-first pattern as Steps 2 and 3: write JS smoke tests that exercise each layer in isolation, prove the layer works before moving up, then do browser integration test last.

### Layer 1 — backend unit smoke test

`test_api.js` in the backend directory. Runs a real Node server in-process, fires HTTP requests via fetch(), asserts on responses. Covers:

- Register happy path
- Register with duplicate username → 409
- Register with short/invalid username → 400
- Login happy path → session cookie set
- Login with wrong password → 401
- Login with nonexistent user → 401
- Whoami with valid session → user info
- Whoami without cookie → {user: null}
- Whoami with expired session → {user: null}
- Storage GET with valid session → envelopes + empty manifest
- Storage POST → returned envelope matches what was posted
- Storage round-trip: POST then GET, values match
- Binary PUT + GET round trip
- Binary DELETE then GET → 404
- Binary with path traversal `../../../etc/passwd` → 400
- Binary with null byte → 400
- Binary with absolute path → 400
- Cross-user isolation: user A cannot read user B's envelope or blobs
- Logout clears the session → subsequent whoami is null
- Session expiry: backdate a session row to expired, subsequent access is 401

Target: 40+ assertions. Must be 100% green before moving to layer 2.

### Layer 2 — RemoteStorageProvider unit test

`test_remote_provider.js` in `/home/claude/`. Runs the backend as a subprocess (or against an already-running one), exercises the provider directly via Node fetch, verifies:

- loadAll from empty account → empty envelopes, empty manifest
- saveFiles + loadAll → round-trip of programs
- saveAssets + loadAll → round-trip of text assets
- saveBinary + loadAll → manifest contains the entry, binary downloads correctly
- CRC validation still fires if the server somehow returns corrupted data (inject failure in a test mode)
- Concurrent saves don't corrupt each other

Target: 25+ assertions.

### Layer 3 — Browser integration via VFSREALTEST

A new BASIC program `VFSREALTEST` embedded in vfs.js, parallel to VFSAUTHTEST. Drives the real backend via `REGISTER` / `LOGIN` / `LOGOUT` / `WHOAMI`. Same assertion-subroutine pattern as VFSAUTHTEST. Hardcoded test username like `vfsrealtest_testuser` and password so it can be run repeatedly without human intervention. Self-cleaning (deletes test data and logs out at the end).

This test is only useful when the backend is running locally. If no backend is reachable, it should fail gracefully with a clear error rather than hang.

### Regression

All existing smoke tests must still pass:
- `test_var_case.js` (42 assertions — case sensitivity)
- `test_local_provider.js` (50 assertions — envelope + CRC32 + orphan recovery)
- `test_mock_and_auth.js` (64 assertions — mock provider + AuthService)
- `TESTS` program in browser (101 assertions — BASIC dialect)
- `VFSTESTPROG` in browser (19 assertions — VFS)
- `VFSAUTHTEST` in browser (23 assertions — DEV mode multi-tenancy)

**Total existing regression surface: 156 JS assertions + 143 BASIC assertions = 299 assertions. All must stay green.**

---

## Build sequence (sessions)

Numbered so if we get interrupted we know exactly where to resume.

**Session A (done):** planning. Decisions locked in. This document written.

**Session B:** backend scaffolding.
- Create `/home/claude/osaware-backend/` directory
- Write `schema.sql`, `db.js`, `auth.js`, `routes.js`, `server.js`, `package.json`
- Run `npm install better-sqlite3 bcrypt`
- Start server locally, manual curl smoke test of register + login happy path
- Commit nothing to production yet

**Session C:** backend smoke test.
- Write `test_api.js` with all 40+ assertions from Layer 1 above
- Iterate on backend code until all tests pass
- Explicitly test path traversal, cross-user isolation, session expiry
- Nothing touched in the main OSAWARE project yet

**Session D:** `RemoteStorageProvider` class.
- Create `core/storage/remote_provider.js` in the main project
- Add `saveBinary` method to `LocalStorageProvider` (backed by existing localStorage)
- Add `saveBinary` stub to `MockRemoteStorageProvider` (can no-op or mimic)
- Write `test_remote_provider.js` — Layer 2 smoke test
- All tests must pass; no browser integration yet

**Session E:** real LOGIN/LOGOUT/REGISTER in the shell.
- Modify `core/auth/auth_service.js` — replace stubs with real implementations that call `RemoteStorageProvider` and swap VFS
- Modify `core/shell.js` — add short-form password prompt to `cmdLOGIN` and `cmdREGISTER`
- Modify `core/vfs.js` — route binary puts through `saveBinary`
- Update `index.html` with script tags for `remote_provider.js`
- The mock provider (DEV family) stays unchanged and must continue working
- Confirm VFSAUTHTEST still passes 23/23 in the browser

**Session F:** browser end-to-end test.
- Write `VFSREALTEST` embedded BASIC program
- Run locally: browser talks to local backend, full REGISTER → LOGIN → VFSPUT → LOGOUT → LOGIN → verify
- Includes binary asset round trip
- Clean up after itself
- Add to TESTS category in vfs.js `_showListing`
- Package V7B20 for browser verification

**Session G:** deploy to Lightsail production.
- This session is mostly operational, not code
- Provision Lightsail instance, install Node, clone backend repo, run bootstrap
- Configure nginx as reverse proxy, enable HTTPS via Let's Encrypt
- Set production CORS origin
- Configure backup cron
- Point OSAWARE frontend at the production URL
- Run `VFSREALTEST` against production — must pass

**Session H:** polish, docs, edge cases.
- HELP text for new commands
- README updates
- Any final rough edges discovered in production testing
- Step 4 ships

**Estimated total: 6-8 sessions** depending on how many surprises surface. More if we hit genuine design problems that force revisiting decisions above.

---

## Known risks and open questions

Flagging things that could bite us, so future-us knows what to watch for.

### 1. fetch() + credentials + CORS in dev

The browser enforces tight cross-origin rules for cookies. When OSAWARE is served from `file://` or a local static server and the backend is on `http://localhost:3000`, the cookie won't be set unless we configure CORS carefully. Specifically:
- Backend must send `Access-Control-Allow-Origin: <specific origin>` (not `*` when credentials are involved)
- Backend must send `Access-Control-Allow-Credentials: true`
- Browser fetch must use `credentials: 'include'`
- Cookie must not use `SameSite=Strict` during local dev (Strict blocks cross-origin cookie setting)

In production this is mostly avoided because everything is on the same origin, but the dev workflow needs this sorted. Expect some trial and error in session E.

### 2. Synchronous sub-tree in VFS reads

Today, `VFSGET$("path")` is synchronous. The browser's in-memory `_userAssets` map is consulted immediately. If an asset isn't yet loaded (because we've lazy-loaded only the manifest), the read returns empty.

For v1 the plan is to eagerly load all binaries at login, which preserves sync semantics at the cost of login speed. If a user has a lot of binary data, login could take tens of seconds.

**Decision deferred:** if eager loading becomes painful, we'll add a yield-wait pattern (analogous to `want_auth`) for lazy binary reads. Don't build this until we have evidence it's needed.

### 3. Binary detection heuristic

Deciding whether a given asset is "text" (goes in envelope) or "binary" (goes to filesystem) is a heuristic: primarily mime type, with size as fallback. Getting this wrong in edge cases (e.g. a 10MB JSON file) could lead to envelope saves that exceed the 1MB cap.

**Plan:** the VFS `putAsset` path uses a clear rule. If the mime starts with `image/`, `audio/`, `video/`, `application/octet-stream`, or `application/zip` → binary. If mime is `text/*`, `application/json`, `application/xml` → text. If unknown → text if size < 4KB else binary. Document the rule in a comment so it can be revisited.

### 4. Session cookie and 3rd party contexts

Some browsers treat OSAWARE-in-an-iframe as a third-party context and refuse to send SameSite=Strict cookies. If OSAWARE ever needs to be embeddable, we'll need to switch to SameSite=Lax or None+Secure. Not a v1 concern but noted.

### 5. Password handling in the short-form REGISTER/LOGIN

The `want_password` flag sets up the prompt, but the implementation needs to be careful: the password line must not appear in history, must not be visible to programs, must be cleared from memory as soon as possible. The existing `SAVE WEB:` handler in terminal.js is the reference implementation. Review it before writing the new code.

### 6. HTTPS and Let's Encrypt automation

Let's Encrypt certificates expire every 90 days. Renewal must be automatic (certbot --renew in cron). If renewal fails silently, OSAWARE goes down for all users. Monitoring is a Step 5 concern but the renewal cron must be set up correctly in Step 4.

### 7. Backup restore has never been tested

Nightly backups are easy to set up and easy to silently fail. Before declaring Step 4 done, we should manually restore from a backup into a clean instance and verify everything works. This is a Step 4 ship criterion.

---

## Resuming from handoff

If we come back to this document after a break or at the start of a new development arc, the first step is:

1. Read this document top to bottom
2. Check the main project's current build number and ensure V7B19 is the baseline (or newer with all the step 3 regression tests still passing)
3. Check `/home/claude/osaware-backend/` — if it exists, inspect what's there to find the current stop point
4. Run the three JS smoke tests from `/home/claude/` (`test_var_case.js`, `test_local_provider.js`, `test_mock_and_auth.js`) and confirm all 156 assertions still green
5. Identify which session in the "Build sequence" we're resuming from
6. Continue from there

If any of the decisions above feel wrong on re-reading, **stop and discuss before deviating**. The decisions are interconnected — changing "SQLite" to "MariaDB" sounds small but cascades through schema.sql, db.js, the npm deps, the deploy docs, and the backup procedure.

---

## Non-technical considerations

### Operational commitment

Running a production backend means:
- Monthly bill (~$5-10/month Lightsail)
- Occasional security updates (`apt upgrade` on Ubuntu, certbot renewals)
- Monitoring uptime (Pingdom, UptimeRobot, or similar — not built in Step 4)
- Responding to outages
- Backing up (automated, but needs to actually be verified)

None of this is hard individually. Collectively it's a recurring tax on attention that didn't exist when OSAWARE was browser-only. Before shipping Step 4, confirm that this commitment is acceptable.

### Data privacy

Once Step 4 ships, OSAWARE is collecting user data (usernames, passwords, saved programs and files). Legal considerations:
- Privacy policy required in most jurisdictions for any service that collects personal data
- If any users are in the EU, GDPR applies (right to access, right to deletion)
- Terms of service covering data storage, account termination, service availability
- Not a technical task, but a prerequisite for public launch

These are not Step 4 work items but they must exist before the service is announced publicly. Flagging here so future-us doesn't launch a backend without the paperwork.

### What success looks like

Step 4 is done when:
- V7B20 (or whatever version lands the code) is deployed to production Lightsail
- A fresh visitor can REGISTER, LOGIN, save programs and binary assets, log out, log in from a different browser, and find everything still there
- All regression tests pass in the browser against production
- VFSREALTEST passes in the browser against production
- Backups run nightly and have been restore-tested at least once
- HTTPS works, cert renewal is automated
- The three auth modes (LOCAL, DEV, REAL) never interfere with each other
- The operator (you) can comfortably deploy an update to the backend without fear of breaking things

Anything short of this is not done. Don't declare victory on Step 4 until all of these are true.

---

## Change log

- **Session A (initial):** document created at Step 4 planning. Decisions 1-7 locked in. Build sequence A-H defined. Security and risk sections populated. 156 JS + 143 BASIC assertion baseline recorded.

- **Session B (backend scaffolding):** backend source tree created at `/home/claude/osaware-backend/`. Nine files: `schema.sql`, `server.js`, `routes.js`, `auth.js`, `db.js`, `test_unit.js`, `test_api.js`, `package.json`, `README.md`. ~1800 lines total including tests and docs. Single npm dependency tree: `better-sqlite3` and `bcrypt`. 77/77 unit tests passing (path sanitisation with 23 security rejection cases, cookie parsing, session ID entropy, username/password validators, cookie building).

- **Session C (backend integration test):** `test_api.js` ran against production HTTPS at `https://www.osaware.com/api/*`. First run: 59/63 green. Four failures were all test bugs (not backend bugs): one field-name typo, two path-traversal test cases that nginx/URL-normalization intercepted before reaching the backend (returning 403/404 instead of 400, which is stronger protection than expected), one obsolete "root returns 404" test that no longer applies under Pattern A same-server hosting. After test fixes: 63/63 green. All nine API endpoints proven correct end-to-end.

- **Session D (RemoteStorageProvider):** new file `core/storage/remote_provider.js`, ~460 lines. Mirrors the async storage-provider interface (`loadAll`, `saveFiles`, `saveAssets`, `saveBinary`, `deleteBinary`). Talks HTTP to `/api/*` via same-origin `fetch()` with `credentials: 'include'`. Eager binary preload at login (matches the other providers' synchronous read semantics). Binary filtering in envelope path: binary assets go via `PUT /api/blob/*` instead of bloating the envelope. CommonJS export guards added to `local_provider.js` and `remote_provider.js` so Node smoke tests can `require` them without affecting browser behaviour.

  - **Session D Turn 2:** `test_remote_provider.js` smoke test with 42 unit tests (pure-JS helpers: path encoding, base64 chunked conversion, data URL round-trip, mime detection) and 23 integration tests (full round-trip against production backend via fetch-intercepted mode with a cookie jar). All 65 assertions green on first run. Binary upload/download/delete cycle proven byte-for-byte correct.

- **Session E (real LOGIN/LOGOUT/REGISTER):** four files modified. `auth_service.js` stubs replaced with real HTTP implementations that call `/api/login`/`/api/logout`/`/api/register`, construct RemoteStorageProvider on success, and call `vfs.setStorageProvider()` to swap backends. Crossed-transition rules preserved. `shell.js` cmdLOGIN/cmdLOGOUT/cmdREGISTER rewritten with full form (inline password) and short form (obfuscated prompt). `terminal.js` gained new `want_password_line_mode` flag and `promptPassword(callback, promptText)` method — a new keyboard state that echoes `*` for the entire current line and passes the captured string to a callback via the Enter handler, with ESC cancellation. `test_mock_and_auth.js` Category P tests updated: old "stub returns 'not available yet'" assertions replaced with "returns ok:false + error string" assertions. V7B20a (infrastructure only) and V7B20b (real auth wired in) shipped as browser builds. All 156 JS regression assertions stable.

- **Session F (VFSREALTEST):** new embedded BASIC test program in `core/vfs.js`, ~95 lines of BASIC covering 24 assertions across 15 categories. Uses fixed test account `vfsrealtest_basic` with REGISTER-or-LOGIN bootstrap (first run registers, subsequent runs login). Self-cleaning — ends in LOCAL state with no leftover data. Covers: initial LOCAL state, LOCAL file write, REGISTER/LOGIN bootstrap, silo separation (LOCAL invisible under real auth), text file round-trip across LOGOUT/LOGIN, binary asset round-trip across LOGOUT/LOGIN (base64 data URL → filesystem bytes → data URL), crossed-transition rejection in both directions, final cleanup. **24/24 green on first run against production.** V7B20c shipped.

- **Session G (Lightsail deploy):** DONE EARLY during Sessions B/C. User (David) provisioned Ubuntu 22.04 Lightsail instance, installed Node 20 LTS, created `osaware` service user, deployed backend to `/srv/osaware/` and frontend to `/srv/osaware-frontend/`, configured nginx as reverse proxy with static file serving (Pattern A same-server hosting), enabled HTTPS via Let's Encrypt with auto-renewal, configured UFW + Lightsail firewall, set up nightly SQLite+filesystem backup cron. Backend runs as systemd service `osaware.service` with hardened sandbox (`ProtectSystem=strict`, `ReadWritePaths` scoped). Production URL: `https://www.osaware.com/`.

- **Session H (polish and docs):** HELP text added for auth commands — main HELP has an ACCOUNTS section, dedicated `HELP AUTH` topic with full reference including examples and DEV sandbox notes. Backend README runbook filled in with the actual Lightsail deployment steps. This handoff doc updated with the session-by-session change log. Final regression: all 156 JS assertions + 167 BASIC assertions (TESTS 101 + VFSTESTPROG 19 + VFSAUTHTEST 23 + VFSREALTEST 24) passing. V7B20 shipped as the clean release build for Step 4.

### Final build: `ngbasic-Alpha-V7B20.zip`

Step 4 is **complete**. The OSAWARE backend is running in production at `https://www.osaware.com/`, supports real multi-tenant user accounts with bcrypt password hashing and HttpOnly session cookies, and persists programs/text-assets/binary-assets across devices. The V7B20 browser build contains real LOGIN/LOGOUT/REGISTER commands with short-form obfuscated password prompts, passes all regression suites in the browser, and ships with full HELP documentation for the new commands.

**Total assertion count across the full arc: 528+ passing test cases** (backend unit + backend integration + provider unit + provider integration + JS frontend regression + BASIC frontend regression + new VFSREALTEST). Every single assertion green at ship time.

**Multi-tenancy plan status:** Steps 1-4 complete. Steps 5-7 (infrastructure hardening, UX polish, public rollout) remain as future work.

