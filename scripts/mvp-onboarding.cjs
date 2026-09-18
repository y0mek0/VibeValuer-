// Onboarding flow test
const base = 'http://127.0.0.1:4310';
async function req(path, options = {}) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { text }; }
  return { status: res.status, json };
}
(async () => {
  // Step 1: register
  let r = await req('/api/onboarding/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Trading Agent', email: 'test@example.com' }) });
  console.log('step1_register:', r.status, r.json.onboarding?.status, r.json.onboarding?.id);
  if (r.status !== 201) throw new Error('register failed');
  const obId = r.json.onboarding.id;
  // Step 2: generate challenge
  r = await req('/api/onboarding/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboardingId: obId, walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD72' }) });
  console.log('step2_challenge:', r.status, !!r.json.message, r.json.nonce ? 'nonce_ok' : 'no_nonce');
  if (r.status !== 200) throw new Error('challenge failed');
  // Step 3: verify (needs real wallet sig — use ethers to sign)
  const { JsonRpcProvider, Wallet, verifyMessage } = require('ethers');
  const wallet = new Wallet('0x' + '74'.repeat(32), new JsonRpcProvider('https://.rpc.t.hyperdivision.dev'));
  const sig = await wallet.signMessage(r.json.message);
  const recovered = verifyMessage(r.json.message, sig);
  console.log('wallet_sig:', sig.slice(0, 16) + '...', 'recovered:', recovered);
  r = await req('/api/onboarding/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboardingId: obId, walletAddress: wallet.address, nonce: r.json.nonce, expires: r.json.expires, signature: sig }) });
  console.log('step3_verify:', r.status, r.json.onboarding?.status);
  if (r.status !== 200) throw new Error('verify failed: ' + JSON.stringify(r.json));
  // Step 4: finalize — need an agent id that exists or create one
  // Finalize with a new agent id
  r = await req('/api/onboarding/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboardingId: obId, agentId: obId }) });
  console.log('step4_finalize:', r.status, r.json.onboarding?.status, r.json.agent?.id);
  if (r.status !== 200) throw new Error('finalize failed: ' + JSON.stringify(r.json));
  // Step 5: record a run for this agent
  r = await req('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: obId, kind: 'verified', complexity: 5, trigger: 'agent', verification: 'user_confirmed', status: 'completed', idempotencyKey: 'ob-test-' + Date.now(), evidence: { source: 'user_recorded', operation: 'onboarding_first_run', chainId: 46630 } }) });
  console.log('step5_run:', r.status, r.json.run?.xpAwarded, 'XP', JSON.stringify(r.json).slice(0,200));
  if (r.status !== 201) { console.error('run failed:', JSON.stringify(r.json, null, 2)); throw new Error('run failed: ' + JSON.stringify(r.json).slice(0, 200)); }
  // Check agent exists
  r = await req('/api/agents/' + obId);
  console.log('agent_check:', r.status, r.json.agent?.name);
  // Check audit log has onboarding
  r = await req('/api/audit?action=onboarding.completed&limit=5');
  console.log('audit:', r.status, (r.json.entries || []).length, 'onboarding events');
  if (!r.json.entries?.length) throw new Error('no audit onboarding entry');
  console.log('ALL ONBOARDING STEPS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
