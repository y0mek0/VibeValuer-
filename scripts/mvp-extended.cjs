const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { WebSocket } = require('ws');
const SECRET = 'dev-admin-secret-change-me';

function request(method, path, body, role) {
  const SECRET_USE = role === 'admin' ? SECRET : 'dev-agent-secret-change-me';
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : '';
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', SECRET_USE).update(ts + '.' + method + '.' + path + '.' + data).digest('hex');
    const opts = { host: '127.0.0.1', port: 4310, path: path, method: method, headers: { 'Content-Type': 'application/json', 'X-Valuer-Signature': sig, 'X-Valuer-Timestamp': ts, 'X-Valuer-Actor': role + '-test' } };
    const req = http.request(opts, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: chunks }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('--- Backup ---');
  const create = await request('POST', '/api/backup/create', {}, 'admin');
  console.log('create:', create.status, create.body.slice(0, 200));
  const list = await request('GET', '/api/backup/list', null, 'admin');
  console.log('list:', list.status, JSON.parse(list.body).backups.length, 'backups');

  console.log('--- Fraud proofs ---');
  const proof = await request('POST', '/api/fraud/proofs', { agentId: 'quant-01', reason: 'fake_onchain_receipt', txHash: '0x' + 'a'.repeat(64), payload: { sample: true } }, 'admin');
  console.log('record:', proof.status, proof.body);
  const proofs = await request('GET', '/api/fraud/proofs', null, 'admin');
  console.log('list:', proofs.status, JSON.parse(proofs.body).proofs.length, 'proofs');

  console.log('--- Slash agent ---');
  const slash = await request('POST', '/api/fraud/slash', { agentId: 'quant-01', reason: 'fake_onchain_receipt', percent: 100 }, 'admin');
  console.log('slash:', slash.status, slash.body);

  console.log('--- SSE ---');
  const sseRes = await new Promise(function (resolve) {
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', 'dev-agent-secret-change-me').update(ts + '.GET./api/events/stream.').digest('hex');
    const req = http.request({ host: '127.0.0.1', port: 4310, path: '/api/events/stream', method: 'GET', headers: { 'X-Valuer-Signature': sig, 'X-Valuer-Timestamp': ts, 'X-Valuer-Actor': 'sse-test' } }, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c.toString(); if (chunks.length > 100) req.destroy(); });
      res.on('end', function () { resolve({ status: res.statusCode, body: chunks }); });
    });
    req.on('error', function () {});
    setTimeout(function () { req.destroy(); }, 1000);
    req.end();
  });
  console.log('sse:', sseRes.status, sseRes.body.slice(0, 200));

  console.log('--- Rate limit ---');
  let blocked = false;
  for (let i = 0; i < 130; i++) {
    const r = await request('GET', '/api/health', null, 'admin');
    if (r.status === 429) { blocked = true; console.log('rate_limited_at_request:', i + 1, r.body); break; }
  }
  if (!blocked) console.log('rate_limit_not_triggered');

  console.log('--- WebSocket ---');
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', 'dev-agent-secret-change-me').update(ts + '.GET./api/events/ws.').digest('hex');
  const ws = new WebSocket('ws://127.0.0.1:4310/api/events/ws?ts=' + ts + '&actor=ws-test&sig=' + sig);
  let received = [];
  ws.on('open', function () { console.log('ws_connected'); });
  ws.on('message', function (msg) {
    received.push(msg.toString().slice(0, 120));
    if (received.length >= 2) { ws.close(); }
  });
  ws.on('close', function () {
    console.log('ws_received:', received.length, 'events');
    for (const r of received) console.log('  -', r);
  });
  ws.on('error', function (e) { console.log('ws_error:', e.message); });

  await new Promise(function (r) { setTimeout(r, 1500); });
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
