# Troubleshooting

Quick reference for when something breaks. Read this **before** opening an issue.

## Server won't start

### `Error: listen EADDRINUSE 127.0.0.1:4310`

Another node process is already on the port.

```bash
# Windows
powershell -Command "Get-Process node | Stop-Process -Force"
# macOS/Linux
lsof -ti:4310 | xargs kill -9
```

Then restart.

### `VALUER_HARDENED=1 but VALUER_USERS_JSON is missing`

Server exits early to prevent default-credential login. Generate secrets:

```bash
node scripts/init-secrets.cjs
```

Copy the printed values into `.env`.

### `Cannot find module 'ethers'`

```bash
npm install
```

If still failing: `npm install ethers dotenv ws`.

### `Database is locked`

Some other process holds the SQLite file. On macOS/Linux:

```bash
lsof data/valuer.sqlite
# If nothing else holds it but you get this error, the file might be corrupt.
# Check:
sqlite3 data/valuer.sqlite "PRAGMA integrity_check;"
```

If corrupt, restore from backup:

```bash
ls data/backups/
cp data/backups/valuer-2026-09-17T04-00-20-229Z.sqlite data/valuer.sqlite
```

## Login doesn't work

### "credentials invalid"

1. Check `.env` — `VALUER_USERS_JSON` must be valid JSON with at least one user.
2. Username and password are **case-sensitive**.
3. In hardened mode, you must use **bcrypt/argon2** hashes, not plaintext. Use `node scripts/init-secrets.cjs` to regenerate.

### Login button shows "LOGIN" but no dialog

Check the JS console: did `load()` fail because the server is unreachable? Run `curl http://127.0.0.1:4310/api/health` — if you get a connection error, the server is down.

### Cookies not persisting

You're using a private browsing window, or your browser blocks third-party cookies, or `SameSite=None` was set without `Secure`. In `.env`, set `VALUER_COOKIE_SECURE=1` (only for HTTPS), or open in normal mode.

### Role chip stays "ANON / VIEWER" after login

Cookie wasn't read. Two cases:
- **First load**: refreshing the page fixes it (browser hasn't sent the cookie yet on the first run).
- **Persistent**: you have `Cookie path=` mismatch. Server sets `path=/`; client sends it to root by default. If you serve from a subpath, override.

## API errors

### `400 validation_failed`

Server returned `details: ["<reason>"]`. Read the first item — it's the validator's note. Common:

| Reason | Fix |
|---|---|
| `invalid kind` | Use one of: `manual, simple, verified, automated, multiStep, recovery, delegated, critical` |
| `complexity must be an integer from 1 to 10` | Set it to a number, not string |
| `agentId is required` / `agentId is required` | The agent id format is `agent-{ts}-{hex}` |
| `evidence.chainId must be a positive integer` | Use a real chain id (46630 for HyperEVM testnet, 1 for mainnet) |
| `evidence.txHash is required for onchain_tx source` | Provide a real 64-char hex hash |
| `idempotencyKey` re-use | Server treats it as same run → use a fresh key per attempt |

### `401 unauthorized`

Cookie missing or expired. Re-login or include the cookie explicitly:

```bash
curl -b /tmp/cookies.txt -X POST http://127.0.0.1:4310/api/runs
```

If you don't have a cookie yet, use HMAC headers instead:

```bash
TS=$(date +%s)
SIG=$(printf "%s|%s|%s|%s" "$TS" "/api/runs" "$ACTOR" "$BODY" | openssl dgst -sha256 -hmac "$VALUER_ADMIN_SECRET" -hex | cut -d' ' -f2)
curl -X POST http://127.0.0.1:4310/api/runs \
  -H "x-valuer-timestamp: $TS" \
  -H "x-valuer-actor: $ACTOR" \
  -H "x-valuer-signature: $SIG" \
  -H "content-type: application/json" \
  -d "$BODY"
```

### `403 insufficient_role`

You're logged in but not at the right role. `viewer` can read; only `agent/admin/owner` can write; only `admin/owner` can slash.

### `404 not_found`

Check the URL. Common mistakes:
- Missing route: `/api/agents/<id>` is single agent. `/api/agents` is the list.
- Wrong method: `/api/auth/login` requires POST, `/api/auth/me` requires GET.
- Restart server: route definitions live in `server.js`, not exported, no hot reload.

### `429 rate_limit_exceeded`

Per-IP bucket of 120 req/min (public), 600 req/min (auth). Back off.

### `500 internal`

Server logged it. Check `server.log`. Most common:
- DB constraint violation (you're inserting a duplicate `id`).
- Broken try/catch path — `error.message` is included in body.

## Browser-side issues

### White screen

Open DevTools console. Most common:
- `/api/health` returns 500 → server is up but DB has crashed.
- `/api/agents` returns 401 → cookie expired and `state.agents = []`, but the empty state shouldn't white-screen.

### Old data shown after refresh

Browser cache. Hard refresh: Ctrl+Shift+R (Win/Linux), Cmd+Shift+R (macOS).

### Login dialog won't close

Click the `×` button in the top-right of the dialog. Or press Escape.

### Tooltip `?` doesn't show anything

`data-help` attribute missing on the HTML element, or app.js 404'd on script load. Check DevTools.

### All bars are 0%

You have no agents with runs in `state.agents`. Run `load()` to refetch: refresh the page.

### "Use a valid Ethereum address" on onboarding

You pasted a wallet address with a typo. Try `0x` + 40 hex chars. Use MetaMask's "Copy address" button to avoid typos.

### Wallet signature rejected but address is correct

You're on the wrong chain or wrong signer. The signature has to come from the same private key as the address. If using a hardware wallet, sign with that device — not from a hot wallet.

## Performance issues

### Slow first request

SQLite has to compile queries on first call. After warmup, it's sub-10ms. If it's still slow:
- Check `data/valuer.sqlite` size. >100MB means too many runs. Archive the old ones (`scripts/archive-old-runs.cjs` — coming soon).
- Check the disk. Some VMs with NFS-mounted `data/` are 50× slower than local SSD.

### CPU 100% on idle

`AUTO_SYNC_WORKER=1` triggers polling. Set to `0` and the worker stops.

### Memory grows over time

You might be running with `--inspect`. Remove it. Or the SSE/WS hub has clients that never disconnected. Restart.

## When to give up and start fresh

If you've broken the DB or lost the `.env`:

```bash
# 1. Stop server
# 2. Backup what you can
cp .env .env.lost
cp data/valuer.sqlite data/valuer.sqlite.lost

# 3. Wipe
rm -rf data/valuer.sqlite data/backups/

# 4. Generate fresh secrets
node scripts/init-secrets.cjs

# 5. Start
npm start
# DB is rebuilt empty, you get the dev users printed.
```

Last resort, but it works — the server treats a missing DB as "first run" and reinitializes the schema.
