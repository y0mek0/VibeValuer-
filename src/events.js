const WebSocket = require('ws');
const crypto = require('node:crypto');

const SSE_EVENT_TYPES = new Set([
  'run.record', 'run.evidence_rejected', 'run.idempotent_replay',
  'registry.sync_vibe', 'registry.import', 'registry.link', 'registry.verify_link',
  'registry.challenge', 'registry.recompute', 'registry.cleanup_stale',
  'reputation.decay', 'fraud.proof.recorded', 'worker.sync_vibe',
  'system.heartbeat'
]);

class EventHub {
  constructor() {
    this.wssClients = new Set();
    this.sseClients = new Map();
    this.lastEvents = [];
    this.maxRingBuffer = 200;
  }

  emit(type, payload) {
    if (!SSE_EVENT_TYPES.has(type)) return;
    const event = Object.assign({ id: crypto.randomBytes(8).toString('hex'), type: type, ts: new Date().toISOString() }, payload || {});
    this.lastEvents.push(event);
    if (this.lastEvents.length > this.maxRingBuffer) this.lastEvents.shift();
    const data = JSON.stringify(event);
    for (const ws of this.wssClients) {
      try { ws.send(data); } catch (e) { /* ignore */ }
    }
    for (const [res] of this.sseClients.entries()) {
      try { res.write('event: ' + type + '\ndata: ' + data + '\n\n'); } catch (e) { /* ignore */ }
    }
    return event;
  }

  recent({ sinceTs, sinceId } = {}) {
    let filtered = this.lastEvents;
    if (sinceTs) filtered = filtered.filter(function (e) { return e.ts > sinceTs; });
    if (sinceId) {
      const idx = this.lastEvents.findIndex(function (e) { return e.id === sinceId; });
      if (idx >= 0) filtered = this.lastEvents.slice(idx + 1);
    }
    return filtered.slice(-50);
  }

  attachWebSocket(ws) {
    this.wssClients.add(ws);
    try { ws.send(JSON.stringify({ id: 'hello', type: 'system.heartbeat', ts: new Date().toISOString(), message: 'connected' })); } catch (e) { /* ignore */ }
  }

  detachWebSocket(ws) { this.wssClients.delete(ws); }

  attachSse(res) {
    this.sseClients.set(res, Date.now());
    res.on('close', () => this.sseClients.delete(res));
    try { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(': connected\n\n'); } catch (e) { /* ignore */ }
  }
}

const hub = new EventHub();

function setupWebSocket(server, authenticateRequest) {
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', function (req, socket, head) {
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (url.pathname !== '/api/events/ws') {
      try { socket.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    const tsHeader = req.headers['x-valuer-timestamp'] || url.searchParams.get('ts');
    const actorHeader = req.headers['x-valuer-actor'] || url.searchParams.get('actor');
    const sigHeader = req.headers['x-valuer-signature'] || url.searchParams.get('sig');
    if (!tsHeader || !actorHeader || !sigHeader) {
      try { socket.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    wss.handleUpgrade(req, socket, head, function (ws) {
      ws._auth = { actor: String(actorHeader), ts: tsHeader };
      hub.attachWebSocket(ws);
      ws.on('close', function () { hub.detachWebSocket(ws); });
      ws.on('error', function () { hub.detachWebSocket(ws); });
    });
  });
  return wss;
}

function heartbeat() {
  setInterval(function () { hub.emit('system.heartbeat', { uptimeMs: process.uptime() }); }, 15000).unref();
}

module.exports = { hub, setupWebSocket, heartbeat, SSE_EVENT_TYPES };
