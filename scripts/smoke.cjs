const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Wallet, verifyMessage } = require('ethers');
const { computeSignature } = require('../src/auth');
const base = process.env.BASE_URL || 'http://127.0.0.1:4310';
const AGENT_SECRET = 'dev-agent-secret-change-me';
const ADMIN_SECRET = 'dev-admin-secret-change-me';

async function request(path, options) {
  const response = await fetch(base + path, options);
  let body;
  try { body = await response.json(); } catch (e) { body = null; }
  return { status: response.status, body };
}

function signHeaders(role, method, path, body) {
  const ts = String(Date.now());
  const secret = role === 'admin' ? ADMIN_SECRET : AGENT_SECRET;
  const sig = computeSignature(secret, ts, method, path, body || '');
  return { ts, sig };
}

(async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const levels = await request('/api/levels');
  assert.equal(levels.body.levels.length, 30);
  assert.deepEqual(levels.body.levels.filter(l => l.transition).map(l => l.level), [5, 10, 15, 20, 25, 30]);

  const invalid = await request('/api/runs', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ agentId: 'scout-07', complexity: 99 }) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'Validation failed');

  const key = `smoke-${Date.now()}`;
  const payload = { agentId: 'scout-07', kind: 'automated', complexity: 4, trigger: 'event', verification: 'verified', idempotencyKey: key };
  const agentH = signHeaders('agent', 'POST', '/api/events', JSON.stringify(payload));
  const first = await request('/api/events', { method: 'POST', headers: Object.assign({'content-type':'application/json','x-valuer-signature':agentH.sig,'x-valuer-actor':'smoke-agent','x-valuer-timestamp':agentH.ts}), body: JSON.stringify(payload) });
  const replay = await request('/api/events', { method: 'POST', headers: Object.assign({'content-type':'application/json','x-valuer-signature':agentH.sig,'x-valuer-actor':'smoke-agent','x-valuer-timestamp':agentH.ts}), body: JSON.stringify(payload) });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(first.body.run.id, replay.body.run.id);
  assert.ok(first.body.run.xpAwarded > 0);

  const registryBefore = await request('/api/registry');
  const importBody = JSON.stringify({ source: 'smoke_registry', agents: [{ id: `external:${Date.now()}`, name: 'Imported smoke agent', evidenceStatus: 'unavailable', evaluated: false }] });
  const importH = signHeaders('admin', 'POST', '/api/registry/import', importBody);
  const imported = await request('/api/registry/import', { method: 'POST', headers: Object.assign({'content-type':'application/json','x-valuer-signature':importH.sig,'x-valuer-actor':'smoke-admin','x-valuer-timestamp':importH.ts}), body: importBody });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 1);
  assert.equal(imported.body.counts.evaluated, registryBefore.body.counts.evaluated);
  assert.equal(imported.body.counts.discovered, registryBefore.body.counts.discovered + 1);

  const summary = await request('/api/summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.body.agentCount >= 2);
  assert.ok(summary.body.metrics.xp > 0);

  // Public API works without auth
  const publicList = await request('/api/public/agents');
  assert.equal(publicList.status, 200);
  assert.ok(Array.isArray(publicList.body.agents));

  // Worker status visible without admin
  const workerStatus = await request('/api/worker/status');
  assert.equal(workerStatus.status, 200);

  // Evidence preview policy gates
  // Fake txHash now correctly returns 0 XP (on-chain receipt verification rejects it)
  const previewFake = await request('/api/agents/level-preview', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ agentId: 'scout-07', kind: 'verified', complexity: 7, trigger: 'event', verification: 'verified', status: 'completed', evidence: { source: 'onchain_tx', operation: 'real_operation', chainId: 46630, blockNumber: 120402382, txHash: '0x' + 'a'.repeat(64), receiptStatus: 'success' } }) });
  assert.equal(previewFake.status, 200);
  assert.equal(previewFake.body.evidenceVerified, false);
  assert.equal(previewFake.body.xpAwarded, 0);
  const previewReverted = await request('/api/agents/level-preview', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ agentId: 'scout-07', kind: 'verified', complexity: 7, trigger: 'event', verification: 'verified', status: 'completed', evidence: { source: 'onchain_tx', operation: 'real_operation', chainId: 46630, blockNumber: 1, txHash: '0x' + 'b'.repeat(64), receiptStatus: 'reverted' } }) });
  assert.equal(previewReverted.body.xpAwarded, 0);
  const previewSimulated = await request('/api/agents/level-preview', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ agentId: 'scout-07', kind: 'verified', complexity: 7, trigger: 'event', verification: 'verified', status: 'completed', evidence: { source: 'onchain_tx', operation: 'simulation', chainId: 46630, blockNumber: 1, txHash: '0x' + 'c'.repeat(64), receiptStatus: 'success' } }) });
  assert.equal(previewSimulated.body.xpAwarded, 0);
  // Real user_recorded evidence still gives positive XP
  const previewUser = await request('/api/agents/level-preview', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ agentId: 'scout-07', kind: 'verified', complexity: 7, trigger: 'event', verification: 'verified', status: 'completed', evidence: { source: 'user_recorded', operation: 'unknown', chainId: 46630, blockNumber: 0 } }) });
  assert.equal(previewUser.status, 200);
  assert.ok(previewUser.body.xpAwarded > 0);

  // Vibe sync state persists cursor
  const sync = await request('/api/registry/sync-state');
  assert.equal(sync.status, 200);
  assert.equal(sync.body.source, 'vibe_indexer');

  console.log(JSON.stringify({ smoke: 'ok', levelCount: levels.body.levels.length, runId: first.body.run.id, replay: replay.body.idempotentReplay, verificationRate: summary.body.verificationRate, evidenceBreakdown: summary.body.evidenceBreakdown }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
