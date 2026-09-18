const http = require('http');
const crypto = require('crypto');
const { computeSignature, loadSecrets } = require('../src/auth');
const jwt = require('../src/jwt');

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
  console.log('--- JWT token issuance ---');
  const issued = await request('POST', '/api/auth/token', { actor: 'admin-test', role: 'admin', ttlMs: 60000 }, 'admin');
  console.log('issue:', issued.status, issued.body.slice(0, 300));
  const token = JSON.parse(issued.body).token;
  const verify = jwt.verify(token, loadSecrets().adminSecret);
  console.log('verify:', verify.ok, 'payload:', verify.ok && JSON.stringify(verify.payload));

  console.log('--- JWT bearer auth via run endpoint ---');
  const data = JSON.stringify({ agentId: 'quant-01', kind: 'simple', complexity: 4, trigger: 'user', verification: 'user_confirmed', status: 'completed', idempotencyKey: 'jwt-' + Date.now() });
  const opts = { host: '127.0.0.1', port: 4310, path: '/api/runs', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Authorization': 'Bearer ' + token } };
  const r = await new Promise(function (resolve) {
    const req = http.request(opts, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: chunks }); });
    });
    req.write(data);
    req.end();
  });
  console.log('bearer_run:', r.status, r.body.slice(0, 200));

  console.log('--- Passkey challenge + verify ---');
  const challenge = await request('POST', '/api/auth/passkey/challenge', { actor: 'agent-wallet' }, 'admin');
  console.log('challenge:', challenge.status, challenge.body);
  const nonce = JSON.parse(challenge.body).challenge;
  const signature = crypto.createHash('sha256').update(nonce).digest('hex');
  const verify2 = await request('POST', '/api/auth/passkey/verify', { actor: 'agent-wallet', challenge: nonce, signature: signature, role: 'agent' }, 'admin');
  console.log('verify:', verify2.status, verify2.body.slice(0, 300));

  console.log('--- On-chain log scan ---');
  const logs = await request('GET', '/api/onchain/logs?fromBlock=latest-2&toBlock=latest', null, 'admin');
  console.log('logs:', logs.status, logs.body.slice(0, 200));

  console.log('--- Event correlation ---');
  const runs = JSON.parse((await request('GET', '/api/agents/quant-07/runs', null, 'admin')).body || '{}');
  const lastRun = runs.runs && runs.runs[0];
  if (lastRun) {
    const corr = await request('GET', '/api/correlate/run?runId=' + lastRun.id, null, 'admin');
    console.log('correlate_run:', corr.status, corr.body.slice(0, 400));
  }
  const corrA = await request('GET', '/api/correlate/agent?agentId=quant-01', null, 'admin');
  console.log('correlate_agent:', corrA.status, corrA.body.slice(0, 300));
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
