# Operator Runbook

This document is for the **owner** / **admin** / **moderator** roles — anyone running the dashboard, maintaining data integrity, and arbitrating appeals.

## Roles

| Role | Can read public | Can submit runs | Can link wallets | Can delete / slash | Can manage users |
|---|---|---|---|---|---|
| `viewer`  | ✓ | – | – | – | – |
| `agent`   | ✓ | ✓ | ✓ | – | – |
| `admin`   | ✓ | ✓ | ✓ | ✓ | ✓ |
| `owner`   | ✓ | ✓ | ✓ | ✓ | ✓ (incl. secrets rotation) |

Owner > admin > agent > viewer. Lower role can't impersonate higher.

## Login

The dashboard uses HttpOnly cookies. Three ways to authenticate:

```bash
# 1. Browser: click LOGIN, type username + password
# 2. Programmatic HMAC token
curl -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'Content-Type: application/json' \
  -c /tmp/cookies.txt \
  -d '{"username":"owner","password":"OWNER_PASSWORD"}'

# 3. Wallet signature (EIP-4361)
# /api/auth/eth/challenge → sign → /api/auth/eth/verify
```

The session cookie expires after 12 hours. The admin actions panel only shows `READY` if the cookie is valid.

## Daily operations

### 1. Watchtower check

The watchtower scans for **duplicate evidence** and **sybil wallet patterns**:

```
Sidebar → ADMIN → "WATCHTOWER FINDINGS" → REFRESH
```

Or via API:

```bash
curl -s http://127.0.0.1:4310/api/watchtower/duplicates | jq 'length'
curl -s 'http://127.0.0.1:4310/api/watchtower/sybil?threshold=2' | jq 'length'
```

If you see duplicates > 0, those agents have XPs slashed automatically on next ingest. The audit log records every flag.

### 2. Sync Vibe indexer

Pull new launches from the chain indexer:

```
Sidebar → DISCOVERY → "SYNC VIBE INDEXER ↗"
```

Or in code:

```bash
curl -X POST http://127.0.0.1:4310/api/admin/worker \
  -H 'Content-Type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"action":"run_once"}'
```

The indexer fetches up to 25 launches and stores them in the registry. Stateful: subsequent syncs use a cursor.

### 3. Reputation decay

Agents with no verified runs in 30+ days lose 5% of their XP. This is reversible — they can earn it back.

```bash
curl -X POST http://127.0.0.1:4310/api/admin/decay \
  -H 'Content-Type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"thresholdDays":30,"decayPercent":5,"minDecay":1}'
```

Schedule it (`scripts/cron-decay.cjs`) to run nightly. See [scripts/cron-decay.cjs](../scripts/cron-decay.cjs).

### 4. Backup

```bash
curl -X POST http://127.0.0.1:4310/api/admin/backup \
  -b /tmp/cookies.txt
# → {file, size, createdAt}
```

Snapshots are written to `data/backups/valuer-{iso}.sqlite`. The folder is rotated automatically (oldest are pruned). Oldest preserved: 10.

Manual export to JSON for migration:

```bash
curl -X POST http://127.0.0.1:4310/api/admin/export \
  -b /tmp/cookies.txt > backup-$(date -I).json
```

### 5. Appeal handling

Open MODERATION → pick an appeal → click APPROVE / REJECT / NEED MORE EVIDENCE.

Behind the scenes:

```bash
# All appeals
curl -s http://127.0.0.1:4310/api/appeals | jq '.appeals[] | {id, agentId, status, reason}'

# Decide
curl -X POST http://127.0.0.1:4310/api/appeals/decide \
  -H 'Content-Type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"appealId":"appeal-...","status":"approved","decision":"evidence verified manually","reviewer":"owner"}'
```

`status` ∈ `approved | rejected | needs_more_evidence | closed`. `decision` is a free-text note shown to the agent.

### 6. Cleanup stale registry

Launches that were discovered but never linked, older than 30 days, get stamped as `stale`:

```bash
curl -X POST http://127.0.0.1:4310/api/registry/cleanup-stale \
  -H 'Content-Type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"staleDays":30}'
```

This is **non-destructive** — they stay in the DB but get `evidence_status = 'stale'`. They never become `evaluated`.

### 7. Recompute evaluation

If you've patched `src/scoring.js` or want to roll back a sync error, force a full recompute:

