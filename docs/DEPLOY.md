# VibeValuer — Deploy Guide

Step-by-step to run VibeValuer on a Linux VPS (`84.247.135.247`) with `pm2` + `cloudflared`, exposed via HTTPS.

## Architecture on the VPS

```
Internet users
    ↓ HTTPS
Cloudflare edge (yourdomain.example)
    ↓ tunnel
cloudflared (running on VPS)
    ↓ HTTP localhost:4310
pm2-managed Node server (`server.js`)
    ↓ reads
SQLite at ~/vibe-agents-lvl-valuer/data/valuer.sqlite
```

All state stays on the VPS. Cloudflare only sees TLS-terminated traffic; it cannot read SQLite.

## 0. Pre-flight: tools you need on the VPS

```bash
# SSH into
ssh root@84.247.135.247

# Install Node 18+ (skip if already there)
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Install pm2 + cloudflared
npm install -g pm2
# Pick ONE:
# Option A (Debian/Ubuntu) — cloudflared via apt:
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | apt-key add -
echo 'deb https://pkg.cloudflare.com cloudflared focal main' > /etc/apt/sources.list.d/cloudflared.list
apt-get update && apt-get install -y cloudflared

# Option B (any distro) — direct binary:
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

cloudflared --version   # confirm
pm2 --version
node --version          # must be 18+
```

## 1. Clone the repo

```bash
git clone https://github.com/y0mek0/VibeValuer-.git
cd VibeValuer-
git log --oneline -1    # confirm "Initial commit: VibeValuer 0.1.0"
```

## 2. Install deps

```bash
npm install
```

## 3. Generate `.env` for production

Option A — fresh secrets on the VPS (run `init-secrets.cjs`):

```bash
node scripts/init-secrets.cjs --port=4310
# → prints dev passwords to stdout
#   owner: xxxx  admin: xxxx  agent: xxxx  viewer: xxxx
#
# IMPORTANT: write these down. They are NOT stored in plaintext.
```

Option B — copy your local `.env` to the VPS securely:

```bash
# On your LOCAL machine (where you have the original .env):
scp .env root@84.247.135.247:~/VibeValuer-/.env

# On the VPS:
chmod 600 .env
```

Pick **one** of those. Don't mix.

## 4. Verify

```bash
npm run check
# should print: "passed, kind: check, scope: full"
```

## 5. Start with pm2

```bash
# Production launch
pm2 start server.js --name vibe-valuer --time --log ~/vibe-agents-lvl-valuer/server.log

# Save launch policy (survives reboot)
pm2 save
pm2 startup
# Run the command pm2 prints — it sets up systemd.

# Verify
pm2 status
curl http://127.0.0.1:4310/api/health
```

If `curl` returns `{"ok":true,...}` locally, the server is up.

## 6. Expose via Cloudflare Tunnel

```bash
# 1. Login (opens browser on first run)
cloudflared tunnel login
# → follow the printed URL, authorize the tunnel.

# 2. Create the tunnel (one-time)
cloudflared tunnel create vibe-valuer
# → prints UUID + path to credentials file

# 3. Configure DNS
cloudflared tunnel route dns vibe-valuer vibevaluer.example.com

# 4. Run the tunnel (locally-installed, no daemon needed)
cloudflared tunnel --config ~/.cloudflared/config.yml run vibe-valuer
```

Or run via pm2 alongside the node server:

```bash
pm2 start cloudflared --name cf-tunnel -- tunnel --config ~/.cloudflared/config.yml run vibe-valuer
pm2 save
```

`config.yml` for the tunnel (typically `~/.cloudflared/config.yml`):

```yaml
tunnel: vibe-valuer
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: vibevaluer.example.com
    service: http://127.0.0.1:4310
  - service: http_status:404
```

Now `https://vibevaluer.example.com` is reachable publicly, terminates TLS at Cloudflare, and forwards via the tunnel to your `pm2`-managed node server.

## 7. Set up cron ops

```bash
# Daily reputation decay at 03:13 UTC
13 3 * * * cd ~/VibeValuer- && node scripts/cron-decay.cjs >> ~/vibe-agents-lvl-valuer/cron.log 2>&1

# Log rotation every hour
0 * * * * cd ~/VibeValuer- && node scripts/cleanup-logs.mjs
```

