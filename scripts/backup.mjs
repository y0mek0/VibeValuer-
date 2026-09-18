#!/usr/bin/env node
/**
 * backup.mjs
 *
 * Standalone SQLite snapshot. Reads the live DB file from `data/valuer.sqlite`,
 * uses SQLite's online backup API via better-sqlite3 to copy without locking the
 * writer, and writes the snapshot to `data/backups/`.
 *
 * Usage:
 *   node scripts/backup.mjs                  → auto-naming: backup-YYYY-MM-DDTHH-mm-ss.sqlite
 *   node scripts/backup.mjs --label daily    → backup-daily-YYYY-MM-DDTHH-mm-ss.sqlite
 *   node scripts/backup.mjs --retain 30      → keep last 30 (default 10)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = { label: '', retain: 10 };
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/backup.mjs [--label=<text>] [--retain=N]');
      process.exit(0);
    } else if (a.startsWith('--label=')) out.label = a.slice('--label='.length);
    else if (a.startsWith('--retain=')) out.retain = Number(a.slice('--retain='.length));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const projectRoot = path.join(__dirname, '..');
  const dbPath = path.join(projectRoot, 'data', 'valuer.sqlite');
  const backupDir = path.join(projectRoot, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    console.error(`No DB at ${dbPath}. Start the server once first.`);
    process.exit(1);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = (args.label ? `backup-${args.label}-${ts}.sqlite` : `backup-${ts}.sqlite`);
  const outPath = path.join(backupDir, file);
  // Use better-sqlite3 backup API for atomic snapshot.
  const Database = (await import('better-sqlite3')).default;
  const src = new Database(dbPath, { readonly: true });
  const dst = new Database(outPath);
  try {
    src.backup(dst);
    dst.close();
  } finally {
    src.close();
  }
  const size = fs.statSync(outPath).size;
  console.log(`✅ backup: ${path.relative(projectRoot, outPath)}  (${(size / 1024).toFixed(1)} KB)`);
  // Rotate: keep last `retain`
  const files = fs.readdirSync(backupDir).filter((n) => n.startsWith('backup-') && n.endsWith('.sqlite'))
    .map((n) => ({ n, full: path.join(backupDir, n), mtime: fs.statSync(path.join(backupDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length > args.retain) {
    const toDelete = files.slice(args.retain);
    toDelete.forEach((f) => {
      fs.unlinkSync(f.full);
      console.log(`🗑 removed old: ${path.relative(projectRoot, f.full)}`);
    });
  }
}

main().catch((e) => {
  console.error('backup failed:', e);
  process.exit(1);
});
