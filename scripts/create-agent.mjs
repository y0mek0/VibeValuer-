#!/usr/bin/env node
/**
 * create-agent.mjs
 *
 * Quick CLI to insert a single agent via direct SQL — useful for testing or
 * bootstrapping demo data when the dashboard isn't running.
 *
 * Usage:
 *   node scripts/create-agent.mjs "My Test Bot" --role=agent
 *   node scripts/create-agent.mjs "Lead Quant" --role=evaluator --email=me@example.com
 *
 * Generates an agentId like `agent-{ts}-{rand}` (same format as the server).
 */

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = { name: '', role: 'agent', email: null, status: 'active' };
  const rest = argv.slice(2);
  if (rest.length && !rest[0].startsWith('--')) out.name = rest.shift();
  for (const a of rest) {
    if (a.startsWith('--role=')) out.role = a.slice('--role='.length);
    else if (a.startsWith('--email=')) out.email = a.slice('--email='.length);
    else if (a.startsWith('--status=')) out.status = a.slice('--status='.length);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/create-agent.mjs <name> [--role=agent|evaluator|...] [--email=...] [--status=...]');
      process.exit(0);
    }
  }
  if (!out.name) {
    console.error('name is required');
    process.exit(1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = path.join(__dirname, '..');
  const dbPath = path.join(projectRoot, 'data', 'valuer.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const id = `agent-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO agents (id, name, role, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, args.name, args.role, args.status, args.email, now, now);
    console.log(`✅ created agent: ${id}`);
    console.log(`  name:   ${args.name}`);
    console.log(`  role:   ${args.role}`);
    console.log(`  status: ${args.status}`);
    if (args.email) console.log(`  email:  ${args.email}`);
    console.log('');
    console.log('Next: link a wallet through the onboarding wizard, or POST /api/runs directly.');
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('create-agent failed:', e);
  process.exit(1);
});
