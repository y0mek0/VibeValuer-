# VibeValuer

> **Local-first agent evaluation dashboard.** Score AI agents on what they actually do — verified runs, on-chain receipts, real outcomes — not on chat volume or self-reported claims.

[![Node](https://img.shields.io/badge/node-%E2%89%A524-339933)]() [![License](https://img.shields.io/badge/license-MIT-blue)]() [![Vibe Indexer](https://hyperliquid-testnet.cloud.blockscout.com/)]()

## What this is

VibeValuer is a single-page dashboard + REST API that scores **agent work** from 0 to 30 by a deterministic, reproducible XP formula. Three signals matter:

1. **Identity** — creator/agent linked via on-chain wallet signature (EIP-4361).
2. **Evidence** — `user_recorded`, `runtime_event`, or `onchain_tx` receipt with verified status.
3. **Reputation** — duplicate evidence gets slashed by the watchtower; stale agents are demoted.

Once an agent has at least one **onchain_tx** receipt with `receipt_status='success'`, it gets evaluated. Otherwise it stays in the `discovered` registry with no level, no XP.

```
discovered (registry, no level)
   ↓ link via wallet signature
linked (identity bound, but no evidence)
   ↓ first successful on-chain run
evaluated (level + XP + audit trail)
```

## Why local-first

No cloud. The whole stack is a Node 18+ process with SQLite. You can audit the database file at `data/valuer.sqlite`. There is no telemetry, no CDN, no third-party auth. The `.env` file holds the secrets and that file never gets committed.

## Quickstart

```bash
# 1. Clone
git clone https://github.com/y0mek0/VibeValuer-.git
cd VibeValuer-

# 2. Install (Node 18+, no other deps required)
npm install

# 3. Generate a local secrets bundle (writes .env with random secrets)
node scripts/init-secrets.cjs

# 4. Start
npm start
# → http://127.0.0.1:4310/

# 5. Login with the creds shown in the .env file
# Default dev roles:
#   owner / <printed at init>   ← full access
#   admin / <printed at init>   ← trust ops
#   agent / <printed at init>   ← write-only
#   viewer / <printed at init>  ← read-only
```

Once logged in, the dashboard shows real state from your local SQLite file.

## What you can do

| Persona | What they do |
|---|---|
| **Owner / admin** | Run watchtower, decay reputation, slash fraud, sync Vibe indexer, export snapshots |
| **Moderator** | Approve/reject appeals agents file against rejected evidence |
| **Agent** | Submit runs with on-chain evidence, view own level/XP trajectory |
| **Viewer** | Browse public ranking, see trust-flow diagram |

See [`docs/OPERATOR.md`](docs/OPERATOR.md) for the full action reference and [`docs/AGENTS.md`](docs/AGENTS.md) for how an agent connects.

## Architecture (one paragraph)

Browser SPA (`public/`) → Node HTTP server (`server.js`, vanilla `http` + if-chain routing) → SQLite (`src/db.js`) + Vibe indexer (`src/vibe-adapter.js`).

Auth is HttpOnly cookie HMAC + optional EIP-4361 wallet signature. The 30 levels are encoded in `src/scoring.js` (`LEVELS` array, xp/manual/delegated/automated thresholds + transition gates at 5/10/15/20/25/30).

Full architecture, data flow, and file inventory in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API (TL;DR)

Read-only:
- `GET /api/health` — liveness
- `GET /api/agents` — list with level + metrics
- `GET /api/levels` — 30 levels
- `GET /api/registry`, `/api/registry/creators`, `/api/registry/sync-state`
- `GET /api/public/agents` — anonymous, read-only
- `GET /api/summary` — totals + breakdown

Mutating (requires login):
- `POST /api/auth/login` → JWT cookie
- `POST /api/auth/eth/challenge` + `/verify` — EIP-4361 wallet signature
- `POST /api/runs` — record a verified run
- `POST /api/onboarding/*` — claim → verify → first run wizard
- `POST /api/appeals/decide` — moderation
- `POST /api/admin/*` — backup, decay, recompute, cleanup, watchtower

Full reference: [`docs/SPEC.md`](docs/SPEC.md) — every endpoint, every field, every validation rule.

## Scripts

| Script | Purpose |
|---|---|
| `npm start` | Run server at `http://127.0.0.1:4310/` |
| `npm run check` | `node --check` on every JS file (CI gate) |
| `npm run qa:smoke` | End-to-end smoke test (`scripts/smoke.cjs`) |
| `node scripts/init-secrets.cjs` | Generate `.env` with random secrets |
| `node scripts/create-agent.mjs <name>` | Helper to insert a test agent via direct SQL |
| `node scripts/backup.mjs` | Manual snapshot to `data/backups/` |
| `node scripts/cleanup-logs.mjs` | Rotate `server.log` |

`scripts/` directory holds all operator tooling — keep them pure Node, no external services.

## Project layout

```
.
├── server.js               # HTTP server + routing (vanilla http)
├── public/                 # Browser SPA
│   ├── index.html          # All views
│   ├── app.js              # State + render functions
│   └── styles.css          # Dark/quant styling
├── src/                    # Backend modules
│   ├── db.js               # SQLite schema + queries
│   ├── scoring.js          # LEVELS array + XP formula
│   ├── validate.js         # Run input validation
│   ├── session.js          # Auth + role model
│   ├── vibe-adapter.js     # On-chain receipt verification
│   ├── auth.js             # HMAC signing
│   ├── identity.js         # EIP-4361 challenges
│   ├── sync-worker.js      # Polls Vibe indexer
│   ├── events.js           # SSE/WS hub
│   ├── correlate.js        # Agent ↔ run correlation
│   ├── watchtower.js       # Fraud detection
│   ├── backup.js           # Snapshot/restore
│   ├── ratelimit.js        # Per-IP throttling
│   ├── slasher.js          # XP reduction
│   └── jwt.js               # HMAC-SHA256 JWT
├── scripts/                # Operator scripts (Node)
├── docs/                   # Markdown documentation
├── data/                   # Local SQLite + backups (.gitignored)
├── .env                    # Secrets bundle (.gitignored)
├── .env.example            # Template for new contributors
└── package.json
```

## Documentation map

| Doc | Audience |
|---|---|
| [`README.md`](README.md) | First-time visitors |
| [`GRAPH.md`](GRAPH.md) | Quick reference — every endpoint, every event |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Engineers touching internals |
| [`docs/SPEC.md`](docs/SPEC.md) | API consumers (machine-readable schemas) |
| [`docs/GUIDE.md`](docs/GUIDE.md) | End-user product walkthrough |
| [`docs/OPERATOR.md`](docs/OPERATOR.md) | Owner/admin running the dashboard |
| [`docs/AGENTS.md`](docs/AGENTS.md) | New agents wiring their first run |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | When something breaks |

## License

MIT. See `LICENSE`.
