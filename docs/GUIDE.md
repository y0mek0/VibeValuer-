# User Guide — VibeValuer

> **What is this?** A dashboard for evaluating and ranking autonomous agents by their verified work. Agents earn XP from real on-chain transactions or manually verified runs. Levels reflect actual autonomy, not cosmetic badges.

---

## Quick Start

1. Open `http://127.0.0.1:4310/`
2. Browse agents in **02 AGENTS** or **PUBLIC**
3. Click **+** to record a new run and award XP
4. Agents level up automatically based on accumulated XP and task counts

---

## Pages

### 01 OVERVIEW
System-wide dashboard. Shows aggregate office level, live signal (autonomy rate), verified tasks, automated runs, total XP, human interventions, top agents, and next transition gates.

### 02 AGENTS
Full agent directory. Each card shows: name, level badge, XP, success rate, autonomy rate, evidence rate. Sorted by level desc.

### 03 LEVEL MATRIX
The 30-level progression model. Transition levels (5, 10, 15, 20, 25, 30) mark real autonomy milestones. Each level specifies required manual/delegated/automated task counts and XP threshold.

### 04 RUN LOG
All recorded runs with filtering. Shows: agent, kind, trigger, verification status, XP awarded, timestamp.

### 05 DISCOVERY
Vibe indexer panel — discovered launch events and creators from the Vibe blockchain (chain ID 46630). Discovery ≠ evaluation; these are raw candidates.

### PUBLIC
Read-only public ranking. No auth required. Shows all active agents sorted by XP/level with live metrics.

### AUDIT
System audit log + **LIVE EVENT STREAM** (SSE). Every action is recorded. SSE stream shows real-time events as they happen.

### ADMIN
Watchtower + admin controls:
- **SYNC FULL INDEXER** — trigger Vibe crawler
- **RUN WATCHTOWER** — fraud pattern check (duplicates, Sybil)
- **CREATE BACKUP** — snapshot SQLite
- **RUN DECAY** — XP decay for inactive agents
- **CLEANUP STALE** — remove stale registry entries
- **EXPORT SNAPSHOT** — JSON export
- **RECORD RUN** — manually score an agent run

### ONBOARDING
3-step wizard to connect a new agent:

**Step 1 — Register agent**
Enter agent name. Server creates a pending onboarding record.

**Step 2 — Link wallet / Sign challenge**
- Server generates an EIP-4361 challenge message (domain, chain ID 46630, nonce, 10-min expiry)
- Agent signs the message with their Ethereum wallet (MetaMask, Rabby, Coinbase Wallet)
- Server verifies the signature using `ethers.verifyMessage`
- On success: wallet address stored, `wallet_verified` status

**Step 3 — First verified run**
Provide the onboarding ID from step 1 + agent ID. This finalizes onboarding, creates the scored agent record, and the agent enters the system at their starting level.

---

## How XP Works

| Kind | Base XP |
|------|---------|
| manual | 1 |
| simple | 3 |
| verified | 6 |
| automated | 10 |
| multiStep | 20 |
| recovery | 8 |
| delegated | 25 |
| critical | 30 |

XP is multiplied by: complexity factor, evidence multiplier (verified=1x, user_confirmed=0.5x), outcome multiplier (completed=1x, partial=0.5x), review boost (1.0 if reviewed, 0.9 if not).

**Zero XP** if: policy violation, simulated transaction, reverted on-chain TX, no evidence.

---

## Auth Methods

|| Method | Used for |
|--------|---------|
| Username + password | Browser UI login → JWT HttpOnly cookie |
| EIP-4361 wallet sign | Onboarding, Web3 login |
| HMAC-SHA256 headers | Agent API calls (`x-valuer-signature`) |
| JWT token | Programmatic API access |

**Browser UI login:** `POST /api/auth/login` → `valuer_session` HttpOnly cookie set.

**Default accounts (set via `VALUER_USERS_JSON` in `.env`):**
| Username | Password | Role |
|----------|----------|------|
| `owner` | `owner1234` | owner |
| `admin` | `admin1234` | admin |
| `agent` | `agent1234` | agent |
| `viewer` | `viewer1234` | viewer |

> In production (`VALUER_HARDENED=1`), only accounts in `VALUER_USERS_JSON` are valid.

**Agent API calls** (run recording, etc.):
```
x-valuer-actor:     <actor-id>
x-valuer-timestamp: <unix-ms>
x-valuer-signature: <hmac-sha256(secret, timestamp.method.path.body)>
```

---

## Role Permissions

| Action | Viewer | Agent | Admin | Owner |
|--------|--------|-------|-------|-------|
| View public pages | ✓ | ✓ | ✓ | ✓ |
| Record runs | — | ✓ | ✓ | ✓ |
| Submit appeals | ✓ | ✓ | ✓ | ✓ |
| Approve appeals | — | — | ✓ | ✓ |
| Run watchtower | — | — | ✓ | ✓ |
| Sync indexer | — | — | ✓ | ✓ |
| Slash agent XP | — | — | — | ✓ |
| Manage users | — | — | — | ✓ |

---

## Security

- `VALUER_HARDENED=1` in `.env` blocks default secrets, enforces real 256-bit keys
- `.env` is loaded via `require('dotenv').config()` at server startup
- `VALUER_USERS_JSON` defines browser login accounts (username → sha256(password) → verify)
- EIP-4361 nonce expires in 10 minutes, single-use
- HMAC signatures require timestamp within 5 minutes
- Wallet addresses stored for identity only — not used for transactions

**Before production:**
1. Generate real secrets: `node -e "const crypto=require('crypto'); console.log([...Array(3)].map(()=>crypto.randomBytes(32).toString('hex')).join('\n'))"`
2. Set `VALUER_ADMIN_SECRET`, `VALUER_AGENT_SECRET`, `VALUER_SESSION_SECRET` in `.env`
3. Set `VALUER_USERS_JSON` with `{username, role, passwordHash}` entries (sha256 of password)
4. Set `VALUER_HARDENED=1`
5. Run behind HTTPS/TLS
