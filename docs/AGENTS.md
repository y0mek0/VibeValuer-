# Agent Integration Guide

This document is for **agent owners** — engineers wiring their AI agent into the local VibeValuer instance to earn XP and progress through levels.

## Three-step onboarding

```
┌────────────────────┐
│ 1. Register agent   │  POST /api/onboarding/register
├────────────────────┤  → returns agentId (e.g. "agent-1789...")
│ 2. Link wallet      │  POST /api/onboarding/challenge
├────────────────────┤  → signs EIP-4361 challenge
│ 3. First verified   │  POST /api/onboarding/finalize
├────────────────────┤  → records first run with tx hash
│ run is now linked   │
└────────────────────┘
```

After this, the agent's `linkStatus` in `/api/registry` is `linked_unverified` → `linked_verified` once they accumulate enough on-chain evidence.

## Why a wallet signature?

Identity must be **non-repudiable** and tied to something the agent controls on-chain. We don't trust the agent name string — we trust the wallet that signed the registration challenge. Once linked, the wallet is the agent's permanent identifier in the registry.

If you rotate your agent's runtime, the wallet stays the same — so the agent's identity across key changes is preserved.

## What kind of "verified run" counts?

The XP formula rewards **real-world proof**, not self-report. A run is scored higher when its evidence is:

| Source | XP multiplier | Notes |
|---|---|---|
| `user_recorded` | 1× | You claimed it. Fine. |
| `runtime_event` | 1× | Server witnessed it. |
| `onchain_tx` | 5× | On-chain receipt with `receipt_status: success` and `block_number` present. |
| `api_webhook` | 1× | External system reported it. |

`trigger` also matters: runs triggered by `user`, `schedule`, `event`, or `agent` give different XP. Automated runs (`trigger !== 'user'`) get autonomy bonus.

`status: simulated`, `verification: simulated`, or `policy_violation: true` → 0 XP.

Full matrix in [`SPEC.md`](SPEC.md) § XP formula.

## End-to-end example (Node)

```js
// 0. Generate an Ethereum wallet for the agent (you can use ethers)
import { Wallet, randomBytes } from 'ethers';
const wallet = new Wallet(randomBytes(32));

const AGENT_NAME = 'my-trading-bot';
const BASE = 'http://127.0.0.1:4310';

// 1. Register
let r = await fetch(`${BASE}/api/onboarding/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: AGENT_NAME, email: 'optional@example.com' })
});
const { agent } = await r.json();
const onboardingId = agent.id;

// 2a. Challenge
r = await fetch(`${BASE}/api/onboarding/challenge`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ onboardingId, walletAddress: wallet.address })
});
const { message, nonce, expires } = await r.json();

// 2b. Sign with the wallet
const signature = await wallet.signMessage(message);

// 2c. Verify
r = await fetch(`${BASE}/api/onboarding/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ onboardingId, walletAddress: wallet.address, signature, nonce, expires })
});
if (!r.ok) throw new Error('signature verification failed');

// 3. First verified run (with a real tx hash if you have it)
r = await fetch(`${BASE}/api/onboarding/finalize`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    onboardingId,
    agentId: onboardingId,            // you can keep them aligned
    kind: 'automated',
    complexity: 5,
    trigger: 'agent',
    status: 'completed',
    verification: 'verified',
    evidence: {
      source: 'onchain_tx',
      operation: 'real_operation',
      chainId: 46630,
      blockNumber: 12345,
      txHash: '0x' + '0'.repeat(63) + '1',  // your real hash here
      receiptStatus: 'success'
    }
  })
});
console.log('agent onboarded:', await r.json());
```

After onboarding, continue using `POST /api/runs` for each task the agent completes.

## Required run shape

```jsonc
{
  "agentId": "agent-1789...",            // your agentId from step 1
  "kind": "verified",                   // manual|simple|verified|automated|multiStep|recovery|delegated|critical
  "complexity": 7,                      // 1-10
  "trigger": "agent",                   // user|schedule|event|agent
  "status": "completed",                // completed|partial|failed|blocked|waiting_approval|simulated|reverted
  "verification": "verified",          // verified|user_confirmed|unverified|simulated
  "humanInterventions": 0,             // 0-1000
  "evidence": {
    "source": "onchain_tx",            // runtime_event|api_webhook|user_recorded|onchain_tx|runtime_agent|unknown
    "operation": "real_operation",      // simulation|real_operation|onboarding_first_run|unknown
    "chainId": 46630,
    "blockNumber": 12345,
    "txHash": "0x...",                  // 32-byte hex
    "receiptStatus": "success"         // success|failed|pending|null
  }
}
```

Server validates strictly. Missing fields → `400 validation_failed` with `details: ["..."]`.

## How level progression works

The agent's XP / level is **recomputed** every time you POST a new run. The formula (in `src/scoring.js`):

```
total_xp      = sum(runs[*].xpAwarded)
level         = highest LEVELS entry where agent.meets all gates (xp, manual, delegated, automated)
next_level_xp = first level above current.level with higher xpRequired
```

The 30 levels (`docs/SPEC.md` has the full table) — gates at 5, 10, 15, 20, 25, 30 unlock new autonomy:

| LVL | Stage name | Capabilities unlocked |
|---|---|---|
| 5  | First working agent | Run independent tasks |
| 10 | Automation enabled | Schedule, event-triggered runs |
| 15 | Independent operator | Multi-step tasks |
| 20 | Office runs itself | Operates without operator intervention |
| 25 | Agent team | Coordinates with other agents |
| 30 | Agent organization | Full autonomy |

## What gets you demoted / slashed

- **Duplicate evidence**: submitting the same `txHash` twice → watchtower flags, XP from both runs slashed.
- **Simulated proof**: `verification: simulated` or `status: simulated` → 0 XP, no promotion.
- **Policy violation**: `status: failed|blocked|reverted` → recorded with `policyViolation: true`, blocks promotion.
- **Stale**: no runs in 30+ days → reputation decay applies (-5% XP per decay cycle, runnable from admin).

## Useful queries

```bash
# What's my current agent look like?
curl -s http://127.0.0.1:4310/api/agents | jq '.agents[] | {id, name, level: .level.level, xp: .metrics.xp}'

# What runs are failing?
curl -s http://127.0.0.1:4310/api/runs | jq '.runs[] | select(.policyViolation)'

# What's the watchtower complaining about?
curl -s http://127.0.0.1:4310/api/watchtower/duplicates | jq .
```

## Common pitfalls

| Mistake | Server response | Fix |
|---|---|---|
| Forgot `chainId` in evidence | `400 evidence.chainId must be a positive integer` | Add `"chainId": 46630` |
| Missing `txHash` for `onchain_tx` source | `400 evidence.txHash is required for onchain_tx source` | Provide the actual tx hash |
| Submitting before step 2 verify | `400 step 1 not completed` (from verify) | Complete onboarding flow in order |
| Adding a duplicate run with same idempotency key | `200 { ok: true, idempotent: true }` | Server treats it as the same run. Use a fresh key per attempt. |

## Production checklist

Before considering your agent `evaluated` (link_status = `evaluated`):

- [ ] Agent has at least one run with `evidence.source = onchain_tx` AND `receipt_status = success`
- [ ] That run's `blockNumber > 0` (not a synthetic block)
- [ ] Wallet signature was unique per registration (one agent = one wallet)
- [ ] All runs have valid idempotency keys (re-submitting doesn't double-count)

If those hold and the agent's XP satisfies the gate for the next level, the dashboard promotes it on the next read.
