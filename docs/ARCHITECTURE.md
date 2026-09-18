# Architecture — VibeValuer

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                         │
│  index.html + app.js + styles.css                               │
│  └── Views: Overview | Agents | Levels | Runs | Discovery      │
│              Public | Audit | Admin | Moderation | Onboarding   │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP / SSE / WebSocket
┌──────────────────────▼──────────────────────────────────────────┐
│                     server.js (port 4310)                       │
│  ├── HTTP Server (Node.js built-in http module)                 │
│  ├── REST Routes (JSON API)                                    │
│  ├── WebSocket (/api/events/ws)                                │
│  └── SSE Stream (/api/events/stream)                           │
│                                                                  │
│  Dependencies (require):                                        │
│  ├── dotenv               — .env loader (MUST be first)         │
│  ├── src/scoring.js      — LEVELS[30], XP table, calculateXp  │
│  ├── src/validate.js     — validateRunInput                     │
│  ├── src/db.js           — SQLite wrapper, schema, queries    │
│  ├── src/vibe-adapter.js — Vibe API, on-chain evidence         │
│  ├── src/identity.js     — wallet challenge/sign (SIWE)         │
│  ├── src/auth.js         — HMAC auth, loadSecrets              │
│  ├── src/jwt.js          — JWT session tokens                  │
│  ├── src/session.js     — login, cookie sessions, securityStatus│
│  ├── src/sync-worker.js  — Vibe indexer crawler                │
│  ├── src/rate-limit.js   — per-role request limiting           │
│  ├── src/backup.js       — SQLite backups                      │
│  ├── src/slasher.js      — XP penalty for policy violations   │
│  ├── src/events.js       — EventHub, SSE, WebSocket broadcast  │
│  ├── src/correlate.js    — run/agent correlation               │
│  └── src/watchtower.js   — fraud pattern detection              │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
User Action
    │
    ▼
app.js (frontend)
    │ fetch() / WebSocket
    ▼
server.js (HTTP handler)
    │ route: POST /api/runs
    ▼
validateRunInput()  ──► reject bad input
    │
    ▼
calculateXp()      ──► compute XP from run
    │
    ▼
db.js              ──► persist to SQLite
    │
    ▼
hub.emit()         ──► SSE + WebSocket broadcast
    │
    ▼
app.js (frontend)  ──► DOM update
```

## Agent Lifecycle

```
DISCOVERED ──(link + sign)──► LINKED ──(finalize)──► UNVERIFIED
                                                              │
                                           (first verified run)
                                                              │
                                                              ▼
                                                           ACTIVE
                                                              │
                                                   (runs accumulate XP)
                                                              │
                                                              ▼
                                                         WATCHING ◄── (no runs 30d)
                                                              │
                                                   (verified run appears)
                                                              │
                                                              ▼
                                                           ACTIVE
