const http = require('http');
const crypto = require('crypto');
const { WebSocket } = require('ws');

(async () => {
  const SECRET = 'dev-agent-secret-change-me';
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(ts + '.GET./api/events/ws.').digest('hex');
  console.log('--- WebSocket ---');
  const ws = new WebSocket('ws://127.0.0.1:4310/api/events/ws?ts=' + ts + '&actor=ws-test&sig=' + sig);
  let received = [];
  ws.on('open', function () { console.log('ws_connected'); });
  ws.on('message', function (msg) {
    received.push(msg.toString().slice(0, 200));
    if (received.length >= 3) { ws.close(); }
  });
  ws.on('close', function () {
    console.log('ws_received:', received.length, 'events');
    for (const r of received) console.log('  -', r);
  });
  ws.on('error', function (e) { console.log('ws_error:', e.message); });
  await new Promise(function (r) { setTimeout(r, 1500); });

  console.log('--- Rate limit ---');
  const ADMIN_SECRET = 'dev-admin-secret-change-me';
  let blocked = false;
  for (let i = 0; i < 130; i++) {
    const tts = String(Date.now());
    const ssig = crypto.createHmac('sha256', ADMIN_SECRET).update(tts + '.GET./api/health.').digest('hex');
    const result = await new Promise(function (resolve) {
      const r = http.request({ host: '127.0.0.1', port: 4310, path: '/api/health', method: 'GET', headers: { 'X-Valuer-Signature': ssig, 'X-Valuer-Timestamp': tts, 'X-Valuer-Actor': 'rl-test' } }, function (res) {
        res.on('data', function () {});
        res.on('end', function () { resolve(res.statusCode); });
      });
      r.end();
    });
    if (result === 429) { blocked = true; console.log('rate_limited_at_request:', i + 1); break; }
  }
  if (!blocked) console.log('rate_limit_not_triggered');
})();