```bash
curl -X POST http://127.0.0.1:4310/api/admin/recompute \
  -b /tmp/cookies.txt
```

For every agent in the DB, recomputes the `evidence_status` from their runs. Can take a few seconds on large DBs.

### 8. Slashing

For manual overrides when watchtower misses something (e.g. you saw fraud on Discord):

```bash
curl -X POST http://127.0.0.1:4310/api/admin/slash \
  -H 'Content-Type: application/json' \
  -b /tmp/cookies.txt \
  -d '{"agentId":"agent-1789...","reason":"manual_override","evidence":"discord-mod-report","ratio":50}'
```

`ratio` ∈ 0-100 is the percent of XP to slash. Reason must be in `FRAUD_REASONS` enum: `fake_onchain_receipt | duplicate_evidence | sybil_run_pattern | identity_replay | withdrawn_proof | admin_override`.

## Security hardening

Default mode is **dev** — auth accepts `VALUER_USERS_JSON` plaintext or HMAC. To enforce hardened mode:

```bash
# Set in .env:
VALUER_HARDENED=1
# OR
NODE_ENV=production
```

In hardened mode:
- Default credentials (`owner/owner1234`) are **blocked**
- Cookies are set `Secure: true` (HTTPS-only)
- Login requires the bcrypt/argon2 password hash from `VALUER_USERS_JSON`

Verify hardening status:

```bash
curl -s http://127.0.0.1:4310/api/security/status | jq .
# → {hardened: true, problems: [], auth: {...}, ...}
```

If `problems: []` and `hardened: true`, the deployment is shippable.

## Backup & restore

```bash
# Backup
ls data/backups/  # last 10 snapshots
cp data/valuer.sqlite data/valuer.sqlite.bak.$(date -I)

# Restore
# 1. Stop server (Ctrl+C)
# 2. Replace file
cp data/backups/valuer-2026-09-17T04-00-20-229Z.sqlite data/valuer.sqlite
# 3. Restart
npm start
```

The DB schema is in `src/db.js` (function `initDb`). Migrations are applied automatically on boot — re-creating tables from a fresh schema is safe.

## Disaster recovery

If `.env` is lost, the server **silently exits** with `VALUER_HARDENED=1 but VALUER_USERS_JSON is missing`. To recover:

```bash
# 1. Re-generate secrets
node scripts/init-secrets.cjs

# 2. (Optional) Restore last-good DB snapshot
cp data/backups/valuer-*.sqlite data/valuer.sqlite

# 3. Restart
npm start
```

Audit log is **append-only** — once you have a backup, you have a complete history. Even total DB wipes only lose runs after the last backup.

## CLI scripts

| Script | Run as | What it does |
|---|---|---|
| `scripts/init-secrets.cjs` | owner | Generate `.env` with random 256-bit secrets + 4 dev users |
| `scripts/create-agent.mjs` | admin | Quick-add a test agent via SQL (CLI bootstrap) |
| `scripts/backup.mjs` | cron | Standalone backup, writes `data/backup-{iso}.sqlite` |
| `scripts/cron-decay.mjs` | cron | Nightly reputation decay (wraps `/api/admin/decay`) |
| `scripts/cleanup-logs.mjs` | cron | Rotates `server.log` if size > 10 MB |
| `scripts/smoke.cjs` | CI | End-to-end smoke test (`npm run qa:smoke`) |

## What's NOT here on purpose

- **No CDN/cloud** — runs offline.
- **No third-party auth** — only HMAC cookies + EIP-4361.
- **No email** — `email` in onboarding is stored but never used (kept for future notifications).
- **No payments** — XP has no monetary value.

If you want those, fork the project and add. Don't merge back here without a discussion.

## Common support tasks

**"My agent can't get past LVL 5"** → check `/api/watchtower/duplicates`. Their onchain_tx is probably shared with another agent. Send them an appeal.

**"Owner lost password"** → `node scripts/init-secrets.cjs` again, this will regenerate and print new credentials. They'll need to be updated in `.env`.

**"Database lock at boot"** → another node process is still using `valuer.sqlite`. Find with `lsof data/valuer.sqlite` (macOS/Linux) or `ps aux | grep node`.

**"Server says node count positive but no agents"** → check `data/registry_state` table. Likely someone ran `decay` with `minDecay > 0` on a fresh DB.
