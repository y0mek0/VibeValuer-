# SPEC — Machine-Readable System Specification

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | — | Health check |
| GET | `/api/security/status` | — | Security posture (hardened, problems) |
| GET | `/api/summary` | — | Aggregate metrics, evidence breakdown |
| GET | `/api/agents` | — | All agents with computed metrics + levels |
| GET | `/api/levels` | — | 30-level progression matrix |
| GET | `/api/public/agents` | — | Public leaderboard (sort by xp/autonomy/evidence) |
| GET | `/api/runs` | — | All runs (filter by agentId) |
| POST | `/api/runs` | HMAC/session | Record a run |
| **Auth — Login / Session** |
| POST | `/api/auth/login` | — | username+password → JWT HttpOnly cookie |
| POST | `/api/auth/logout` | — | Clear session cookie |
| GET | `/api/auth/session` | — | Current session info |
| GET | `/api/auth/me` | — | Alias for `/api/auth/session` (frontend compat) |
| POST | `/api/auth/token` | admin HMAC | Issue JWT for actor+role |
| **Auth — Passkey-style** |
| POST | `/api/auth/passkey/challenge` | — | Generate HMAC challenge nonce |
| POST | `/api/auth/passkey/verify` | — | Verify HMAC response → JWT |
| **Auth — EIP-4361 Sign-In with Ethereum** |
| POST | `/api/auth/eth/challenge` | — | Generate EIP-4361 message, nonce, expiry |
| POST | `/api/auth/eth/verify` | — | Verify signature → JWT cookie |
| **Registry** |
| GET | `/api/registry` | — | All registry entries + counts |
| GET | `/api/registry/creators` | — | Creators with launch counts |
| GET | `/api/registry/sync-state` | — | Sync state + worker status |
| POST | `/api/registry/import` | admin | Bulk import agents |
| POST | `/api/registry/challenge` | — | Create link challenge |
| POST | `/api/registry/link` | admin | Link registry entry to agent |
| **Onboarding Wizard** |
| POST | `/api/onboarding/register` | — | Step 1: register agent name |
| GET | `/api/onboarding/challenge` | — | Step 2: get wallet challenge |
| POST | `/api/onboarding/verify` | — | Step 2: verify wallet signature |
| POST | `/api/onboarding/finalize` | — | Step 3: finalize → create scored agent |
| GET | `/api/onboarding/agents` | — | List onboarding agents (admin) |
| **Appeals** |
| GET | `/api/appeals` | — | List appeals (filter by status/agentId) |
| POST | `/api/appeals` | viewer | Submit appeal |
| POST | `/api/appeals/:id/decide` | admin | Decide appeal |
| **Worker** |
| GET | `/api/worker/status` | — | Worker running status |
| POST | `/api/worker/start` | admin | Start sync worker |
| POST | `/api/worker/stop` | admin | Stop sync worker |
| POST | `/api/worker/sync-now` | admin | Trigger immediate sync |
| **Vibe Blockchain** |
| GET | `/api/vibe/index` | — | Network status (chain ID, latest block) |
| GET | `/api/vibe/launches` | — | Vibe launch index (paginated) |
| POST | `/api/vibe/verify-tx` | — | Verify on-chain transaction receipt |
| **Correlate** |
| GET | `/api/correlate/run` | — | Full run correlation (DB + audit + chain) |
| GET | `/api/correlate/agent` | — | Agent correlation summary |
| **Watchtower** |
| GET | `/api/watchtower/duplicates` | — | Duplicate evidence scan |
| GET | `/api/watchtower/sybil` | — | Sybil pattern scan |
| POST | `/api/watchtower/run` | admin | Run watchtower |
| **Admin** |
| POST | `/api/admin/worker` | admin | start/stop/status/run_once sync worker |
| POST | `/api/admin/backup` | admin | Create SQLite backup |
| GET | `/api/admin/backups` | admin | List backups |
| POST | `/api/admin/decay` | admin | Run reputation decay |
| POST | `/api/admin/slash` | owner | Slash agent XP |
| POST | `/api/admin/export` | admin | Export full snapshot |
| POST | `/api/admin/cleanup` | admin | Cleanup stale registry entries |
| POST | `/api/admin/recompute` | admin | Recompute agent evaluation |
| **Admin Aliases** (frontend compat routes) |
| POST | `/api/backup/create` | admin | Alias: /api/admin/backup |
| POST | `/api/reputation/decay` | admin | Alias: /api/admin/decay |
| POST | `/api/registry/cleanup-stale` | admin | Alias: /api/admin/cleanup |
| POST | `/api/export` | admin | Alias: /api/admin/export |
| POST | `/api/appeals/decide` | admin | Alias: /api/appeals/:id/decide |
| **Audit** |
| GET | `/api/audit` | — | Audit log (limit, action, agentId filters) |
| **Real-time** |
| GET | `/api/events/stream` | — | SSE event stream (EventSource) |
| WS | `/api/events/ws` | HMAC | WebSocket |
| GET | `/api/events/recent` | — | Recent events (sinceTs/sinceId) |

