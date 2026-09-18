const crypto = require('node:crypto');

const ISSUER = process.env.VALUER_JWT_ISSUER || 'vibe-agents-lvl-valuer';
const TTL_MS = Number(process.env.VALUER_JWT_TTL_MS || 60 * 60 * 1000);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function sign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const fullPayload = Object.assign({ iss: ISSUER, iat: now, exp: now + TTL_MS }, payload);
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(fullPayload));
  const data = headerB64 + '.' + payloadB64;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return data + '.' + b64url(sig);
}

function verify(token, secret) {
  if (!token || typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, error: 'malformed_token' };
  const [headerB64, payloadB64, sigB64] = token.split('.');
  const data = headerB64 + '.' + payloadB64;
  const expected = crypto.createHmac('sha256', secret).update(data).digest();
  let provided;
  try { provided = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch (error) { return { ok: false, error: 'invalid_signature_encoding' }; }
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return { ok: false, error: 'invalid_signature' };
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64)); } catch (error) { return { ok: false, error: 'invalid_payload' }; }
  if (payload.exp && Date.now() > payload.exp) return { ok: false, error: 'expired' };
  if (payload.iss !== ISSUER) return { ok: false, error: 'invalid_issuer' };
  return { ok: true, payload: payload };
}

function issue(payload, secret, ttlMs) {
  const now = Date.now();
  const exp = now + (ttlMs || TTL_MS);
  return sign(Object.assign({ actor: String(payload.actor), role: String(payload.role), scope: Array.isArray(payload.scope) ? payload.scope : [] }, { iss: ISSUER, iat: now, exp: exp }), secret);
}

module.exports = { sign, verify, issue, b64url, b64urlDecode, ISSUER, TTL_MS };
