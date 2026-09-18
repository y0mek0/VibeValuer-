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
  // Create 4 runs that all have the same fake txHash but different fromAddress (sybil pattern)
  // Use the SAME from address across multiple agents/runs to trigger sybil detection
  const txHash = '0x' + 'a'.repeat(64);
  const sameFrom = '0x1111111111111111111111111111111111111111';
  const agents = ['quant-01', 'scout-07'];
  for (let i = 0; i < 4; i++) {
    const r = await request('POST', '/api/runs', {
      agentId: agents[i % agents.length], kind: 'simple', complexity: 4, trigger: 'user', verification: 'verified', status: 'completed',
      idempotencyKey: 'wt-sybil-' + i + '-' + Date.now(),
      evidence: { source: 'onchain_tx', operation: 'real_operation', chainId: 46630, blockNumber: 1, txHash: txHash, receiptStatus: 'success', from: sameFrom }
    }, 'admin');
    console.log('run', i, ':', r.status);
  }

  // Duplicate evidence: same agent, same txHash
  for (let i = 0; i < 2; i++) {
    const r = await request('POST', '/api/runs', {
      agentId: 'quant-01', kind: 'simple', complexity: 4, trigger: 'user', verification: 'verified', status: 'completed',
      idempotencyKey: 'wt-dup-' + i + '-' + Date.now(),
      evidence: { source: 'onchain_tx', operation: 'real_operation', chainId: 46630, blockNumber: 1, txHash: '0x' + 'b'.repeat(64), receiptStatus: 'success', from: '0x4444444444444444444444444444444444444444' }
    }, 'admin');
    console.log('dup', i, ':', r.status);
  }

  console.log('--- Watchtower duplicates ---');
  const dup = await request('GET', '/api/watchtower/duplicates', null, 'admin');
  console.log('duplicates:', dup.status, JSON.parse(dup.body).duplicates.length, 'found');

  console.log('--- Watchtower sybil ---');
  const sybil = await request('GET', '/api/watchtower/sybil?threshold=2', null, 'admin');
  console.log('sybil:', sybil.status, JSON.stringify(JSON.parse(sybil.body).patterns));

  console.log('--- Watchtower run ---');
  const run = await request('POST', '/api/watchtower/run', {}, 'admin');
  console.log('watchtower_run:', run.status, run.body);
})();
