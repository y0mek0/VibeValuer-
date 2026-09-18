#!/usr/bin/env node
/**
 * archive-old-runs.mjs
 *
 * Move runs older than N days to `data/archive/runs-YYYY-MM-DD.sqlite`
 * to keep the live DB small. Audit log stays in place.
 *
 * Usage:
 *   node scripts/archive-old-runs.mjs --days=90
 *   node scripts/archive-old-runs.mjs --days=90 --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = { days: 90, dry: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--days=')) out.days = Number(a.slice('--days='.length));
    else if (a === '--dry-run') out.dry = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/archive-old-runs.mjs [--days=90] [--dry-run]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = path.join(__dirname, '..');
  const dbPath = path.join(projectRoot, 'data', 'valuer.sqlite');
  const archiveDir = path.join(projectRoot, 'data', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  const cutoff = new Date(Date.now() - args.days * 86400 * 1000).toISOString();
  const rows = db.prepare("SELECT id FROM runs WHERE created_at < ?").all(cutoff);
  console.log(`Found ${rows.length} runs older than ${args.days} days (cutoff: ${cutoff})`);
  if (args.dry || rows.length === 0) {
    console.log(args.dry ? 'dry-run, exiting' : 'nothing to archive, exiting');
    db.close();
    return;
  }
  // Attach a separate archive DB and copy rows + their evidence_json + idempotency key.
  // (We don't insert into the live DB.)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archPath = path.join(archiveDir, `runs-${ts}.sqlite`);
  const arch = new Database(archPath);
  arch.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, complexity INTEGER, trigger TEXT,
    status TEXT, verification TEXT, human_interventions INTEGER, safety_incident INTEGER,
    parent_task_id TEXT, idempotency_key TEXT, xp_awarded INTEGER, evidence_json TEXT,
    policy_violation INTEGER, created_at TEXT
  )`);
  const insert = arch.prepare(`INSERT INTO runs
    (id, agent_id, kind, complexity, trigger, status, verification, human_interventions,
     safety_incident, parent_task_id, idempotency_key, xp_awarded, evidence_json,
     policy_violation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Use a write transaction on the source so we read consistently.
  const tx = db.prepare(`SELECT * FROM runs WHERE created_at < ?`);
  let written = 0;
  const tx2 = db.transaction((rs) => {
    for (const r of rs) {
      insert.run(
        r.id, r.agent_id, r.kind, r.complexity, r.trigger, r.status, r.verification,
        r.human_interventions, r.safety_incident, r.parent_task_id, r.idempotency_key,
        r.xp_awarded, r.evidence_json, r.policy_violation, r.created_at
      );
      written++;
    }
  });
  tx2(tx.all(cutoff));
  arch.close();
  db.close();
  console.log(`✅ archived ${written} runs → ${path.relative(projectRoot, archPath)}`);
  console.log(`   original DB size: ${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB`);
  console.log('   (You still need to manually `DELETE FROM runs WHERE created_at < ?` to shrink the live DB. Run `npm run check` first.)');
}

main().catch((e) => {
  console.error('archive failed:', e);
  process.exit(1);
});
