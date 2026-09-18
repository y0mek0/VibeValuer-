const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'valuer.sqlite');
const SEED_PATH = path.join(ROOT, 'data', 'store.json');

let db;

function dbInstance() {
  if (!db) initDb();
  return db;
}

function initDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      manual_actions INTEGER NOT NULL DEFAULT 0,
      delegated_tasks INTEGER NOT NULL DEFAULT 0,
      automated_runs INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      kind TEXT NOT NULL,
      complexity INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      verification TEXT NOT NULL,
      human_interventions INTEGER NOT NULL DEFAULT 0,
      safety_incident INTEGER NOT NULL DEFAULT 0,
      parent_task_id TEXT,
      idempotency_key TEXT UNIQUE,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      policy_violation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_evidence_idx ON runs(json_extract(evidence_json, '$.source'));
    CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT,
      agent_id TEXT,
      registry_id TEXT,
      run_id TEXT,
      details TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_agent_idx ON audit_log(agent_id);
    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered',
      evidence_status TEXT NOT NULL DEFAULT 'unavailable',
      chain_id INTEGER,
      token_id TEXT,
      creator_address TEXT,
      launch_id TEXT,
      symbol TEXT,
      lifecycle TEXT,
      as_of_block INTEGER,
      evaluated INTEGER NOT NULL DEFAULT 0,
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registry_sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      cursor TEXT,
      last_block INTEGER,
      last_imported INTEGER NOT NULL,
      pages_total INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      checked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source)
    );
    CREATE TABLE IF NOT EXISTS fraud_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      run_id TEXT,
      reason TEXT NOT NULL,
      tx_hash TEXT,
      witness TEXT,
      payload TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fraud_proofs_agent_idx ON fraud_proofs(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS appeals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT,
      reason TEXT NOT NULL,
      evidence_url TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      decision TEXT,
      actor TEXT,
      reviewer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appeals_status_idx ON appeals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS appeals_agent_idx ON appeals(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS onboarding_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wallet_address TEXT,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'pending_wallet',
      challenge_nonce TEXT,
      challenge_expires TEXT,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const count = db.prepare('SELECT COUNT(*) AS count FROM agents').get().count;
  if (Number(count) === 0 && fs.existsSync(SEED_PATH)) seedFromJson(JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')));
  syncLocalRegistry();
  try { db.exec('ALTER TABLE agent_registry ADD COLUMN linked_agent_id TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec("ALTER TABLE agent_registry ADD COLUMN link_status TEXT NOT NULL DEFAULT 'unlinked'"); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec('ALTER TABLE agent_registry ADD COLUMN creator_address TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec('ALTER TABLE agent_registry ADD COLUMN launch_id TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec('ALTER TABLE agent_registry ADD COLUMN symbol TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec('ALTER TABLE agent_registry ADD COLUMN lifecycle TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec('ALTER TABLE agent_registry ADD COLUMN as_of_block INTEGER'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  try { db.exec("ALTER TABLE registry_sync_state ADD COLUMN resumed_at TEXT"); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  db.prepare("DELETE FROM agent_registry WHERE source = 'vibe_indexer' AND evaluated = 0 AND launch_id IS NULL").run();
  db.prepare("UPDATE agent_registry SET evidence_status = 'unavailable' WHERE source = 'vibe_indexer' AND evaluated = 0").run();
  return db;
}
function seedFromJson(store) {
  const insertAgent = db.prepare('INSERT OR IGNORE INTO agents (id,name,role,status,manual_actions,delegated_tasks,automated_runs) VALUES (?,?,?,?,?,?,?)');
  const insertRun = db.prepare('INSERT OR IGNORE INTO runs (id,agent_id,kind,complexity,trigger,status,verification,human_interventions,safety_incident,parent_task_id,idempotency_key,xp_awarded,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const agent of store.agents || []) {
      insertAgent.run(agent.id, agent.name, agent.role, agent.status, agent.manualActions || 0, agent.delegatedTasks || 0, agent.automatedRuns || 0);
      for (const run of agent.runs || []) insertRun.run(run.id, agent.id, run.kind, run.complexity, run.trigger, run.status, run.verification, run.humanInterventions || 0, run.safetyIncident ? 1 : 0, run.parentTaskId || null, run.idempotencyKey || null, run.xpAwarded || 0, run.createdAt);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function rowToRun(row) { let evidence=null; try { if(row.evidence_json) evidence=JSON.parse(row.evidence_json); } catch(error) { evidence=null; } return { id: row.id, agentId: row.agent_id, kind: row.kind, complexity: row.complexity, trigger: row.trigger, status: row.status, verification: row.verification, humanInterventions: row.human_interventions, safetyIncident: Boolean(row.safety_incident), parentTaskId: row.parent_task_id, idempotencyKey: row.idempotency_key, xpAwarded: row.xp_awarded, evidence, policyViolation: Boolean(row.policy_violation), createdAt: row.created_at }; }
function rowsToAgents(rows) {
  return rows.map(row => ({ id: row.id, name: row.name, role: row.role, status: row.status, manualActions: row.manual_actions, delegatedTasks: row.delegated_tasks, automatedRuns: row.automated_runs, runs: db.prepare('SELECT * FROM runs WHERE agent_id = ? ORDER BY created_at DESC').all(row.id).map(rowToRun) }));
}
function listAgents() { initDb(); return rowsToAgents(db.prepare('SELECT * FROM agents ORDER BY id').all()); }
function getAgent(id) { return listAgents().find(agent => agent.id === id) || null; }
function findRunByIdempotency(key) { if (!key) return null; initDb(); const row = db.prepare('SELECT * FROM runs WHERE idempotency_key = ?').get(key); return row ? rowToRun(row) : null; }
function insertRun(agent, run) {
  initDb();
  const evidenceJson = run.evidence ? JSON.stringify(run.evidence) : null;
  const policyViolation = run.policyViolation ? 1 : 0;
  const stmt = db.prepare('INSERT INTO runs (id,agent_id,kind,complexity,trigger,status,verification,human_interventions,safety_incident,parent_task_id,idempotency_key,xp_awarded,evidence_json,policy_violation,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  stmt.run(run.id, agent.id, run.kind, run.complexity, run.trigger, run.status, run.verification, run.humanInterventions, run.safetyIncident ? 1 : 0, run.parentTaskId, run.idempotencyKey, run.xpAwarded, evidenceJson, policyViolation, run.createdAt);
  if (run.status === 'completed' && run.verification === 'verified' && !run.safetyIncident && !run.policyViolation && run.evidence && run.evidence.source === 'onchain_tx' && run.evidence.receiptStatus === 'success') db.prepare("UPDATE agent_registry SET evaluated = 1, evidence_status = 'runtime_verified', link_status = 'evaluated', updated_at = ? WHERE linked_agent_id = ?").run(new Date().toISOString(), agent.id);
  return getAgent(agent.id);
}
function summary() { initDb(); return { agentCount: Number(db.prepare('SELECT COUNT(*) AS count FROM agents').get().count), runCount: Number(db.prepare('SELECT COUNT(*) AS count FROM runs').get().count) }; }
function evidenceBreakdown() { initDb(); return db.prepare("SELECT COALESCE(json_extract(evidence_json, '$.source'), 'none') AS source, COUNT(*) AS count FROM runs GROUP BY source ORDER BY count DESC").all(); }
function recordAudit(entry) { initDb(); const now = new Date().toISOString(); db.prepare('INSERT INTO audit_log (action, actor, agent_id, registry_id, run_id, details, level, created_at) VALUES (?,?,?,?,?,?,?,?)').run(String(entry.action).slice(0,80), entry.actor ? String(entry.actor).slice(0,80) : null, entry.agentId ? String(entry.agentId).slice(0,160) : null, entry.registryId ? String(entry.registryId).slice(0,160) : null, entry.runId ? String(entry.runId).slice(0,160) : null, entry.details ? JSON.stringify(entry.details).slice(0,1000) : null, entry.level || 'info', now); return now; }
function auditLog({ limit = 50, action, agentId } = {}) { initDb(); let sql = 'SELECT * FROM audit_log'; const where = []; const params = {}; if (action) { where.push('action = @action'); params.action = String(action); } if (agentId) { where.push('agent_id = @agentId'); params.agentId = String(agentId); } if (where.length) sql += ' WHERE ' + where.join(' AND '); sql += ' ORDER BY created_at DESC LIMIT @limit'; params.limit = Math.min(Math.max(Number(limit) || 50, 1), 200); return db.prepare(sql).all(params).map(row => ({ id: row.id, action: row.action, actor: row.actor, agentId: row.agent_id, registryId: row.registry_id, runId: row.run_id, details: row.details ? JSON.parse(row.details) : null, level: row.level, createdAt: row.created_at })); }
function registryRow(row) { return { id: row.id, name: row.name, role: row.role, source: row.source, status: row.status, evidenceStatus: row.evidence_status, chainId: row.chain_id, tokenId: row.token_id, creatorAddress: row.creator_address || null, launchId: row.launch_id || null, symbol: row.symbol || null, lifecycle: row.lifecycle || null, asOfBlock: row.as_of_block || null, evaluated: Boolean(row.evaluated), linkedAgentId: row.linked_agent_id || null, linkStatus: row.link_status || 'unlinked', discoveredAt: row.discovered_at, updatedAt: row.updated_at }; }
function syncLocalRegistry() { const now = new Date().toISOString(); const stmt = db.prepare(`INSERT INTO agent_registry (id,name,role,source,status,evidence_status,evaluated,discovered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,evaluated=1,updated_at=excluded.updated_at`); for (const agent of db.prepare('SELECT id,name,role,status FROM agents').all()) stmt.run(agent.id, agent.name, agent.role, 'local_ledger', agent.status, 'verified', 1, now, now); }
function registry() { initDb(); const rows = db.prepare('SELECT * FROM agent_registry ORDER BY evaluated DESC, updated_at DESC').all(); return { agents: rows.map(registryRow), counts: { discovered: rows.length, evaluated: rows.filter(row => Boolean(row.evaluated)).length, unavailable: rows.filter(row => row.evidence_status === 'unavailable').length } }; }
function importRegistry(items, source = 'external_import') { initDb(); if (!Array.isArray(items)) throw new Error('agents must be an array'); const now = new Date().toISOString(); const stmt = db.prepare(`INSERT INTO agent_registry (id,name,role,source,status,evidence_status,chain_id,token_id,creator_address,launch_id,symbol,lifecycle,as_of_block,evaluated,discovered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,source=excluded.source,status=excluded.status,evidence_status=excluded.evidence_status,chain_id=excluded.chain_id,token_id=excluded.token_id,creator_address=excluded.creator_address,launch_id=excluded.launch_id,symbol=excluded.symbol,lifecycle=excluded.lifecycle,as_of_block=excluded.as_of_block,updated_at=excluded.updated_at`); let imported = 0; for (const item of items) { if (!item || !/^[a-z0-9][a-z0-9:_-]{1,127}$/i.test(String(item.id || ''))) continue; stmt.run(String(item.id), String(item.name || item.id).slice(0,160), String(item.role || '').slice(0,160), String(item.source || source).slice(0,80), String(item.status || 'discovered').slice(0,40), String(item.evidenceStatus || 'unavailable').slice(0,40), Number.isInteger(item.chainId) ? item.chainId : null, item.tokenId ? String(item.tokenId).slice(0,160) : null, item.creatorAddress ? String(item.creatorAddress).slice(0,160) : null, item.launchId ? String(item.launchId).slice(0,160) : null, item.symbol ? String(item.symbol).slice(0,40) : null, item.lifecycle ? String(item.lifecycle).slice(0,40) : null, Number.isInteger(item.asOfBlock) ? item.asOfBlock : null, item.evaluated === true ? 1 : 0, item.discoveredAt || now, now); imported++; } return { imported, ...registry() }; }
function creatorsRegistry() { initDb(); const rows = db.prepare("SELECT creator_address, COUNT(*) AS launches, MIN(discovered_at) AS firstSeen, MAX(updated_at) AS lastSeen, MIN(as_of_block) AS firstBlock, MAX(as_of_block) AS lastBlock FROM agent_registry WHERE source = 'vibe_indexer' AND creator_address IS NOT NULL GROUP BY creator_address ORDER BY lastSeen DESC").all(); return { creators: rows.map(row => ({ creatorAddress: row.creator_address, launches: row.launches, firstSeen: row.firstSeen, lastSeen: row.lastSeen, firstBlock: row.firstBlock, lastBlock: row.lastBlock })), count: rows.length }; }
function syncState(source) { initDb(); return db.prepare('SELECT * FROM registry_sync_state WHERE source = ?').get(source) || null; }
function upsertSyncState({ source, cursor, lastBlock, lastImported, pagesTotal, status, lastError, resumedAt }) { initDb(); const now = new Date().toISOString(); db.prepare(`INSERT INTO registry_sync_state (source, cursor, last_block, last_imported, pages_total, status, last_error, checked_at, updated_at, resumed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, last_block=excluded.last_block, last_imported=excluded.last_imported, pages_total=excluded.pages_total, status=excluded.status, last_error=excluded.last_error, checked_at=excluded.checked_at, updated_at=excluded.updated_at, resumed_at=COALESCE(excluded.resumed_at, registry_sync_state.resumed_at)`).run(source, cursor || null, Number.isInteger(lastBlock) ? lastBlock : null, lastImported || 0, pagesTotal || 0, status || 'idle', lastError || null, now, now, resumedAt || null); return syncState(source); }
function appendSyncPage({ source, cursor, lastImported, pagesTotal, status }) { initDb(); const now = new Date().toISOString(); db.prepare(`UPDATE registry_sync_state SET cursor=?, last_imported=?, pages_total=?, status=?, updated_at=?, resumed_at=CASE WHEN cursor IS NULL OR cursor = ? THEN resumed_at ELSE ? END WHERE source=?`).run(cursor || null, lastImported || 0, pagesTotal || 0, status || 'in_progress', now, cursor || '', now, source); return syncState(source); }
function lastLaunchBlock() { initDb(); return db.prepare('SELECT MAX(as_of_block) AS block FROM agent_registry WHERE source = ? AND as_of_block IS NOT NULL').get('vibe_indexer')?.block || null; }
function linkRegistry(registryId, agentId, linkStatus = 'linked_unverified') { initDb(); if (!getAgent(agentId)) throw new Error('Agent not found'); const allowed = new Set(['linked_unverified', 'linked_verified', 'evaluated']); if (!allowed.has(linkStatus)) throw new Error('invalid linkStatus'); const now = new Date().toISOString(); const result = db.prepare('UPDATE agent_registry SET linked_agent_id = ?, link_status = ?, updated_at = ? WHERE id = ?').run(agentId, linkStatus, now, registryId); if (result.changes === 0) throw new Error('Registry record not found'); return registry(); }
const SOURCE_PRIORITY = { onchain_tx: 5, runtime_agent: 4, api_webhook: 3, user_recorded: 2, runtime_event: 1, unknown: 0 };
function evidenceRank(source) { return SOURCE_PRIORITY[source] !== undefined ? SOURCE_PRIORITY[source] : 0; }
function recomputeAgentEvaluation(agentId) { initDb(); const rows = db.prepare("SELECT evidence_json, status, verification, policy_violation FROM runs WHERE agent_id = ?").all(agentId); let bestSource = null; let bestRank = -1; let bestReceipt = null; for (const row of rows) { let ev = null; try { if (row.evidence_json) ev = JSON.parse(row.evidence_json); } catch (e) { ev = null; } if (!ev) continue; if (row.status !== 'completed') continue; if (row.verification !== 'verified') continue; if (row.policy_violation) continue; const rank = evidenceRank(ev.source); if (rank > bestRank) { bestRank = rank; bestSource = ev.source; bestReceipt = ev.receiptStatus || null; } } const now = new Date().toISOString(); if (bestSource && bestRank >= 4 && bestReceipt === 'success') { db.prepare("UPDATE agent_registry SET evaluated = 1, evidence_status = 'runtime_verified', link_status = 'evaluated', updated_at = ? WHERE linked_agent_id = ?").run(now, agentId); return { evaluated: true, source: bestSource, receiptStatus: bestReceipt }; } db.prepare("UPDATE agent_registry SET evidence_status = CASE WHEN evaluated = 1 THEN evidence_status ELSE 'unavailable' END, link_status = CASE WHEN link_status = 'evaluated' THEN 'linked_verified' ELSE link_status END WHERE linked_agent_id = ?").run(agentId); return { evaluated: false, source: bestSource, receiptStatus: bestReceipt }; }
function publicAgents({ limit = 100, sortBy = 'xp' } = {}) { initDb(); const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200); const items = rowsToAgents(db.prepare('SELECT * FROM agents').all()).map(agent => { const metrics = require('./scoring').getMetrics(agent); const level = require('./scoring').getLevel(metrics); return { id: agent.id, name: agent.name, role: agent.role, level: level.level, xp: metrics.xp, successRate: metrics.successRate, autonomyRate: metrics.autonomyRate, evidenceRate: metrics.evidenceRate, verifiedRuns: metrics.verified }; }); if (sortBy === 'autonomy') items.sort((a, b) => b.autonomyRate - a.autonomyRate); else if (sortBy === 'evidence') items.sort((a, b) => b.evidenceRate - a.evidenceRate); else items.sort((a, b) => b.xp - a.xp); return { agents: items.slice(0, safeLimit), sortBy, generatedAt: new Date().toISOString() }; }
function exportSnapshot() { initDb(); const allRuns = db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all().map(rowToRun); const registryRows = db.prepare('SELECT * FROM agent_registry ORDER BY evaluated DESC, updated_at DESC').all().map(registryRow); const audit = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 1000').all().map(function (row) { return { id: row.id, action: row.action, actor: row.actor, agentId: row.agent_id, registryId: row.registry_id, runId: row.run_id, details: row.details ? JSON.parse(row.details) : null, level: row.level, createdAt: row.created_at }; }); const evidence = evidenceBreakdown(); return { generatedAt: new Date().toISOString(), agents: listAgents(), registry: registryRows, runs: allRuns, audit: audit, evidenceBreakdown: evidence }; }
function decayAgentReputation({ thresholdDays = 30, decayPercent = 5, minDecay = 1 } = {}) { initDb(); const now = new Date(); const threshold = new Date(now.getTime() - thresholdDays * 86400000).toISOString(); const agents = db.prepare('SELECT * FROM agents').all(); let totalDecay = 0; const events = []; for (const agent of agents) { const last = db.prepare('SELECT created_at FROM runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.id); if (!last || last.created_at > threshold) continue; const runs = db.prepare('SELECT xp_awarded FROM runs WHERE agent_id = ?').all(agent.id); const totalXp = runs.reduce((s, r) => s + (r.xp_awarded || 0), 0); if (totalXp <= 0) continue; const decay = Math.max(minDecay, Math.floor(totalXp * decayPercent / 100)); db.prepare('UPDATE runs SET xp_awarded = MAX(0, xp_awarded - ?) WHERE agent_id = ? AND id IN (SELECT id FROM runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3)').run(decay, agent.id, agent.id); events.push({ agentId: agent.id, decay }); totalDecay += decay; db.recordAudit({ action: 'reputation.decay', actor: 'system', agentId: agent.id, details: { decay, thresholdDays, decayPercent } }); } return { totalDecay, events, executedAt: new Date().toISOString() }; }
function cleanupStaleRegistry({ staleDays = 30 } = {}) { initDb(); const threshold = new Date(Date.now() - staleDays * 86400000).toISOString(); const result = db.prepare("UPDATE agent_registry SET evidence_status = 'stale', updated_at = ? WHERE source = 'vibe_indexer' AND evaluated = 0 AND updated_at < ? AND evidence_status != 'stale'").run(new Date().toISOString(), threshold); return { updated: result.changes, threshold, executedAt: new Date().toISOString() }; }
function slashAgentXp({ agentId, reason, percent = 100 } = {}) { initDb(); const safePercent = Math.min(Math.max(Number(percent) || 0, 0), 100); const now = new Date().toISOString(); const runs = db.prepare('SELECT id, xp_awarded FROM runs WHERE agent_id = ? AND xp_awarded > 0').all(agentId); let totalSlashed = 0; for (const run of runs) { const reduction = Math.ceil(run.xp_awarded * safePercent / 100); if (reduction > 0) { db.prepare('UPDATE runs SET xp_awarded = xp_awarded - ? WHERE id = ?').run(reduction, run.id); totalSlashed += reduction; } } db.prepare("UPDATE agent_registry SET evaluated = 0, evidence_status = 'slashed', link_status = CASE WHEN link_status = 'evaluated' THEN 'linked_verified' ELSE link_status END, updated_at = ? WHERE linked_agent_id = ?").run(now, agentId); return { slashedXp: totalSlashed, runsAffected: runs.length, percent: safePercent, reason: reason || 'unspecified' }; }
function recordFraudProof(proof) { initDb(); const now = new Date().toISOString(); db.prepare('INSERT INTO fraud_proofs (agent_id, run_id, reason, tx_hash, witness, payload, actor, created_at) VALUES (?,?,?,?,?,?,?,?)').run(String(proof.agentId).slice(0,160), proof.runId ? String(proof.runId).slice(0,160) : null, String(proof.reason).slice(0,80), proof.txHash ? String(proof.txHash).slice(0,160) : null, proof.witness ? String(proof.witness).slice(0,160) : null, proof.payload ? JSON.stringify(proof.payload).slice(0,2000) : null, proof.actor ? String(proof.actor).slice(0,80) : 'system', now); return now; }
function fraudProofs({ agentId, limit = 50 } = {}) { initDb(); let sql = 'SELECT * FROM fraud_proofs'; const params = {}; if (agentId) { sql += ' WHERE agent_id = @agentId'; params.agentId = agentId; } sql += ' ORDER BY created_at DESC LIMIT @limit'; params.limit = Math.min(Math.max(Number(limit) || 50, 1), 200); return db.prepare(sql).all(params).map(function (row) { return { id: row.id, agentId: row.agent_id, runId: row.run_id, reason: row.reason, txHash: row.tx_hash, witness: row.witness, payload: row.payload ? JSON.parse(row.payload) : null, actor: row.actor, createdAt: row.created_at }; }); }
function createAppeal({ agentId, runId, reason, evidenceUrl, actor } = {}) { initDb(); if (!agentId || !reason) throw new Error('agentId and reason required'); const now = new Date().toISOString(); const id = 'appeal-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8); db.prepare('INSERT INTO appeals (id,agent_id,run_id,reason,evidence_url,status,actor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, String(agentId).slice(0,160), runId ? String(runId).slice(0,160) : null, String(reason).slice(0,1000), evidenceUrl ? String(evidenceUrl).slice(0,500) : null, 'open', actor ? String(actor).slice(0,80) : 'api', now, now); recordAudit({ action: 'appeal.created', actor: actor || 'api', agentId, runId, details: { appealId: id, reason: String(reason).slice(0,160) } }); return getAppeal(id); }
function getAppeal(id) { initDb(); const row = db.prepare('SELECT * FROM appeals WHERE id = ?').get(id); return row ? appealRow(row) : null; }
function appealRow(row) { return { id: row.id, agentId: row.agent_id, runId: row.run_id, reason: row.reason, evidenceUrl: row.evidence_url, status: row.status, decision: row.decision, actor: row.actor, reviewer: row.reviewer, createdAt: row.created_at, updatedAt: row.updated_at }; }
function listAppeals({ status, agentId, limit = 100 } = {}) { initDb(); let sql = 'SELECT * FROM appeals'; const where = []; const params = {}; if (status) { where.push('status = @status'); params.status = String(status); } if (agentId) { where.push('agent_id = @agentId'); params.agentId = String(agentId); } if (where.length) sql += ' WHERE ' + where.join(' AND '); sql += ' ORDER BY created_at DESC LIMIT @limit'; params.limit = Math.min(Math.max(Number(limit) || 100, 1), 200); return db.prepare(sql).all(params).map(appealRow); }
function decideAppeal({ appealId, status, decision, reviewer } = {}) { initDb(); const allowed = new Set(['approved','rejected','needs_more_evidence','closed']); if (!appealId || !allowed.has(status)) throw new Error('valid appealId and status required'); const now = new Date().toISOString(); const result = db.prepare('UPDATE appeals SET status=?, decision=?, reviewer=?, updated_at=? WHERE id=?').run(status, decision ? String(decision).slice(0,1000) : null, reviewer ? String(reviewer).slice(0,80) : 'admin', now, appealId); if (result.changes === 0) throw new Error('appeal not found'); const appeal = getAppeal(appealId); recordAudit({ action: 'appeal.decided', actor: reviewer || 'admin', agentId: appeal.agentId, runId: appeal.runId, details: { appealId, status, decision } }); return appeal; }
function onboardingRow(row) { return { id: row.id, name: row.name, walletAddress: row.wallet_address || null, email: row.email || null, status: row.status, challengeNonce: row.challenge_nonce || null, challengeExpires: row.challenge_expires || null, registeredAt: row.registered_at, updatedAt: row.updated_at }; }
function createOnboardingAgent({ name, email }) {
  initDb();
  if (!name || name.trim().length < 2) throw new Error('name required (min 2 chars)');
  const id = 'agent-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO onboarding_agents (id,name,email,status,registered_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, name.trim().slice(0, 80), email ? String(email).slice(0, 160) : null, 'pending_wallet', now, now);
  return getOnboardingAgent(id);
}
function getOnboardingAgent(id) { initDb(); const row = db.prepare('SELECT * FROM onboarding_agents WHERE id = ?').get(id); return row ? onboardingRow(row) : null; }
function setOnboardingWallet({ id, walletAddress, challengeNonce, challengeExpires }) {
  initDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE onboarding_agents SET wallet_address=?, challenge_nonce=?, challenge_expires=?, status=?, updated_at=? WHERE id=?').run(walletAddress ? String(walletAddress).slice(0, 160) : null, challengeNonce || null, challengeExpires || null, 'pending_verification', now, id);
  return getOnboardingAgent(id);
}
function confirmOnboardingWallet({ id, signature, recoveredAddress }) {
  initDb();
  const agent = getOnboardingAgent(id);
  if (!agent) throw new Error('onboarding agent not found');
  if (agent.status !== 'pending_verification') throw new Error('agent is not pending verification');
  if (!agent.challengeExpires || new Date(agent.challengeExpires) < new Date()) throw new Error('challenge expired — please restart onboarding');
  const now = new Date().toISOString();
  const info = db.prepare('UPDATE onboarding_agents SET status=?, challenge_nonce=NULL, updated_at=? WHERE id=? AND challenge_nonce IS NOT NULL').run('wallet_verified', now, id);
  if (info.changes === 0) throw new Error('challenge already used');
  return getOnboardingAgent(id);
}
function finalizeOnboarding({ onboardingId, agentId }) {
  initDb();
  const agent = getOnboardingAgent(onboardingId);
  if (!agent) throw new Error('onboarding agent not found');
  if (agent.status !== 'wallet_verified') throw new Error('wallet not verified yet');
  // Auto-create the agent if it doesn't exist yet
  let realAgent = getAgent(agentId);
  if (!realAgent) {
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO agents (id, name, role, status, manual_actions, delegated_tasks, automated_runs) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agentId, agent.name || agentId, 'agent', 'active', 0, 0, 0);
    realAgent = getAgent(agentId);
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE onboarding_agents SET status=?, updated_at=? WHERE id=?').run('completed', now, onboardingId);
  recordAudit({ action: 'onboarding.completed', actor: 'onboarding', agentId, details: { onboardingId, walletAddress: agent.walletAddress } });
  return { onboarding: getOnboardingAgent(onboardingId), agent: realAgent };
}
function listOnboardingAgents({ status } = {}) {
  initDb();
  let sql = 'SELECT * FROM onboarding_agents';
  const params = {};
  if (status) { sql += ' WHERE status = @status'; params.status = status; }
  sql += ' ORDER BY registered_at DESC';
  return db.prepare(sql).all(params).map(onboardingRow);
}
module.exports = { DB_PATH, initDb, listAgents, getAgent, findRunByIdempotency, insertRun, summary, registry, importRegistry, linkRegistry, creatorsRegistry, syncState, upsertSyncState, appendSyncPage, lastLaunchBlock, evidenceBreakdown, recordAudit, auditLog, recomputeAgentEvaluation, publicAgents, exportSnapshot, decayAgentReputation, cleanupStaleRegistry, slashAgentXp, recordFraudProof, fraudProofs, createAppeal, getAppeal, listAppeals, decideAppeal, createOnboardingAgent, getOnboardingAgent, setOnboardingWallet, confirmOnboardingWallet, finalizeOnboarding, listOnboardingAgents, SOURCE_PRIORITY, prepare: function (sql) { initDb(); return dbInstance().prepare(sql); }, getDb: function () { initDb(); return dbInstance(); } };
