const ALLOWED = {
  kind: new Set(['manual','simple','verified','automated','multiStep','recovery','delegated','critical']),
  trigger: new Set(['user','schedule','event','agent']),
  status: new Set(['completed','partial','failed','blocked','waiting_approval','simulated','reverted']),
  verification: new Set(['verified','user_confirmed','unverified','simulated'])
};

const POLICY_VIOLATION_STATUSES = new Set(['failed','blocked','reverted']);
const VALID_EVIDENCE_SOURCES = new Set(['runtime_event','api_webhook','user_recorded','onchain_tx','runtime_agent','unknown']);
const VALID_EVIDENCE_OPERATIONS = new Set(['simulation','real_operation','onboarding_first_run','unknown']);
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const MAX_RUN_PAYLOAD = 8 * 1024;

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim().slice(0, 160);
}

function validateRunInput(body, headerKey) {
  const input = body && typeof body === 'object' ? body : {};
  const errors = [];
  const agentId = cleanText(input.agentId);
  if (!agentId || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(agentId)) errors.push('agentId is required');
  const kind = cleanText(input.kind, 'simple');
  const trigger = cleanText(input.trigger, 'user');
  const status = cleanText(input.status, 'completed');
  const verification = cleanText(input.verification, 'verified');
  if (!ALLOWED.kind.has(kind)) errors.push('invalid kind');
  if (!ALLOWED.trigger.has(trigger)) errors.push('invalid trigger');
  if (!ALLOWED.status.has(status)) errors.push('invalid status');
  if (!ALLOWED.verification.has(verification)) errors.push('invalid verification');
  const complexity = Number(input.complexity);
  if (!Number.isInteger(complexity) || complexity < 1 || complexity > 10) errors.push('complexity must be an integer from 1 to 10');
  const humanInterventions = Number(input.humanInterventions ?? 0);
  if (!Number.isInteger(humanInterventions) || humanInterventions < 0 || humanInterventions > 1000) errors.push('humanInterventions must be a non-negative integer');
  const idempotencyKey = cleanText(input.idempotencyKey || headerKey);
  if (idempotencyKey && !/^[a-zA-Z0-9._:-]{4,120}$/.test(idempotencyKey)) errors.push('invalid idempotency key');
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : null;
  let evidencePayload = null;
  if (evidence) {
    const source = cleanText(evidence.source, 'unknown');
    const operation = cleanText(evidence.operation, 'unknown');
    const sourceEventId = cleanText(evidence.sourceEventId);
    const verificationMethod = cleanText(evidence.verificationMethod);
    const chainId = Number(evidence.chainId);
    const blockNumber = evidence.blockNumber != null ? Number(evidence.blockNumber) : 0;
    if (!Number.isInteger(blockNumber) || blockNumber < 0) errors.push('evidence.blockNumber must be a non-negative integer');
    const receiptStatus = cleanText(evidence.receiptStatus);
    const txHash = cleanText(evidence.txHash);
    if (!VALID_EVIDENCE_SOURCES.has(source)) errors.push('invalid evidence.source');
    if (!VALID_EVIDENCE_OPERATIONS.has(operation)) errors.push('invalid evidence.operation');
    if (!Number.isInteger(chainId) || chainId < 1) errors.push('evidence.chainId must be a positive integer');
    if (txHash && !TX_HASH.test(txHash)) errors.push('evidence.txHash must be a 32-byte hex hash');
    if (source === 'onchain_tx' && !txHash) errors.push('evidence.txHash is required for onchain_tx source');
    if (source === 'onchain_tx' && !receiptStatus) errors.push('evidence.receiptStatus is required for onchain_tx source');
    const expectedFrom = cleanText(evidence.expectedFrom || evidence.from);
    const expectedTo = cleanText(evidence.expectedTo || evidence.to);
    evidencePayload = { source, operation, sourceEventId: sourceEventId || null, verificationMethod: verificationMethod || null, chainId, blockNumber, receiptStatus: receiptStatus || null, txHash: txHash || null, expectedFrom: expectedFrom || null, expectedTo: expectedTo || null, approval: evidence.approval === true, limits: cleanText(evidence.limits) || null, collectedAt: cleanText(evidence.collectedAt) || null };
  }
  const payloadSize = Buffer.byteLength(JSON.stringify(input || {}), 'utf8');
  if (payloadSize > MAX_RUN_PAYLOAD) errors.push('payload too large');
  const evidenceReviewed = input.evidenceReviewed === true;
  return { errors, value: { agentId, kind, trigger, status, verification, complexity, humanInterventions, safetyIncident: input.safetyIncident === true, parentTaskId: cleanText(input.parentTaskId) || null, idempotencyKey: idempotencyKey || null, evidence: evidencePayload, evidenceReviewed, policyViolation: POLICY_VIOLATION_STATUSES.has(status) || verification === 'simulated' || status === 'simulated' } };
}

module.exports = { validateRunInput };
