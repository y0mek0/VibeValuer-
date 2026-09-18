#!/usr/bin/env node
/**
 * cleanup-logs.mjs
 *
 * Rotate `server.log` when it exceeds MAX_BYTES (default 10 MB). Keeps the
 * last 3 rotated logs as server-1.log, server-2.log, server-3.log.
 *
 * Crontab:
 *   0 * * * * cd /path/to/vibe-agents-lvl-valuer && node scripts/cleanup-logs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 10 * 1024 * 1024); // 10 MB
const KEEP = Number(process.env.LOG_KEEP || 3);

function parseArgs() {
  return process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h');
}

function main() {
  if (parseArgs()) {
    console.log('Usage: node scripts/cleanup-logs.mjs');
    console.log('Env:   LOG_MAX_BYTES (default 10485760)  LOG_KEEP (default 3)');
    process.exit(0);
  }
  const logPath = path.join(__dirname, '..', 'server.log');
  if (!fs.existsSync(logPath)) {
    console.log('[cleanup-logs] no server.log, nothing to do');
    return;
  }
  const size = fs.statSync(logPath).size;
  if (size < MAX_BYTES) {
    console.log(`[cleanup-logs] ${(size / 1024).toFixed(1)} KB < ${(MAX_BYTES / 1024).toFixed(0)} KB, skipping`);
    return;
  }
  // Rotate: server.log → server-1.log → server-2.log → ... → drop oldest
  const dir = path.dirname(logPath);
  for (let i = KEEP; i >= 1; i--) {
    const from = i === 1 ? logPath : path.join(dir, `server-${i - 1}.log`);
    const to = path.join(dir, `server-${i}.log`);
    if (fs.existsSync(from)) {
      if (fs.existsSync(to)) fs.unlinkSync(to);
      fs.renameSync(from, to);
    }
  }
  // Truncate current to 0 — keeps the file in place, allows server to keep writing.
  fs.truncateSync(logPath, 0);
  console.log(`[cleanup-logs] rotated, kept ${KEEP} backups`);
}

main();
