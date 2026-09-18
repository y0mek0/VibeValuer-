const db = require('./db');
const { hub } = require('./events');

function scanDuplicates() {
  db.initDb();
  const rows = db.prepare("SELECT id, agent_id, evidence_json FROM runs WHERE evidence_json LIKE '%\"txHash\"%'").all();
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    let ev = null;
    try { ev = JSON.parse(row.evidence_json); } catch (e) { continue; }
    if (!ev || !ev.txHash) continue;
    const key = (ev.source || 'unknown') + '|' + ev.txHash.toLowerCase();
    if (seen.has(key)) {
      duplicates.push({ firstRunId: seen.get(key), duplicateRunId: row.id, agentId: row.agent_id, source: ev.source, txHash: ev.txHash });
    } else {
      seen.set(key, row.id);
    }
  }
  return duplicates;
}

function scanSybilPatterns({ threshold = 2 } = {}) {
  db.initDb();
  const rows = db.prepare("SELECT agent_id, evidence_json, created_at FROM runs WHERE evidence_json LIKE '%\"txHash\"%' ORDER BY created_at DESC").all();
  const byCreator = new Map();
  for (const row of rows) {
    let ev = null;
    try { ev = JSON.parse(row.evidence_json); } catch (e) { continue; }
    if (!ev || !ev.txHash) continue;
    const fromAddress = (ev.expectedFrom || ev.from || ev.receiptFrom || '').toLowerCase();
    if (!fromAddress) continue;
    if (!byCreator.has(fromAddress)) byCreator.set(fromAddress, new Set());
    byCreator.get(fromAddress).add(row.agent_id);
  }
  const flagged = [];
  for (const [creator, agents] of byCreator.entries()) {
    if (agents.size >= threshold) {
      flagged.push({ fromAddress: creator, agentCount: agents.size, agents: Array.from(agents) });
    }
  }
  return flagged;
}

function scanStaleRuns({ thresholdMs = 24 * 3600 * 1000 } = {}) {
  db.initDb();
  const threshold = new Date(Date.now() - thresholdMs).toISOString();
  const rows = db.prepare("SELECT id, agent_id, status, verification, created_at FROM runs WHERE status = 'completed' AND verification = 'verified' AND created_at < ?").all(threshold);
  return rows;
}

function runWatchtower() {
  const startedAt = new Date().toISOString();
  const duplicates = scanDuplicates();
  const sybil = scanSybilPatterns();
  const stale = scanStaleRuns();
  for (const dup of duplicates) {
    db.recordAudit({ action: 'fraud.duplicate_evidence', actor: 'watchtower', runId: dup.duplicateRunId, details: dup, level: 'warning' });
    hub.emit('fraud.proof.recorded', { reason: 'duplicate_evidence', runId: dup.duplicateRunId, agentId: dup.agentId });
  }
  for (const flag of sybil) {
    db.recordAudit({ action: 'fraud.sybil_pattern', actor: 'watchtower', details: flag, level: 'warning' });
    hub.emit('fraud.proof.recorded', { reason: 'sybil_run_pattern', flag: flag });
  }
  for (const run of stale) {
    db.recordAudit({ action: 'fraud.stale_run', actor: 'watchtower', runId: run.id, details: { createdAt: run.created_at }, level: 'info' });
  }
  return { startedAt, finishedAt: new Date().toISOString(), duplicatesFound: duplicates.length, sybilPatterns: sybil.length, staleRuns: stale.length };
}

module.exports = { scanDuplicates, scanSybilPatterns, scanStaleRuns, runWatchtower };
