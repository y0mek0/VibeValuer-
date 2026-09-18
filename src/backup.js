const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const db = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 10);

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(function (f) { return f.endsWith('.sqlite'); })
    .map(function (f) {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
}

function createBackup() {
  ensureDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUP_DIR, 'valuer-' + ts + '.sqlite');
  try {
    fs.copyFileSync(db.DB_PATH, target);
  } catch (error) {
    throw new Error('backup_failed: ' + error.message);
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const backups = listBackups();
  while (backups.length > MAX_BACKUPS) {
    const oldest = backups.pop();
    try { fs.unlinkSync(path.join(BACKUP_DIR, oldest.file)); } catch (e) { /* ignore */ }
  }
  return { file: path.basename(target), size: fs.statSync(target).size, sha256: hash, createdAt: new Date().toISOString() };
}

function restoreBackup(file) {
  ensureDir();
  const safe = path.basename(file);
  if (safe !== file) throw new Error('invalid_backup_filename');
  const target = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(target)) throw new Error('backup_not_found');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const tmp = db.DB_PATH + '.restore-' + Date.now();
  fs.copyFileSync(target, tmp);
  fs.renameSync(tmp, db.DB_PATH);
  return { restored: safe, sha256: hash, restoredAt: new Date().toISOString() };
}

module.exports = { listBackups, createBackup, restoreBackup, BACKUP_DIR, MAX_BACKUPS };