## Entity Schemas

### Agent
```json
{
  "id": "string",
  "name": "string",
  "role": "string",
  "status": "string",
  "manualActions": "number",
  "delegatedTasks": "number",
  "automatedRuns": "number",
  "runs": "[Run]",
  "metrics": {
    "xp": "number",
    "completed": "number",
    "verified": "number",
    "automated": "number",
    "interventions": "number",
    "safetyIncidents": "number",
    "successRate": "number (0-100)",
    "autonomyRate": "number (0-100)",
    "evidenceRate": "number (0-100)"
  },
  "level": { "level": "number (1-30)", "name": "string" },
  "levelName": "string"
}
```

### Run
```json
{
  "id": "string",
  "agentId": "string",
  "kind": "manual|simple|verified|automated|multiStep|recovery|delegated|critical",
  "complexity": "number (1-10)",
  "trigger": "user|agent|schedule|event",
  "status": "completed|partial|failed|blocked|waiting_approval|simulated|reverted",
  "verification": "verified|user_confirmed|unverified|simulated",
  "humanInterventions": "number",
  "safetyIncident": "boolean",
  "parentTaskId": "string|null",
  "idempotencyKey": "string|null",
  "xpAwarded": "number",
  "evidence": {
    "source": "runtime_event|api_webhook|user_recorded|onchain_tx|runtime_agent|unknown",
    "operation": "simulation|real_operation|onboarding_first_run|unknown",
    "sourceEventId": "string|null",
    "verificationMethod": "string|null",
    "chainId": "number",
    "blockNumber": "number",
    "receiptStatus": "string|null",
    "txHash": "string|null",
    "expectedFrom": "string|null",
    "expectedTo": "string|null",
    "approval": "boolean",
    "limits": "string|null",
    "collectedAt": "string|null"
  },
  "policyViolation": "boolean",
  "createdAt": "ISO8601"
}
```

