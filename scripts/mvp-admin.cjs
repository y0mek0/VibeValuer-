const crypto = require('node:crypto');
const { computeSignature } = require('../src/auth');
const base = process.env.BASE_URL || 'http://127.0.0.1:4310';
const ADMIN_SECRET = 'dev-admin-secret-change-me';

(async () => {
  function adminSig(method, path, body) {
    const ts = String(Date.now());
    const sig = computeSignature(ADMIN_SECRET, ts, method, path, body || '');
    return { ts: ts, sig: sig };
  }

  // 1. Worker sync-now
  const workerBody = JSON.stringify({ limit: 5, maxPages: 3 });
  const w = adminSig('POST', '/api/worker/sync-now', workerBody);
  const wres = await fetch(base + '/api/worker/sync-now', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': w.sig, 'X-Valuer-Timestamp': w.ts, 'X-Valuer-Actor': 'admin-test' }, body: workerBody });
  console.log('worker_sync:', wres.status, await wres.json());

  // 2. Worker start/stop
  const startBody = JSON.stringify({ intervalMs: 30000 });
  const s = adminSig('POST', '/api/worker/start', startBody);
  const sres = await fetch(base + '/api/worker/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': s.sig, 'X-Valuer-Timestamp': s.ts, 'X-Valuer-Actor': 'admin-test' }, body: startBody });
  console.log('worker_start:', sres.status, await sres.json());

  const stopBody = '';
  const st = adminSig('POST', '/api/worker/stop', stopBody);
  const stres = await fetch(base + '/api/worker/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': st.sig, 'X-Valuer-Timestamp': st.ts, 'X-Valuer-Actor': 'admin-test' }, body: stopBody });
  console.log('worker_stop:', stres.status, await stres.json());

  // 3. Cleanup stale
  const csBody = JSON.stringify({ staleDays: 30 });
  const cs = adminSig('POST', '/api/registry/cleanup-stale', csBody);
  const csres = await fetch(base + '/api/registry/cleanup-stale', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': cs.sig, 'X-Valuer-Timestamp': cs.ts, 'X-Valuer-Actor': 'admin-test' }, body: csBody });
  console.log('cleanup_stale:', csres.status, await csres.json());

  // 4. Reputation decay
  const decBody = JSON.stringify({ thresholdDays: 1, decayPercent: 1, minDecay: 1 });
  const dec = adminSig('POST', '/api/reputation/decay', decBody);
  const decres = await fetch(base + '/api/reputation/decay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': dec.sig, 'X-Valuer-Timestamp': dec.ts, 'X-Valuer-Actor': 'admin-test' }, body: decBody });
  console.log('decay:', decres.status, await decres.json());

  // 5. Recompute evaluation
  const rcBody = JSON.stringify({ agentId: 'quant-01' });
  const rc = adminSig('POST', '/api/registry/recompute', rcBody);
  const rcres = await fetch(base + '/api/registry/recompute', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': rc.sig, 'X-Valuer-Timestamp': rc.ts, 'X-Valuer-Actor': 'admin-test' }, body: rcBody });
  console.log('recompute:', rcres.status, await rcres.json());

  // 6. Export snapshot
  const ex = adminSig('GET', '/api/export', '');
  const exres = await fetch(base + '/api/export', { headers: { 'X-Valuer-Signature': ex.sig, 'X-Valuer-Timestamp': ex.ts, 'X-Valuer-Actor': 'admin-test' } });
  const exdata = await exres.json();
  console.log('export:', exres.status, { agents: exdata.agents.length, registry: exdata.registry.length, runs: exdata.runs.length, audit: exdata.audit.length });

  // 7. On-chain transaction lookup (unknown hash)
  const otxres = await fetch(base + '/api/onchain/transaction?txHash=0x' + '0'.repeat(64));
  console.log('onchain_tx:', otxres.status, await otxres.json().then(function (j) { return j.error || { status: j.receipt && j.receipt.status }; }));
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
