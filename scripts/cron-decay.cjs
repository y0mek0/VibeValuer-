#!/usr/bin/env node
/**
 * cron-decay.cjs
 *
 * Daily reputation decay caller. Hits the live API endpoint with the admin
 * credentials from .env. Schedules: every night at 03:13 UTC.
 *
 * Crontab:
 *   13 3 * * * cd /path/to/vibe-agents-lvl-valuer && node scripts/cron-decay.cjs
 *
 * Idempotent — the server's decay endpoint only penalizes agents with no runs
 * in 30+ days, so re-running is harmless.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function getUsers() {
  const env = loadEnv();
  try { return JSON.parse(env.VALUER_USERS_JSON || '{}'); }
  catch { return {}; }
}

function runDecay(base, ownerHash, threshold, decay) {
  // Use HMAC-signed request to /api/admin/decay.
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ thresholdDays: threshold, decayPercent: decay, minDecay: 1 });
  const stringToSign = ts + '|POST|/api/admin/decay|' + body;
  // ownerHash here is the scrypt hash from VALUER_USERS_JSON — instead of cracking
  // it client-side we just call the login endpoint first.
  return new Promise((resolve, reject) => {
    // Step 1: login → cookie
    loginAndCall(base, ownerHash).then(resolve).catch(reject);
  });
}

function loginAndCall(base, passwordOrHash) {
  // For scripts we don't have a cleartext password. Use `password` from env if present,
  // otherwise exit with a helpful note.
  const env = loadEnv();
  const cleartext = env.VALUER_DECAY_PASSWORD || env.VALUER_ADMIN_PASSWORD;
  if (!cleartext) {
    return Promise.reject(new Error('Set VALUER_DECAY_PASSWORD in .env to run decay'));
  }
  const cookieJar = [];
  function post(path, body, headers) {
    return new Promise((resolve, reject) => {
      const data = body ? Buffer.from(body) : null;
      const req = http.request({
        host: new URL(base).hostname,
        port: Number(new URL(base).port || 4310),
        method: 'POST',
        path,
        headers: Object.assign({
          'content-type': 'application/json',
          'content-length': data ? data.length : 0,
          cookie: cookieJar.join('; '),
        }, headers || {}),
      }, (res) => {
        const setCookies = res.headers['set-cookie'] || [];
        for (const sc of setCookies) {
          const [pair] = sc.split(';');
          if (!cookieJar.includes(pair)) cookieJar.push(pair);
        }
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: chunks });
          else reject(new Error(`POST ${path} -> ${res.statusCode}: ${chunks}`));
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  return (async () => {
    // Load env again for VALUER_DECAY_USERNAME
    const username = env.VALUER_DECAY_USERNAME || 'owner';
    const loginRes = await post('/api/auth/login', JSON.stringify({ username, password: cleartext }));
    const cookie = cookieJar.join('; ');
    return post('/api/admin/decay', JSON.stringify({ thresholdDays: 30, decayPercent: 5, minDecay: 1 }), { cookie });
  })();
}

async function main() {
  const env = loadEnv();
  const base = env.VALUER_BASE_URL || `http://127.0.0.1:${env.PORT || 4310}`;
  console.log(`[cron-decay] POST ${base}/api/admin/decay`);
  try {
    const r = await loginAndCall(base);
    console.log(`[cron-decay] ok (${r.status}): ${r.body.slice(0, 200)}`);
  } catch (e) {
    console.error(`[cron-decay] failed: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
