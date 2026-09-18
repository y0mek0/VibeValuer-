const db = require('./db');

const FRAUD_REASONS = new Set(['fake_onchain_receipt', 'duplicate_evidence', 'sybil_run_pattern', 'identity_replay', 'withdrawn_proof', 'admin_override']);

function recordFraudProof(proof) {
  if (!proof || !proof.agentId) throw new Error('agentId required');
  if (!FRAUD_REASONS.has(proof.reason)) throw new Error('invalid reason');
  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify({ reason: proof.reason, txHash: proof.txHash || null, witness: proof.witness || null, payload: proof.payload || null, submittedAt: now });
  db.recordAudit({ action: 'fraud.proof.recorded', actor: proof.actor || 'system', agentId: proof.agentId, runId: proof.runId || null, details: { reason: proof.reason, txHash: proof.txHash || null }, level: 'warning' });
  return { ok: true, recordedAt: now, evidence: evidenceJson };
}

function slashAgent(proof) {
  if (!proof || !proof.agentId) throw new Error('agentId required');
  if (!FRAUD_REASONS.has(proof.reason)) throw new Error('invalid reason');
  const result = recordFraudProof(proof);
  const slashed = db.slashAgentXp({ agentId: proof.agentId, reason: proof.reason, percent: proof.percent || 100 });
  return Object.assign({ reason: proof.reason, recordedAt: result.recordedAt }, slashed);
}

module.exports = { recordFraudProof, slashAgent, FRAUD_REASONS };
