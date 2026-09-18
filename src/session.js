const crypto = require('node:crypto');
const jwt = require('./jwt');
const { loadSecrets } = require('./auth');

const COOKIE_NAME = 'valuer_session';
const SESSION_TTL_MS = Number(process.env.VALUER_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const ROLES = ['viewer', 'agent', 'admin', 'owner'];
const ROLE_RANK = { viewer: 1, agent: 2, admin: 3, owner: 4 };

function isProductionStrict() {
  return process.env.NODE_ENV === 'production' || process.env.VALUER_HARDENED === '1';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingEqual(a, b) {
  if (!a || !b || String(a).length !== String(b).length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); } catch (e) { return false; }
}

function parseUsers() {
  const raw = process.env.VALUER_USERS_JSON;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('VALUER_USERS_JSON must be an array');
    return parsed.map(normalizeUser);
  }
  if (isProductionStrict()) return [];
  // Local-only bootstrap users. Do not use in production/hardened mode.
  return [
    { username: 'owner', role: 'owner', passwordHash: sha256('owner-local-demo') },
    { username: 'admin', role: 'admin', passwordHash: sha256('admin-local-demo') },
    { username: 'agent', role: 'agent', passwordHash: sha256('agent-local-demo') },
    { username: 'viewer', role: 'viewer', passwordHash: sha256('viewer-local-demo') }
  ];
}

function normalizeUser(user) {
  const username = String(user.username || user.actor || '').trim();
  const role = String(user.role || 'viewer').trim();
  const passwordHash = user.passwordHash || (user.password ? sha256(user.password) : null);
  if (!username) throw new Error('user username required');
  if (!ROLES.includes(role)) throw new Error('invalid user role: ' + role);
  if (!passwordHash) throw new Error('passwordHash required for ' + username);
  return { username, role, passwordHash: String(passwordHash) };
}

function login({ username, password }) {
  const users = parseUsers();
  const user = users.find(u => u.username === String(username || '').trim());
  if (!user) return { ok: false, error: 'invalid_login' };
  if (!timingEqual(sha256(password || ''), user.passwordHash)) return { ok: false, error: 'invalid_login' };
  const token = jwt.issue({ actor: user.username, role: user.role, scope: ['session'] }, loadSecrets().sessionSecret, SESSION_TTL_MS);
  return { ok: true, token, user: { actor: user.username, role: user.role }, expiresInMs: SESSION_TTL_MS };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function authFromCookie(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const verified = jwt.verify(token, loadSecrets().sessionSecret);
  if (!verified.ok) return null;
  const role = verified.payload.role;
  if (!ROLES.includes(role)) return null;
  return { ok: true, role, actor: verified.payload.actor, payload: verified.payload, via: 'session' };
}

function cookieFor(token) {
  const secure = process.env.VALUER_COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function can(auth, requiredRole) {
  if (!requiredRole || requiredRole === 'public') return true;
  if (!auth || !auth.role) return false;
  return (ROLE_RANK[auth.role] || 0) >= (ROLE_RANK[requiredRole] || 99);
}

function currentUser(req) {
  return authFromCookie(req);
}

function securityStatus() {
  const secrets = loadSecrets();
  const defaults = ['dev-admin-secret-change-me', 'dev-agent-secret-change-me', 'dev-session-secret-change-me'];
  const problems = [];
  if (defaults.includes(secrets.adminSecret)) problems.push('admin_secret_default');
  if (defaults.includes(secrets.agentSecret)) problems.push('agent_secret_default');
  if (defaults.includes(secrets.sessionSecret)) problems.push('session_secret_default');
  if (parseUsers().length === 0) problems.push('no_login_users_configured');
  return {
    hardened: isProductionStrict(),
    auth: { roles: ROLES, sessionCookie: COOKIE_NAME, ttlMs: SESSION_TTL_MS },
    status: problems.length ? (isProductionStrict() ? 'blocked' : 'dev_warnings') : 'ok',
    problems
  };
}

module.exports = { ROLES, ROLE_RANK, login, currentUser, authFromCookie, cookieFor, clearCookie, can, securityStatus, sha256, isProductionStrict };