```

## Level System (src/scoring.js)

- 30 levels, XP-gated
- Transition levels (5, 10, 15, 20, 25, 30) mark autonomy milestones
- Level = max of manual + delegated + automated counts AND XP threshold

```
LVL 1   Manual start           XP: 0
LVL 5   First working agent    XP: 18    ← transition
LVL 10  Automation enabled     XP: 120   ← transition
LVL 15  Independent operator   XP: 350   ← transition
LVL 20  Office runs itself    XP: 800   ← transition
LVL 25  Agent team            XP: 1700  ← transition
LVL 30  Agent organization    XP: 3500  ← transition
```

## Auth System

Three auth mechanisms:

| Layer | Method | Used by |
|-------|--------|---------|
| HMAC-SHA256 | `x-valuer-signature` header | Agents, Admins (API calls) |
| JWT session | `valuer_session` HttpOnly cookie | Browser UI |
| EIP-4361 SIWE | Ethereum wallet sign → verify → JWT | Onboarding, Web3 wallet login |

- `VALUER_HARDENED=1` blocks default secrets, requires real `.env` values
- Roles: `owner > admin > agent > viewer`
- Onboarding wizard: `register → eth/challenge → eth/verify → finalize → scored agent`

## Event Types (SSE/WebSocket)

```
run.recorded         run.evidence_rejected    run.idempotent_replay
registry.sync_vibe   registry.import           registry.link
registry.verify_link registry.challenge        registry.recompute
registry.cleanup_stale
reputation.decay     fraud.proof.recorded     worker.sync_vibe
system.heartbeat
```

## File Inventory

```
server.js              651 lines  Entry point, HTTP router, all API routes + dotenv
src/
  scoring.js            86 lines  LEVELS[], calculateXp(), getMetrics(), getLevel()
  validate.js           65 lines  validateRunInput(), VALID_EVIDENCE_OPERATIONS
  db.js               257 lines  SQLite schema + all queries
  vibe-adapter.js     145 lines  Vibe API, on-chain evidence verification
  identity.js          51 lines  createChallenge(), verifyWalletSignature()
  auth.js              56 lines  HMAC auth, loadSecrets()
  jwt.js               48 lines  JWT sign/verify
  session.js          116 lines  login, cookie sessions, securityStatus, ROLES, VALUER_USERS_JSON
  events.js            90 lines  EventHub, SSE, WebSocket
  sync-worker.js       73 lines  Vibe indexer crawler
  watchtower.js        71 lines  fraud pattern detection
  correlate.js          51 lines  run/agent correlation
  backup.js            55 lines  SQLite backup
  rate-limit.js        36 lines  per-role rate limiting
  slasher.js           22 lines  XP penalty
public/
  index.html           UI markup + view sections + dialogs
  app.js               render functions, state management, API calls
  styles.css           dark theme, acid lime/violet, square panels
scripts/
  mvp-onboarding.cjs   End-to-end onboarding test
  test-onboarding.cjs  Subprocess server + test runner
  smoke.cjs            QA smoke test
docs/
  ARCHITECTURE.md      This file — system graph
  SPEC.md              Machine-readable API/entity spec
  GUIDE.md             Human user guide
  GRAPH.md             Quick reference at root
```

## Database Schema (SQLite)

```
agents                  id, name, role, status, manual_actions, delegated_tasks, automated_runs
runs                    id, agent_id, kind, complexity, trigger, status, verification,
                        human_interventions, safety_incident, parent_task_id, idempotency_key,
                        xp_awarded, evidence_json, policy_violation, created_at
audit_log               id, action, actor, agent_id, registry_id, run_id, details, level, created_at
agent_registry          id, name, role, source, status, evidence_status, chain_id, token_id,
                        creator_address, launch_id, symbol, lifecycle, as_of_block, evaluated,
                        linked_agent_id, link_status, discovered_at, updated_at
registry_sync_state     source, cursor, last_block, last_imported, pages_total, status,
                        last_error, checked_at, updated_at, resumed_at
fraud_proofs            id, agent_id, run_id, reason, tx_hash, witness, payload, actor, created_at
appeals                 id, agent_id, run_id, reason, evidence_url, status, decision,
                        reviewer, created_at, updated_at
onboarding_agents       id, name, wallet_address, email, status, challenge_nonce,
                        challenge_expires, registered_at, updated_at
```

See `docs/SPEC.md` for full entity definitions.

## Security Posture

- `VALUER_HARDENED=1` in `.env` → blocks default secrets, requires real 256-bit keys
- `.env` loaded via `require('dotenv').config()` at the VERY TOP of server.js before any other require
- `VALUER_USERS_JSON` → JSON array of `{username, role, passwordHash}` for browser-based session auth
- Roles: `owner, admin, agent, viewer` — checked via `requireRole()` middleware on all admin routes
- EIP-4361 nonce expires in 10 minutes, single-use
- HMAC signatures require timestamp within 5 minutes
- Rate limiting per role per endpoint
- Audit log for all state-changing operations