Use `crontab -e` and add both lines.

For daily SQLite backups:

```bash
# Daily snapshot at 02:00 UTC, retain last 30
0 2 * * * cd ~/VibeValuer- && node scripts/backup.mjs >> ~/vibe-agents-lvl-valuer/backup.log 2>&1
```

## 8. Hard checks

| Item | How to verify |
|---|---|
| HTTPS works | `curl https://vibevaluer.example.com/api/health` returns 200 |
| Cookies secure | Set `VALUER_COOKIE_SECURE=1` in `.env`, restart |
| Hardened auth | `curl https://vibevaluer.example.com/api/security/status` shows `hardened: true` |
| DB persists across restart | `pm2 restart vibe-valuer`, `/api/agents` still shows your agents |
| Backup restores | `node scripts/backup.mjs`, then copy-back + restart |

## 9. Updating

```bash
cd ~/VibeValuer-
git pull
npm install              # only if dependencies changed
npm run check            # confirm nothing broke
pm2 restart vibe-valuer
# Watch logs for 30 sec
pm2 logs vibe-valuer --lines 100
```

Always make a backup before updating:

```bash
node scripts/backup.mjs --label pre-update
```

## 10. Disaster recovery

If `data/valuer.sqlite` becomes corrupt:

```bash
# Stop server
pm2 stop vibe-valuer

# Pick the most recent good snapshot
ls -lt data/backups/*.sqlite | head -3

# Restore
cp data/backups/<date>.sqlite data/valuer.sqlite

# Restart
pm2 start vibe-valuer
```

If `.env` is lost, regenerate:

```bash
node scripts/init-secrets.cjs --force
# ⚠ This will rotate all dev user passwords. Update them anywhere they are referenced.
```

If both `data/` and `.env` are gone, that's a total-loss event. Restore from the most recent backup AND a previous known-good `.env`. There is no recovery from total deletion without an external snapshot.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE` at boot | Port 4310 occupied | `pm2 delete vibe-valuer`, check `lsof -i:4310` |
| `EACCES` writing `data/` | Wrong permissions | `chown -R $USER:$USER ~/VibeValuer-` |
| Tunnel disconnects after reboot | Cloudflared not under pm2 | Add cloudflared to pm2 (see step 6) |
| `VALUER_HARDENED=1` prevents login | No `VALUER_USERS_JSON` | Re-run `node scripts/init-secrets.cjs` |
| Login says "credentials invalid" after copy | CRLF vs LF | `dos2unix .env` on the VPS |
| 502 from Cloudflare edge | pm2 didn't auto-start | `pm2 save && pm2 startup` |

## Env cheat sheet

| Var | Value | Purpose |
|---|---|---|
| `PORT` | `4310` | Node port |
| `VALUER_HARDENED` | `1` | Block default creds, enforce scrypt |
| `VALUER_COOKIE_SECURE` | `1` | `Secure` flag (needs HTTPS — flip on once cloudflared is up) |
| `VALUER_ADMIN_SECRET` | 64 chars base64url | HMAC for admin endpoints |
| `VALUER_AGENT_SECRET` | 64 chars base64url | HMAC for agent endpoints |
| `VALUER_SESSION_SECRET` | 64 chars base64url | Signs session cookies |
| `VALUER_USERS_JSON` | JSON | `{ "<u>": {"role":"...", "hash":"$salt$..."} }` |
| `VIBE_RPC_URL` | `https://rpc.testnet.chain.robinhood.com` | HyperEVM testnet |
| `VIBE_CHAIN_ID` | `46630` | HyperEVM testnet |
| `AUTO_SYNC_WORKER` | `0` or unset | Polls Vibe indexer on boot |

## When in doubt

1. `pm2 logs vibe-valuer --lines 200` — server runtime
2. `pm2 logs cf-tunnel --lines 200` — cloudflared
3. `tail -f ~/vibe-agents-lvl-valuer/server.log` — same as above
4. `curl http://127.0.0.1:4310/api/health` — local liveness check
5. `curl https://vibevaluer.example.com/api/health` — public liveness check

If something is genuinely broken and you can't figure it out, restart:

```bash
pm2 restart all
```
