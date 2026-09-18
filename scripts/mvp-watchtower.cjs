const http = require('http');
const crypto = require('crypto');
const { computeSignature, loadSecrets } = require('../src/auth');

function request(method, path, body, role) {
  return new Promise(function (resolve) {
    const data = body ? JSON.stringify(body) : '';
    const secrets = loadSecrets();
    const secret = role === 'admin' ? secrets.adminSecret : secrets.agentSecret;
    const ts = String(Date.now());
    const sig = computeSignature(secret, ts, method, path, data);
    const opts = { host: '127.0.0.1', port: 4310, path: path, method: method, headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': sig, 'X-Valuer-Timestamp': ts, 'X-Valuer-Actor': role + '-test' } };
    const req = http.request(opts, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: chunks }); });
    });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // Setup: import a duplicate-evidence run pair
  const txHash = '0x' + 'f'.repeat(64);
  // First run
  const r1 = await request('POST', '/api/runs', { agentId: 'quant-01', kind: 'simple', complexity: 4, trigger: 'user', verification: 'user_confirmed', status: 'completed', idempotencyKey: 'wt-1-' + Date.now() }, 'admin');
  // Create second run for scout-07 with same fake txHash via level-preview + record
  // Note: level-preview doesn't write; we record a real run with on-chain fake hash to trigger watchtower
  const r2 = await request('POST', '/api/runs', { agentId: 'scout-07', kind: 'simple', complexity: 4, trigger: 'user', verification: 'verified', status: 'completed', idempotencyKey: 'wt-2-' + Date.now(), evidence: { source: 'onchain_tx', operation: 'real_operation', chainId: 46630, blockNumber: 1, txHash: txHash, receiptStatus: 'success' } }, 'admin');
  console.log('runs:', r1.status, r2.status);

  console.log('--- Watchtower duplicates ---');
  const dup = await request('GET', '/api/watchtower/duplicates', null, 'admin');
  console.log('duplicates:', dup.status, dup.body.slice(0, 500));

  console.log('--- Watchtower sybil ---');
  const sybil = await request('GET', '/api/watchtower/sybil', null, 'admin');
  console.log('sybil:', sybil.status, sybil.body.slice(0, 500));

  console.log('--- Watchtower run ---');
  const run = await request('POST', '/api/watchtower/run', {}, 'admin');
  console.log('watchtower_run:', run.status, run.body);

  console.log('--- Recent events with sinceId ---');
  const recent = await request('GET', '/api/events/recent', null, 'admin');
  const recentJson = JSON.parse(recent.body);
  console.log('recent_total:', recentJson.count, 'returned:', recentJson.events.length);
  if (recentJson.events.length > 0) {
    const firstId = recentJson.events[0].id;
    const replay = await request('GET', '/api/events/recent?sinceId=' + firstId, null, 'admin');
    const replayJson = JSON.parse(replay.body);
    console.log('replay_after_id:', replayJson.events.length, 'first_after:', replayJson.events[0] && replayJson.events[0].id);
  }
})();
