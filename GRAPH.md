# Project Graph — VibeValuer

## Architecture

```
Browser (index.html → app.js → styles.css)
    │
    ├── HTTP/SSE/WebSocket → server.js:4310
    │                              │
    │                              ├── src/scoring.js    [LEVELS[30], calculateXp, getMetrics, getLevel]
    │                              ├── src/validate.js   [validateRunInput]
    │                              ├── src/db.js        [SQLite: agents, runs, audit_log, agent_registry, fraud_proofs, appeals, onboarding_agents]
    │                              ├── src/identity.js  [createChallenge, verifyWalletSignature]
    │                              ├── src/auth.js      [HMAC-SHA256 auth, loadSecrets]
    │                              ├── src/jwt.js       [JWT sign/verify]
    │                              ├── src/session.js   [login, cookie sessions, securityStatus]
    │                              ├── src/events.js    [EventHub, SSE stream, WebSocket broadcast]
    │                              ├── src/vibe-adapter.js [Vibe API, on-chain evidence verification]
    │                              ├── src/sync-worker.js  [Vibe indexer crawler]
    │                              ├── src/watchtower.js  [fraud pattern detection: duplicates, sybil]
    │                              ├── src/correlate.js   [run/agent correlation view]
    │                              ├── src/backup.js      [SQLite backups]
    │                              ├── src/rate-limit.js  [per-role rate limiting]
    │                              └── src/slasher.js     [XP penalty for fraud]
    │
    └── docs/
            ARCHITECTURE.md   ← system graph, data flow, file inventory
            SPEC.md           ← machine-readable: API endpoints, entity schemas, XP formula
            GUIDE.md          ← human user guide: pages, XP table, permissions
            GRAPH.md          ← this file: quick reference
```

## Key Concepts

| Concept | Location |
|---------|----------|
| Level system (30 levels) | src/scoring.js:LEVELS |
| XP calculation | src/scoring.js:calculateXp |
| Auth (HMAC + JWT + Wallet) | src/auth.js + src/identity.js + src/session.js |
| Real-time events | src/events.js:EventHub |
| Vibe blockchain indexer | src/sync-worker.js |
| On-chain evidence | src/vibe-adapter.js:verifyOnchainEvidence |
| EIP-4361 Sign-In with Ethereum | server.js:/api/auth/eth/challenge + /api/auth/eth/verify |

## NPM Scripts

```bash
npm start        # node server.js (port 4310)
npm run check    # node --check all .js files
npm run qa:smoke # smoke test (smoke.cjs)
```

## Environment Variables (.env)

| Variable | Required | Purpose |
|----------|----------|---------|
| `VALUER_ADMIN_SECRET` | Yes (prod) | Admin HMAC/JWT secret (64 hex chars) |
| `VALUER_AGENT_SECRET` | Yes (prod) | Agent HMAC/JWT secret (64 hex chars) |
| `VALUER_SESSION_SECRET` | Yes (prod) | JWT signing (64 hex chars) |
| `VALUER_HARDENED` | Yes | `1` = block default secrets, require proper auth |
| `VALUER_USERS_JSON` | No | JSON array of `{username, role, passwordHash}` for session auth |
| `NODE_ENV` | No | `production` enables hardened mode |
| `PORT` | No | Server port (default 4310) |
| `VALUER_SESSION_TTL_MS` | No | Session TTL (default 43200ms = 12h) |
| `AUTO_SYNC_WORKER` | No | `1` = start Vibe sync worker on boot |
| `SYNC_INTERVAL_MS` | No | Worker tick interval (default 300000ms = 5min) |
| `REQUIRE_AGENT_AUTH` | No | `1` = require HMAC for run recording |
| `VIBE_RPC_URL` | No | Custom RPC URL (default: Robinhood testnet 46630) |

> `.env` is loaded at server startup before any other module.
> Generated with: `node -e "const crypto=require('crypto'); console.log([...Array(3)].map(()=>crypto.randomBytes(32).toString('hex')).join('\n'))"`

## Complete API Routes

