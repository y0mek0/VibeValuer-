require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { URL } = require('url');
const { LEVELS, calculateXp, getMetrics, getLevel } = require('./src/scoring');
const { validateRunInput } = require('./src/validate');
const db = require('./src/db');
const vibeAdapter = require('./src/vibe-adapter');
const identity = require('./src/identity');
const { authenticateRequest, loadSecrets } = require('./src/auth');
const jwt = require('./src/jwt');
const session = require('./src/session');
const worker = require('./src/sync-worker');
const rateLimit = require('./src/rate-limit');
const backup = require('./src/backup');
const slasher = require('./src/slasher');
const watchtower = require('./src/watchtower');
const { hub, setupWebSocket, heartbeat } = require('./src/events');
const correlate = require('./src/correlate');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4310);
const REQUIRE_AGENT_AUTH = process.env.REQUIRE_AGENT_AUTH === '1';
const AUTO_SYNC_WORKER = process.env.AUTO_SYNC_WORKER === '1';
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000);

db.initDb();
loadSecrets();

function send(res, status, body) {
  const body2 = body === undefined || body === null ? '' : body;
  const payload = typeof body2 === 'string' ? body2 : JSON.stringify(body2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}
function sendRaw(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendWithHeaders(res, status, body, headers) {
  const body2 = body === undefined || body === null ? '' : body;
  const payload = typeof body2 === 'string' ? body2 : JSON.stringify(body2);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(payload);
}

async function readBody(req) {
  const raw = [];
  try { for await (const chunk of req) raw.push(chunk); } catch (e) { /* ignore */ }
  return raw.join('');
}

function safeJsonParse(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

function requireRole(req, raw, requiredRole) {
  const rl = rateLimit.take({ role: requiredRole || 'public', path: req.url });
  if (!rl.allowed) return { error: { status: 429, body: { error: 'rate_limit_exceeded', retryAfterMs: rl.resetMs } } };
  const sessAuth = session.currentUser(req);
  if (sessAuth) {
    if (!session.can(sessAuth, requiredRole)) {
      return { error: { status: 403, body: { error: 'insufficient_role', required: requiredRole, current: sessAuth.role || sessAuth.payload?.role } } };
    }
    return { auth: sessAuth };
  }
  const hmacAuth = authenticateRequest(req, raw, requiredRole);
  if (!hmacAuth.ok) return { error: { status: 401, body: { error: 'hmac_required', details: hmacAuth.error } } };
  if (!session.can({ actor: hmacAuth.actor, role: hmacAuth.role }, requiredRole)) {
    return { error: { status: 403, body: { error: 'insufficient_role', required: requiredRole, current: hmacAuth.role } } };
  }
  return { auth: { actor: hmacAuth.actor, role: hmacAuth.role } };
}

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.json': 'application/json', '.txt': 'text/plain', '.woff2': 'font/woff2'
};

function resolveFile(file) {
  let clean = (file || '/').replace(/^\/+/, '');
  if (clean === '' || clean === '/') clean = 'index.html';
  const resolved = path.resolve(PUBLIC, clean);
  return resolved.startsWith(path.resolve(PUBLIC)) ? resolved : null;
}

function recentEvents({ limit = 50, type } = {}) {
  const audit = db.auditLog({ limit: Math.max(limit, 50) });
  if (type === 'audit') return audit;
  // mix audit + runs for general purpose
  const runs = db.prepare("SELECT id AS id, 'run.record' AS action, agent_id AS agentId, 'api' AS actor, kind AS details, created_at AS createdAt FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.max(limit, 10));
  return audit.concat(runs.map(r => ({ id: r.id, action: r.action, actor: r.actor, agentId: r.agentId, runId: null, registryId: null, details: { kind: r.details }, level: 'info', createdAt: r.createdAt }))).slice(0, limit);
}

const server = http.createServer(async (req, res) => {
  try {
    return await handleRequest(req, res);
  } catch (err) {
    console.error('[server]', req.method, req.url, '→', err && err.stack || err);
    try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'internal', message: err && err.message })); } } catch (e) { /* ignore */ }
    try { res.end(); } catch (e) { /* ignore */ }
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const raw = await readBody(req);
  const body = safeJsonParse(raw);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-valuer-signature, x-valuer-actor, x-valuer-timestamp', 'Access-Control-Max-Age': '86400' });
    return res.end();
  }

  // ─── Health ─────────────────────────────────────────────────────────────
  if (url.pathname === '/api/health') {
    return send(res, 200, { ok: true, service: 'vibe-agents-lvl-valuer', storage: 'sqlite', now: new Date().toISOString(), uptime: process.uptime() });
  }

  // ─── Auth ───────────────────────────────────────────────────────────────
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if (!body || !body.username || !body.password) return send(res, 400, { error: 'username and password required' });
    const result = session.login({ username: body.username, password: body.password });
    if (!result.ok) return send(res, 401, { error: result.error || 'invalid credentials' });
    db.recordAudit({ action: 'auth.login', actor: result.user.actor, details: { role: result.user.role } });
    return sendWithHeaders(res, 200, { ok: true, token: result.token, user: result.user }, { 'Set-Cookie': session.cookieFor(result.token) });
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const sess = session.currentUser(req);
    if (sess) db.recordAudit({ action: 'auth.logout', actor: sess.actor });
    return sendWithHeaders(res, 200, { ok: true }, { 'Set-Cookie': session.clearCookie() });
  }
  function authSession() {
    const sess = session.currentUser(req);
    return sess ? { authenticated: true, user: { actor: sess.actor, role: sess.payload?.role || sess.role }, permissions: sess.payload?.scope || [] } : null;
  }
  if ((url.pathname === '/api/auth/session' || url.pathname === '/api/auth/me') && req.method === 'GET') {
    const data = authSession();
    if (!data) return send(res, 401, { error: 'not authenticated' });
    return send(res, 200, data);
  }
  // HMAC-issued dev token endpoint (used by scripts)
  if (url.pathname === '/api/auth/token' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const ttl = Number(url.searchParams.get('ttlMs') || body?.ttlMs || 60 * 60 * 1000);
    const token = jwt.signToken({ actor: a.auth.actor, role: a.auth.role, scope: ['admin'] }, { ttlMs: ttl });
    return send(res, 200, { ok: true, token });
  }
  // Passkey / wallet auth stubs (treated as auth challenges)
  if (url.pathname === '/api/auth/passkey/challenge' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    return send(res, 200, { ok: true, challenge: identity.createChallenge({ registryId: body?.wallet || '0x000', agentId: '' }) });
  }
  if (url.pathname === '/api/auth/passkey/verify' && req.method === 'POST') {
    if (!body?.wallet || !body?.message || !body?.signature) return send(res, 400, { error: 'wallet, message, signature required' });
    const ok = identity.verifyWalletSignature(body.wallet, body.message, body.signature);
    if (!ok) return send(res, 401, { error: 'invalid signature' });
    const token = jwt.signToken({ actor: 'wallet:' + body.wallet, role: 'agent', scope: ['agent'] });
    db.recordAudit({ action: 'auth.passkey', actor: 'wallet:' + body.wallet });
    return sendWithHeaders(res, 200, { ok: true, token, role: 'agent' }, { 'Set-Cookie': session.cookieFor(token) });
  }
  // EIP-4361 wallet auth
  if (url.pathname === '/api/auth/eth/challenge' && req.method === 'POST') {
    if (!body?.wallet) return send(res, 400, { error: 'wallet required' });
    const challenge = identity.createChallenge({ registryId: body.wallet || '0x0', agentId: '' });
    return send(res, 200, { ok: true, wallet: body.wallet, ...challenge });
  }
  if (url.pathname === '/api/auth/eth/verify' && req.method === 'POST') {
    if (!body?.wallet || !body?.message || !body?.signature) return send(res, 400, { error: 'wallet, message, signature required' });
    const ok = identity.verifyWalletSignature(body.wallet, body.message, body.signature);
    if (!ok) return send(res, 401, { error: 'invalid signature' });
    const token = jwt.signToken({ actor: 'wallet:' + body.wallet, role: 'agent', scope: ['agent'] });
    db.recordAudit({ action: 'auth.eth', actor: 'wallet:' + body.wallet });
    return sendWithHeaders(res, 200, { ok: true, token, role: 'agent' }, { 'Set-Cookie': session.cookieFor(token) });
  }

  // ─── Frontend alias routes (no-auth info) ───────────────────────────────
  if (url.pathname === '/api/vibe/status' && req.method === 'GET') {
    return send(res, 200, await vibeAdapter.getNetworkStatus());
  }
  if (url.pathname === '/api/worker/status' && req.method === 'GET') {
    return send(res, 200, { worker: worker.status() });
  }
  if (url.pathname === '/api/security/status' && req.method === 'GET') {
    return send(res, 200, session.securityStatus());
  }
  if (url.pathname === '/api/levels' && req.method === 'GET') {
    // Map LEVELS to frontend-friendly shape
    const out = LEVELS.map((l, idx) => ({
      level: idx + 1,
      name: typeof l === 'string' ? l : (l.name || ('Stage ' + (idx+1))),
      xp: (typeof l === 'object' && l.xp) ? l.xp : (idx * 10),
      manual: (typeof l === 'object' && l.manual !== undefined) ? l.manual : idx,
      delegated: (typeof l === 'object' && l.delegated !== undefined) ? l.delegated : Math.floor(idx/2),
      automated: (typeof l === 'object' && l.automated !== undefined) ? l.automated : Math.floor(idx/3),
      transition: [5,10,15,20,25,30].includes(idx+1)
    }));
    return send(res, 200, { levels: out });
  }
  if (url.pathname === '/api/summary' && req.method === 'GET') {
    const sum = db.summary();
    const breakdown = (typeof db.evidenceBreakdown === 'function') ? db.evidenceBreakdown() : [];
    let policyViolations = 0;
    try { policyViolations = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE policy_violation = 1").get().c; } catch (e) { /* ignore */ }
    return send(res, 200, Object.assign({}, sum, { evidenceBreakdown: breakdown, policyViolations }));
  }
  if (url.pathname === '/api/public/agents' && req.method === 'GET') {
    return send(res, 200, db.publicAgents({ limit: Number(url.searchParams.get('limit') || 100), sortBy: url.searchParams.get('sortBy') || 'xp' }));
  }

  // ─── Agents ─────────────────────────────────────────────────────────────
  if (url.pathname === '/api/agents' && req.method === 'GET') {
    const agents = db.listAgents();
    const out = agents.map(agent => {
      const metrics = getMetrics(agent);
      const levelInfo = getLevel(metrics);
      return Object.assign({}, agent, {
        runs: agent.runs || [],
        level: {
          level: levelInfo ? levelInfo.level : 0,
          name: (levelInfo && levelInfo.name) || 'Starter',
          xp: (levelInfo && levelInfo.xp != null) ? levelInfo.xp : 0,
          next: (levelInfo && levelInfo.next) ? {
            level: levelInfo.next.level,
            name: levelInfo.next.name || '',
            xp: levelInfo.next.xp || 0
          } : null
        },
        metrics: {
          xp: metrics.xp,
          successRate: metrics.successRate,
          autonomyRate: metrics.autonomyRate,
          evidenceRate: metrics.evidenceRate,
          manualActions: metrics.manual,
          delegatedTasks: metrics.delegated,
          automatedRuns: metrics.automated,
          completed: metrics.completed,
          verified: metrics.verified,
          interventions: metrics.interventions
        },
        manualActions: metrics.manualActions,
        delegatedTasks: metrics.delegatedTasks,
        automatedRuns: metrics.automatedRuns,
        nextLevel: levelInfo && levelInfo.next ? levelInfo.next.level : null
      });
    });
    return send(res, 200, { agents: out, count: out.length });
  }

  // ─── Registry ───────────────────────────────────────────────────────────
  if (url.pathname === '/api/registry' && req.method === 'GET') return send(res, 200, db.registry());
  if (url.pathname === '/api/registry/creators' && req.method === 'GET') return send(res, 200, db.creatorsRegistry());
  if (url.pathname === '/api/registry/sync-state' && req.method === 'GET') {
    const syncObj = db.syncState('vibe_indexer') || { status: 'idle', pages_total: 0, last_imported: 0 };
    return send(res, 200, Object.assign({}, syncObj, { worker: worker.status() }));
  }
  if (url.pathname === '/api/agents/registry' && req.method === 'GET') return send(res, 200, db.registry());

  // ─── Onboarding ────────────────────────────────────────────────────────
  if (url.pathname === '/api/onboarding/register' && req.method === 'POST') {
    if (!body?.name) return send(res, 400, { error: 'name required' });
    const a = db.createOnboardingAgent({ name: String(body.name).slice(0,160), email: body.email ? String(body.email).slice(0,160) : null });
    db.recordAudit({ action: 'onboarding.register', actor: 'api', details: { id: a.id, name: a.name } });
    return send(res, 200, { ok: true, agent: a });
  }
  if (url.pathname === '/api/onboarding/agents' && req.method === 'GET') return send(res, 200, { agents: db.listOnboardingAgents() });
  if (url.pathname === '/api/onboarding/challenge') {
    const id = (body && body.onboardingId) || url.searchParams.get('id');
    if (!id) return send(res, 400, { error: 'onboardingId required' });
    const challenge = identity.createChallenge({ registryId: '', agentId: '' });
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60 * 1000);
    try { db.setOnboardingWallet({ id, challengeNonce: challenge.nonce, challengeExpires: expires.toISOString() }); } catch (e) { /* may fail if not yet attached */ }
    return send(res, 200, { ok: true, nonce: challenge.nonce, message: challenge.message, expiresAt: expires.toISOString() });
  }
  if (url.pathname === '/api/onboarding/verify' && req.method === 'POST') {
    if (!body?.id || !body?.wallet || !body?.signature || !body?.message) return send(res, 400, { error: 'id, wallet, signature, message required' });
    if (!identity.verifyWalletSignature(body.wallet, body.message, body.signature)) return send(res, 401, { error: 'invalid signature' });
    const agent = db.confirmOnboardingWallet({ id: body.id, signature: body.signature, recoveredAddress: body.wallet });
    return send(res, 200, { ok: true, agent });
  }
  if (url.pathname === '/api/onboarding/finalize' && req.method === 'POST') {
    if (!body?.onboardingId || !body?.agentId) return send(res, 400, { error: 'onboardingId and agentId required' });
    const result = db.finalizeOnboarding({ onboardingId: body.onboardingId, agentId: body.agentId });
    db.recordAudit({ action: 'onboarding.finalize', actor: 'api', agentId: body.agentId, details: result });
    return send(res, 200, { ok: true, result });
  }

  // ─── Runs ───────────────────────────────────────────────────────────────
  if (url.pathname === '/api/runs' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    const agentId = url.searchParams.get('agentId') || null;
    const allRuns = db.exportSnapshot().runs;
    const filtered = agentId ? allRuns.filter(r => r.agentId === agentId) : allRuns;
    return send(res, 200, { runs: filtered.slice(0, limit), count: filtered.length });
  }
  if (url.pathname === '/api/runs' && req.method === 'POST') {
    const a = requireRole(req, raw, 'agent'); if (a.error) return send(res, a.error.status, a.error.body);
    const validation = validateRunInput(body || {});
    if (validation.errors && validation.errors.length) return send(res, 400, { error: 'validation_failed', details: validation.errors });
    const agent = db.getAgent(validation.value.agentId);
    if (!agent) return send(res, 404, { error: 'agent not found' });
    const idempKey = validation.value.idempotencyKey;
    if (idempKey) {
      const existing = db.findRunByIdempotency(idempKey);
      if (existing) return send(res, 200, { ok: true, run: existing, idempotent: true });
    }
    const runInput = Object.assign({}, validation.value, {
      id: 'run-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
      createdAt: new Date().toISOString(),
      xpAwarded: 0
    });
    try {
      const run = db.insertRun(agent, runInput);
      db.recordAudit({ action: 'run.record', actor: a.auth.actor, agentId: agent.id, runId: run.id, details: { kind: run.kind, complexity: run.complexity, verification: run.verification } });
      hub.emit('run.record', { run });
      return send(res, 201, { ok: true, run });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // ─── Appeals ────────────────────────────────────────────────────────────
  if (url.pathname === '/api/appeals' && req.method === 'GET') {
    return send(res, 200, { appeals: db.listAppeals({}) });
  }
  if (url.pathname === '/api/appeals' && req.method === 'POST') {
    const a = requireRole(req, raw, 'agent'); if (a.error) return send(res, a.error.status, a.error.body);
    if (!body?.agentId || !body?.reason) return send(res, 400, { error: 'agentId and reason required' });
    try {
      const appeal = db.createAppeal({ agentId: body.agentId, runId: body.runId || null, reason: body.reason, evidenceUrl: body.evidenceUrl || null, actor: a.auth.actor });
      return send(res, 201, { ok: true, appeal });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  // POST /api/appeals/decide or /api/appeals/:id/decide
  if (url.pathname === '/api/appeals/decide' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    if (!body?.appealId || !body?.status) return send(res, 400, { error: 'appealId and status required' });
    try {
      const appeal = db.decideAppeal({ appealId: body.appealId, status: body.status, decision: body.decision || null, reviewer: a.auth.actor });
      return send(res, 200, { ok: true, appeal });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  const appealDecisionMatch = url.pathname.match(/^\/api\/appeals\/([a-zA-Z0-9_-]+)\/decide$/);
  if (appealDecisionMatch && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const appealId = appealDecisionMatch[1];
    if (!body?.status) return send(res, 400, { error: 'status required' });
    try {
      const appeal = db.decideAppeal({ appealId, status: body.status, decision: body.decision || null, reviewer: a.auth.actor });
      return send(res, 200, { ok: true, appeal });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // ─── Events / Live ──────────────────────────────────────────────────────
  if (url.pathname === '/api/events/stream' && req.method === 'GET') {
    return hub.attachSse(res);
  }
  if (url.pathname === '/api/live/stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    return;
  }
  if (url.pathname === '/api/events/recent' && req.method === 'GET') return send(res, 200, { events: recentEvents({ limit: 50 }) });
  if (url.pathname === '/api/live/events' && req.method === 'GET') return send(res, 200, { events: recentEvents({ limit: 50 }) });
  if (url.pathname === '/api/audits/events' && req.method === 'GET') return send(res, 200, { audits: db.auditLog({ limit: 50 }) });
  if (url.pathname === '/api/audit' && req.method === 'GET') {
    return send(res, 200, { entries: db.auditLog({ limit: Number(url.searchParams.get('limit') || 50) }) });
  }

  // ─── Vibe Indexer ────────────────────────────────────────────────────────
  if (url.pathname === '/api/vibe/index' && req.method === 'GET') {
    return send(res, 200, await vibeAdapter.getNetworkStatus());
  }
  if (url.pathname === '/api/vibe/launches' && req.method === 'GET') {
    return send(res, 200, db.registry());
  }
  if (url.pathname === '/api/vibe/verify-tx' && req.method === 'POST') {
    if (!body?.txHash) return send(res, 400, { error: 'txHash required' });
    try {
      const result = await vibeAdapter.verifyOnchainEvidence(body.txHash);
      return send(res, 200, { ok: true, evidence: result });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  // ─── Correlate ──────────────────────────────────────────────────────────
  if (url.pathname === '/api/correlate/agent' && req.method === 'GET') {
    const wallet = url.searchParams.get('wallet');
    const txHash = url.searchParams.get('txHash');
    const run2 = wallet ? correlate.correlateRun(wallet) : null;
    const agent = correlate.correlateAgent ? correlate.correlateAgent('auto') : null;
    return send(res, 200, { correlation: { wallet, txHash, run: run2, agent } });
  }
  if (url.pathname === '/api/correlate/run' && req.method === 'GET') {
    const runId = url.searchParams.get('runId');
    if (!runId) return send(res, 400, { error: 'runId required' });
    return send(res, 200, { correlation: correlate.correlateRun(runId) });
  }

  // ─── Watchtower ─────────────────────────────────────────────────────────
  if (url.pathname === '/api/watchtower/duplicates' && req.method === 'GET') {
    return send(res, 200, { duplicates: watchtower.scanDuplicates() });
  }
  if (url.pathname === '/api/watchtower/sybil' && req.method === 'GET') {
    return send(res, 200, { patterns: watchtower.scanSybilWallets ? watchtower.scanSybilWallets() : [] });
  }

  // ─── Admin actions ──────────────────────────────────────────────────────
  if (url.pathname === '/api/admin/backups' && req.method === 'GET') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    return send(res, 200, { backups: backup.listBackups() });
  }
  if (url.pathname === '/api/admin/backup' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    try { const r = backup.createBackup(); db.recordAudit({ action: 'admin.backup', actor: a.auth.actor, details: r }); return send(res, 200, r); } catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/admin/decay' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const r = db.decayAgentReputation({ thresholdDays: body?.thresholdDays, decayPercent: body?.decayPercent, minDecay: body?.minDecay });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/admin/slash' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    if (!body?.agentId) return send(res, 400, { error: 'agentId required' });
    try {
      const r = slasher.slashAgent({ agentId: body.agentId, reason: body.reason, evidence: body.evidence, ratio: body.ratio });
      db.recordAudit({ action: 'admin.slash', actor: a.auth.actor, agentId: body.agentId, details: { reason: body.reason } });
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/admin/export' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const snapshot = db.exportSnapshot();
    return send(res, 200, snapshot);
  }
  if (url.pathname === '/api/admin/cleanup' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const r = db.cleanupStaleRegistry({ staleDays: Number(body?.staleDays || 30) });
    db.recordAudit({ action: 'admin.cleanup', actor: a.auth.actor, details: r });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/admin/recompute' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const agents = db.listAgents();
    const results = [];
    for (const agent of agents) results.push({ agentId: agent.id, ...db.recomputeAgentEvaluation(agent.id) });
    db.recordAudit({ action: 'admin.recompute', actor: a.auth.actor });
    return send(res, 200, { results });
  }
  if (url.pathname === '/api/admin/worker' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    if (!body?.action) return send(res, 400, { error: 'action required' });
    let result = null;
    if (body.action === 'start') { worker.start({ intervalMs: SYNC_INTERVAL_MS }); result = worker.status(); }
    else if (body.action === 'stop') { worker.stop(); result = worker.status(); }
    else if (body.action === 'run_once') { result = await worker.tick(); }
    else return send(res, 400, { error: 'unknown action' });
    return send(res, 200, { action: body.action, result });
  }
  if (url.pathname === '/api/watchtower/run' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    return send(res, 200, { duplicates: watchtower.scanDuplicates(), executedAt: new Date().toISOString() });
  }

  // ─── Frontend aliases (POST) ────────────────────────────────────────────
  if (url.pathname === '/api/worker/sync-now' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const tick = await worker.tick();
    return send(res, 200, { ok: true, result: tick || null });
  }
  if (url.pathname === '/api/worker/start' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    worker.start({ intervalMs: SYNC_INTERVAL_MS });
    return send(res, 200, { ok: true, status: worker.status() });
  }
  if (url.pathname === '/api/worker/stop' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    worker.stop();
    return send(res, 200, { ok: true, status: worker.status() });
  }
  if (url.pathname === '/api/backup/create' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    try { const r = backup.createBackup(); db.recordAudit({ action: 'admin.backup', actor: a.auth.actor, details: r }); return send(res, 200, r); } catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (url.pathname === '/api/reputation/decay' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const r = db.decayAgentReputation({ thresholdDays: body?.thresholdDays, decayPercent: body?.decayPercent, minDecay: body?.minDecay });
    db.recordAudit({ action: 'reputation.decay', actor: a.auth.actor, details: r });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/registry/cleanup-stale' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const r = db.cleanupStaleRegistry({ staleDays: Number(body?.staleDays || 30) });
    db.recordAudit({ action: 'registry.cleanup_stale', actor: a.auth.actor, details: r });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/export' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    return send(res, 200, db.exportSnapshot());
  }
  if (url.pathname === '/api/registry/sync-vibe' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    const tick = await worker.tick();
    return send(res, 200, { ok: true, tick: tick || null });
  }
  if (url.pathname === '/api/registry/import' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    if (!body?.agents) return send(res, 400, { error: 'agents array required' });
    const r = db.importRegistry(body.agents);
    db.recordAudit({ action: 'registry.import', actor: a.auth.actor, details: { imported: r.imported } });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/registry/challenge' && req.method === 'POST') {
    const challenge = identity.createChallenge({ registryId: body?.wallet || '0x0', agentId: '' });
    return send(res, 200, { ok: true, ...challenge });
  }
  if (url.pathname === '/api/registry/link' && req.method === 'POST') {
    const a = requireRole(req, raw, 'admin'); if (a.error) return send(res, a.error.status, a.error.body);
    if (!body?.registryId || !body?.agentId) return send(res, 400, { error: 'registryId and agentId required' });
    try {
      const r = db.linkRegistry(body.registryId, body.agentId, body.linkStatus || 'linked_unverified');
      db.recordAudit({ action: 'registry.link', actor: a.auth.actor, agentId: body.agentId, details: { registryId: body.registryId } });
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  // ─── Static files ───────────────────────────────────────────────────────
  const safe = resolveFile(url.pathname);
  if (safe && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
    const ext = path.extname(safe).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html' || ext === '.svg') {
      return sendRaw(res, 200, fs.readFileSync(safe), type);
    }
    res.writeHead(200, { 'Content-Type': type + (type.startsWith('text/') || type === 'application/javascript' ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store' });
    fs.createReadStream(safe).pipe(res);
    return;
  }

  return send(res, 404, { error: 'not_found', path: url.pathname });
  }


  // WebSocket + heartbeat
// WebSocket + heartbeat
heartbeat();

if (AUTO_SYNC_WORKER) worker.start({ intervalMs: SYNC_INTERVAL_MS });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[VibeValuer] listening on http://127.0.0.1:${PORT}`);
  console.log(`[VibeValuer] storage: sqlite, hardened: ${process.env.VALUER_HARDENED === '1' || process.env.NODE_ENV === 'production'}`);
});