### OnboardingAgent
```json
{
  "id": "string",
  "name": "string",
  "walletAddress": "string|null",
  "email": "string|null",
  "status": "pending_wallet|pending_verification|wallet_verified|completed",
  "challengeNonce": "string|null",
  "challengeExpires": "ISO8601|null",
  "registeredAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

### RegistryEntry
```json
{
  "id": "string",
  "name": "string",
  "role": "string|null",
  "source": "local_ledger|vibe_indexer|external_import",
  "status": "string",
  "evidenceStatus": "unavailable|verified|runtime_verified|stale|slashed",
  "chainId": "number|null",
  "tokenId": "string|null",
  "creatorAddress": "string|null",
  "launchId": "string|null",
  "symbol": "string|null",
  "lifecycle": "string|null",
  "asOfBlock": "number|null",
  "evaluated": "boolean",
  "linkedAgentId": "string|null",
  "linkStatus": "unlinked|linked_unverified|linked_verified|evaluated",
  "discoveredAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

## Level Transition Table

| Level | Name | XP Required | Manual | Delegated | Automated |
|-------|------|------------|--------|-----------|-----------|
| 1 | Manual start | 0 | 1 | 0 | 0 |
| 5 | First working agent | 18 | 15 | 2 | 0 |
| 10 | Automation enabled | 120 | 50 | 50 | 10 |
| 15 | Independent operator | 350 | 100 | 150 | 125 |
| 20 | Office runs itself | 800 | 175 | 350 | 400 |
| 25 | Agent team | 1700 | 275 | 850 | 1250 |
| 30 | Agent organization | 3500 | 500 | 2000 | 3000 |

## XP Calculation

```
base = XP_TABLE[kind]
  manual=1, simple=3, verified=6, automated=10,
  multiStep=20, recovery=8, delegated=25, critical=30

complexityMultiplier = 1 + (complexity - 1) * 0.15
evidenceMultiplier  = verified ? 1 : user_confirmed ? 0.5 : 0
outcomeMultiplier   = completed ? 1 : partial ? 0.5 : 0
reviewBoost        = evidenceReviewed ? 1 : 0.9

xp = round(base * complexityMultiplier * evidenceMultiplier * outcomeMultiplier * reviewBoost)
xp = 0 if policyViolation || simulated || !evidence || !successful_outcome
```

## Auth Header Format (HMAC)

```
x-valuer-actor:     <actor-id>
x-valuer-timestamp:  <unix-ms>
x-valuer-signature:  <hmac-sha256(secret, timestamp.method.path.body)>
```

Timestamp must be within 5 minutes of server time.

## EIP-4361 Sign-In with Ethereum

**Challenge request:**
```
POST /api/auth/eth/challenge
{ "address": "0x...", "chainId": 46630, "domain": "app.vibeagents.local" }
```

**Challenge message format:**
```
app.vibeagents.local wants you to sign in with your Ethereum account:
0x...

Sign in to VibeValuer with your Ethereum wallet.
This is a read-only authentication — no transaction is sent.

URI: http://127.0.0.1:4310
Version: 1
Chain ID: 46630
Nonce: <32-hex>
Issued At: <ISO8601>
Expiration Time: <ISO8601>
```

**Verify request:**
```
POST /api/auth/eth/verify
{ "signature": "0x...", "nonce": "<32-hex>", "role": "agent" }
```

Nonce expires in 10 minutes, single-use. On success → JWT cookie set.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VALUER_ADMIN_SECRET` | Yes (prod) | — | Admin HMAC/JWT secret (64 hex chars) |
| `VALUER_AGENT_SECRET` | Yes (prod) | — | Agent HMAC/JWT secret (64 hex chars) |
| `VALUER_SESSION_SECRET` | Yes (prod) | — | JWT signing (64 hex chars) |
| `VALUER_HARDENED` | Yes | 0 | `1` = block default secrets, require proper auth |
| `VALUER_USERS_JSON` | No | — | JSON array of `{username, role, passwordHash}` for session auth |
| `NODE_ENV` | No | development | `production` = hardened |
| `PORT` | No | 4310 | Server port |
| `VALUER_SESSION_TTL_MS` | No | 43200000 | Session TTL (12h) |
| `REQUIRE_AGENT_AUTH` | No | 0 | `1` = require HMAC for run recording |
| `AUTO_SYNC_WORKER` | No | 0 | `1` = start Vibe sync on boot |
| `SYNC_INTERVAL_MS` | No | 300000 | Worker tick interval (5min) |
| `VIBE_RPC_URL` | No | Robinhood testnet | Custom RPC URL |

> Generate secrets: `node -e "const crypto=require('crypto'); console.log([...Array(3)].map(()=>crypto.randomBytes(32).toString('hex')).join('\n'))"`
