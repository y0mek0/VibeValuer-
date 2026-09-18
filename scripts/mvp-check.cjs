const { Wallet, verifyMessage } = require('ethers');
const { computeSignature } = require('../src/auth');
(async () => {
  const wallet = Wallet.createRandom();
  const secret = 'dev-agent-secret-change-me';
  const ts = String(Date.now());
  const body = JSON.stringify({
    agentId: 'quant-01', kind: 'verified', complexity: 5, trigger: 'event',
    verification: 'verified', status: 'completed',
    idempotencyKey: 'mvp-' + Date.now(),
    evidence: { source: 'user_recorded', operation: 'unknown', chainId: 46630, blockNumber: 1 }
  });
  const sig = computeSignature(secret, ts, 'POST', '/api/runs', body);
  const r1 = await fetch('http://127.0.0.1:4310/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': sig, 'X-Valuer-Actor': wallet.address, 'X-Valuer-Timestamp': ts }, body
  });
  console.log('agent_run_status:', r1.status);

  const ts2 = String(Date.now());
  const sig2 = computeSignature(secret, ts2, 'POST', '/api/registry/challenge', '');
  // First import the registry record
  const adminSecret = 'dev-admin-secret-change-me';
  const importBody = JSON.stringify({ source: 'mvp_test', agents: [{ id: 'launch:test', name: 'MVP test', role: 'test', evidenceStatus: 'unavailable' }] });
  const importSig = computeSignature(adminSecret, ts2, 'POST', '/api/registry/import', importBody);
  const importRes = await fetch('http://127.0.0.1:4310/api/registry/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': importSig, 'X-Valuer-Actor': 'admin', 'X-Valuer-Timestamp': ts2 }, body: importBody });
  console.log('import_status:', importRes.status);

  const r2 = await fetch('http://127.0.0.1:4310/api/registry/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': sig2, 'X-Valuer-Timestamp': ts2 },
    body: JSON.stringify({ registryId: 'launch:test', agentId: 'quant-01' })
  });
  const challenge = await r2.json();
  console.log('challenge_status:', r2.status, 'has_message:', !!challenge.message);

  const signature = await wallet.signMessage(challenge.message);
  const recovered = verifyMessage(challenge.message, signature);
  console.log('signature_match:', recovered.toLowerCase() === wallet.address.toLowerCase());

  const ts3 = String(Date.now());
  const sig3 = computeSignature(secret, ts3, 'POST', '/api/registry/verify-link', '');
  const r3 = await fetch('http://127.0.0.1:4310/api/registry/verify-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': sig3, 'X-Valuer-Timestamp': ts3 },
    body: JSON.stringify({ registryId: 'launch:test', agentId: 'quant-01', nonce: challenge.nonce, signature, expectedAddress: wallet.address })
  });
  const v = await r3.json();
  const found = v.registry && v.registry.agents && v.registry.agents.find(function (a) { return a.id === 'launch:test'; });
  console.log('verify_status:', r3.status, 'linkStatus:', found && found.linkStatus);

  // Bad signature rejected
  const r4 = await fetch('http://127.0.0.1:4310/api/registry/verify-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registryId: 'launch:test', agentId: 'quant-01', nonce: challenge.nonce, signature: '0x' + '0'.repeat(130) })
  });
  console.log('bad_sig_status:', r4.status, await r4.json().then(function (j) { return j.details || j.error; }));

  // On-chain verifier rejects fake txHash
  const preview = await fetch('http://127.0.0.1:4310/api/agents/level-preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: 'quant-01', kind: 'verified', complexity: 5, trigger: 'event',
      verification: 'verified', status: 'completed',
      evidence: { source: 'onchain_tx', operation: 'real_operation', chainId: 46630, blockNumber: 1, txHash: '0x' + 'f'.repeat(64), receiptStatus: 'success' }
    })
  });
  const pv = await preview.json();
  console.log('onchain_bad_tx:', preview.status, 'xp:', pv.xpAwarded, 'verified:', pv.evidenceVerified, 'policy:', pv.policyViolation);

  // Real on-chain tx from Vibe indexer (chain head test)
  const vibeStatus = await fetch('http://127.0.0.1:4310/api/vibe/status').then(function (r) { return r.json(); });
  console.log('vibe_chain_match:', vibeStatus.chainMatch, 'latest:', vibeStatus.latestBlock);
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