```
GET  /api/health              — health check (public)
GET  /api/security/status     — security posture (public)
GET  /api/auth/me           — alias: current session info (same as /api/auth/session)
POST /api/auth/login         — username+password → JWT cookie (HttpOnly)
POST /api/auth/logout        — clear session cookie
GET  /api/auth/session       — current session info (alias: /api/auth/me)

# Auth: Passkey-style (HMAC challenge/response)
POST /api/auth/passkey/challenge — generate HMAC challenge nonce
POST /api/auth/passkey/verify    — verify HMAC response → JWT

# Auth: EIP-4361 Sign-In with Ethereum
POST /api/auth/eth/challenge     — generate EIP-4361 message, nonce, expiry
POST /api/auth/eth/verify       — verify signature → JWT cookie

# Agents & Levels
GET  /api/agents              — all agents with computed metrics + levels
GET  /api/levels              — 30-level progression matrix
GET  /api/summary             — aggregate metrics, evidence breakdown
GET  /api/public/agents       — public leaderboard (sort by xp/autonomy/evidence)

# Runs
GET  /api/runs                — all runs (filter by agentId)
POST /api/runs                — record a run (HMAC or session auth)

# Registry
GET  /api/registry            — all registry entries + counts
GET  /api/registry/creators   — creators with launch counts
GET  /api/registry/sync-state — sync state + worker status
POST /api/registry/import     — bulk import agents (admin)
POST /api/registry/challenge   — create link challenge
POST /api/registry/link       — link registry entry to agent (admin)

# Onboarding wizard
POST /api/onboarding/register    — step 1: register agent name
GET  /api/onboarding/challenge   — step 2: get wallet challenge
POST /api/onboarding/verify      — step 2: verify wallet signature
POST /api/onboarding/finalize    — step 3: finalize → create scored agent
GET  /api/onboarding/agents      — list onboarding agents (admin)

# Appeals
GET  /api/appeals             — list appeals (filter by status/agentId)
POST /api/appeals             — submit appeal
POST /api/appeals/:id/decide  — decide appeal (admin)

# Vibe blockchain
GET  /api/vibe/index          — network status (chain ID, latest block)
GET  /api/vibe/launches       — Vibe launch index (paginated)
POST /api/vibe/verify-tx      — verify on-chain transaction receipt

# Correlate
GET  /api/correlate/run?runId=    — full run correlation (DB + audit + chain)
GET  /api/correlate/agent?agentId= — agent correlation summary

# Watchtower
GET  /api/watchtower/duplicates   — duplicate evidence scan
GET  /api/watchtower/sybil?threshold=2 — Sybil pattern scan
POST /api/watchtower/run           — run watchtower (admin)

# Worker (admin auth required)
GET  /api/worker/status     — worker running status
POST /api/worker/start      — start sync worker (alias: /api/admin/worker/start)
POST /api/worker/stop       — stop sync worker (alias: /api/admin/worker/stop)
POST /api/worker/sync-now   — trigger immediate sync (alias: /api/admin/worker/sync)

# Admin (admin/owner session required)
POST /api/admin/worker      — start/stop/status/run_once Vibe sync worker
POST /api/backup/create     — create backup (alias: /api/admin/backup)
POST /api/reputation/decay   — run decay (alias: /api/admin/decay)
POST /api/registry/cleanup-stale — cleanup stale (alias: /api/admin/cleanup)
POST /api/export            — export snapshot (alias: /api/admin/export)
POST /api/admin/backup       — create SQLite backup
GET  /api/admin/backups     — list backups
POST /api/admin/decay       — run reputation decay
POST /api/admin/slash      — slash agent XP (owner)
POST /api/admin/export      — export full snapshot
POST /api/admin/cleanup     — cleanup stale registry entries
POST /api/admin/recompute   — recompute agent evaluation

# Audit
GET  /api/audit             — audit log (limit, action, agentId filters)

# Real-time
GET  /api/events/stream     — SSE event stream (EventSource)
WS   /api/events/ws         — WebSocket (HMAC-authenticated)
GET  /api/events/recent     — recent events (sinceTs/sinceId)
```

## Database Schema (SQLite)

- **agents** — id, name, role, status, manual_actions, delegated_tasks, automated_runs
- **runs** — id, agent_id, kind, complexity, trigger, status, verification, human_interventions, safety_incident, parent_task_id, idempotency_key, xp_awarded, evidence_json, policy_violation, created_at
- **audit_log** — id, action, actor, agent_id, run_id, details, level, created_at
- **agent_registry** — id, name, role, source, status, evidence_status, chain_id, token_id, creator_address, launch_id, symbol, lifecycle, as_of_block, evaluated, linked_agent_id, link_status, discovered_at, updated_at
- **registry_sync_state** — source, cursor, last_block, last_imported, pages_total, status, last_error, checked_at, updated_at, resumed_at
- **fraud_proofs** — id, agent_id, run_id, reason, tx_hash, witness, payload, actor, created_at
- **appeals** — id, agent_id, run_id, reason, evidence_url, status, decision, reviewer, created_at, updated_at
- **onboarding_agents** — id, name, wallet_address, email, status, challenge_nonce, challenge_expires, registered_at, updated_at

## Links

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — full system graph, data flow
- [SPEC.md](docs/SPEC.md) — API + entities machine-readable spec
- [GUIDE.md](docs/GUIDE.md) — human user guide
