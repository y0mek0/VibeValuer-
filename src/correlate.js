const db = require('./db');

function correlateRun(runId) {
  if (!runId) throw new Error('runId required');
  db.initDb();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return null;  const evidence = run.evidence_json ? (() => { try { return JSON.parse(run.evidence_json); } catch (e) { return null; } })() : null;
  const audit = db.prepare("SELECT * FROM audit_log WHERE (run_id = ? OR agent_id = ?) AND action LIKE 'run.%' ORDER BY created_at ASC").all(runId, run.agent_id).map(function (row) {
    return { id: row.id, action: row.action, actor: row.actor, level: row.level, createdAt: row.created_at, details: row.details ? JSON.parse(row.details) : null };
  });
  const registry = db.prepare('SELECT * FROM agent_registry WHERE linked_agent_id = ?').get(run.agent_id);
  const fraud = db.prepare('SELECT * FROM fraud_proofs WHERE run_id = ?').get(runId);
  const chain = evidence && evidence.txHash ? { txHash: evidence.txHash, receiptStatus: evidence.receiptStatus, chainId: evidence.chainId, blockHash: evidence.blockHash, verified: !!evidence.verified } : null;
  return {
    runId: run.id,
    agentId: run.agent_id,
    status: run.status,
    verification: run.verification,
    policyViolation: Boolean(run.policy_violation),
    xpAwarded: run.xp_awarded,
    evidence: evidence,
    chain: chain,
    audit: audit,
    registry: registry ? { id: registry.id, linkStatus: registry.link_status, evidenceStatus: registry.evidence_status, evaluated: Boolean(registry.evaluated) } : null,
    fraud: fraud ? { reason: fraud.reason, txHash: fraud.tx_hash, createdAt: fraud.created_at } : null,
    sources: ['database', 'audit_log', 'registry', 'fraud_proofs'].concat(chain ? ['onchain_rpc'] : [])
  };
}

function correlateAgent(agentId) {
  if (!agentId) throw new Error('agentId required');
  db.initDb();
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) return null;
  const runs = db.prepare('SELECT * FROM runs WHERE agent_id = ? ORDER BY created_at DESC').all(agentId);
  const registry = db.prepare('SELECT * FROM agent_registry WHERE linked_agent_id = ? ORDER BY updated_at DESC').all(agentId);
  const audit = db.prepare('SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200').all(agentId);
  const fraud = db.prepare('SELECT * FROM fraud_proofs WHERE agent_id = ? ORDER BY created_at DESC').all(agentId);
  const onchain = runs.filter(function (r) { return r.evidence_json; }).map(function (r) { try { return JSON.parse(r.evidence_json); } catch (e) { return null; } }).filter(function (e) { return e && e.txHash; });
  return {
    agentId: agentId,
    runsCount: runs.length,
    registryCount: registry.length,
    auditCount: audit.length,
    fraudCount: fraud.length,
    onchainEvidenceCount: onchain.length,
    sources: ['database', 'audit_log', 'registry', 'fraud_proofs', 'onchain_rpc']
  };
}

module.exports = { correlateRun, correlateAgent };
