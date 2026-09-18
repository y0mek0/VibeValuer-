const crypto = require('node:crypto');
const { verifyMessage } = require('ethers');

const NONCE_TTL_MS = 10 * 60 * 1000;
const nonces = new Map();

function buildChallengeMessage({ registryId, agentId, nonce, issuedAt }) {
  return [
    'Vibe Agents Valuer / Registry Link Challenge',
    `registry:${registryId}`,
    `agent:${agentId}`,
    `nonce:${nonce}`,
    `issuedAt:${issuedAt}`
  ].join('\n');
}

function createChallenge({ registryId, agentId }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const message = buildChallengeMessage({ registryId, agentId, nonce, issuedAt });
  nonces.set(nonce, { registryId, agentId, issuedAt, message });
  return { nonce, issuedAt, message };
}

function consumeChallenge(nonce) {
  const record = nonces.get(nonce);
  if (!record) return null;
  nonces.delete(nonce);
  const age = Date.now() - new Date(record.issuedAt).getTime();
  if (age > NONCE_TTL_MS) return null;
  return record;
}

async function verifyWalletSignature({ registryId, agentId, nonce, signature, expectedAddress }) {
  const record = consumeChallenge(nonce);
  if (!record) return { ok: false, error: 'invalid_or_expired_nonce' };
  if (record.registryId !== registryId) return { ok: false, error: 'registry_mismatch' };
  if (record.agentId !== agentId) return { ok: false, error: 'agent_mismatch' };
  if (!signature || typeof signature !== 'string') return { ok: false, error: 'missing_signature' };
  let recovered;
  try {
    recovered = await verifyMessage(record.message, signature);
  } catch (error) {
    return { ok: false, error: 'signature_invalid:' + error.message };
  }
  if (!recovered) return { ok: false, error: 'no_recovered_address' };
  if (expectedAddress && recovered.toLowerCase() !== expectedAddress.toLowerCase()) return { ok: false, error: 'address_mismatch' };
  return { ok: true, recoveredAddress: recovered, message: record.message };
}

module.exports = { createChallenge, verifyWalletSignature, buildChallengeMessage, NONCE_TTL_MS };
