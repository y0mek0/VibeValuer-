const crypto = require('node:crypto');

const HMAC_HEADER = 'x-valuer-signature';
const ACTOR_HEADER = 'x-valuer-actor';
const TIMESTAMP_HEADER = 'x-valuer-timestamp';

function loadSecrets() {
  const hardened = process.env.NODE_ENV === 'production' || process.env.VALUER_HARDENED === '1';
  const adminSecret = process.env.VALUER_ADMIN_SECRET || (hardened ? '' : 'dev-admin-secret-change-me');
  const agentSecret = process.env.VALUER_AGENT_SECRET || (hardened ? '' : 'dev-agent-secret-change-me');
  const sessionSecret = process.env.VALUER_SESSION_SECRET || (hardened ? '' : 'dev-session-secret-change-me');
  if (hardened && (!adminSecret || !agentSecret || !sessionSecret)) throw new Error('production_secrets_missing');
  return { adminSecret, agentSecret, sessionSecret, hardened };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (error) {
    return false;
  }
}

function computeSignature(secret, timestamp, method, path, rawBody) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${method.toUpperCase()}.${path}.${rawBody || ''}`);
  return hmac.digest('hex');
}

function authenticateRequest(req, rawBody, requiredRole = 'agent') {
  const { adminSecret, agentSecret } = loadSecrets();
  const signature = (req.headers[HMAC_HEADER] || '').toString();
  const actor = (req.headers[ACTOR_HEADER] || '').toString().trim();
  const timestamp = (req.headers[TIMESTAMP_HEADER] || '').toString();
  if (!signature || !actor || !timestamp) return { ok: false, error: 'missing auth headers' };
  const tsNumber = Number(timestamp);
  if (!Number.isFinite(tsNumber)) return { ok: false, error: 'invalid timestamp' };
  const drift = Math.abs(Date.now() - tsNumber);
  if (drift > 5 * 60 * 1000) return { ok: false, error: 'timestamp drift exceeds 5 minutes' };
  const expectedAgent = computeSignature(agentSecret, timestamp, req.method, req.url, rawBody || '');
  const expectedAdmin = computeSignature(adminSecret, timestamp, req.method, req.url, rawBody || '');
  if (requiredRole === 'admin') {
    if (!timingSafeEqualHex(signature, expectedAdmin)) return { ok: false, error: 'invalid admin signature' };
    return { ok: true, role: 'admin', actor };
  }
  if (requiredRole === 'agent' || requiredRole === 'either') {
    const agentMatch = timingSafeEqualHex(signature, expectedAgent);
    const adminMatch = timingSafeEqualHex(signature, expectedAdmin);
    if (!agentMatch && !adminMatch) return { ok: false, error: 'invalid agent signature' };
    return { ok: true, role: adminMatch ? 'admin' : 'agent', actor };
  }
  return { ok: false, error: 'unsupported required role' };
}

module.exports = { authenticateRequest, computeSignature, loadSecrets, HMAC_HEADER, ACTOR_HEADER, TIMESTAMP_HEADER };
