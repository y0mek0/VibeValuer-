const { fetchVibeLaunches, launchesToRegistry } = require('./vibe-adapter');
const db = require('./db');

let workerHandle = null;
let lastError = null;
let lastTick = null;

async function tick({ limit = 25 } = {}) {
  const startedAt = new Date().toISOString();
  try {
    const state = db.syncState('vibe_indexer');
    const cursor = state ? state.cursor : null;
    const page = await fetchVibeLaunches({ limit: limit, cursor: cursor });
    const items = launchesToRegistry(page.items || []);
    const result = db.importRegistry(items, 'vibe_indexer');
    const previousState = db.syncState('vibe_indexer');
    const pagesTotal = (previousState && previousState.pages_total || 0) + 1;
    const resumedAt = cursor ? (previousState && previousState.cursor === cursor ? previousState.resumed_at : new Date().toISOString()) : null;
    db.upsertSyncState({
      source: 'vibe_indexer',
      cursor: page.page.nextCursor || null,
      lastBlock: db.lastLaunchBlock(),
      lastImported: result.imported,
      pagesTotal: pagesTotal,
      status: page.page.hasMore ? 'in_progress' : 'complete',
      lastError: null,
      resumedAt: resumedAt
    });
    db.recordAudit({ action: 'worker.sync_vibe', actor: 'worker', details: { imported: result.imported, pagesTotal: pagesTotal, hasMore: !!page.page.hasMore, resumedAt: resumedAt } });
    lastTick = { startedAt: startedAt, finishedAt: new Date().toISOString(), imported: result.imported, hasMore: !!page.page.hasMore };
    lastError = null;
    return lastTick;
  } catch (error) {
    lastError = { message: error.message, startedAt: startedAt };
    db.upsertSyncState({ source: 'vibe_indexer', status: 'error', lastError: error.message, lastImported: 0 });
    db.recordAudit({ action: 'worker.sync_vibe.error', actor: 'worker', details: { error: error.message } });
    return null;
  }
}

function status() {
  return { running: workerHandle !== null, lastTick: lastTick, lastError: lastError };
}

async function runUntilComplete({ limit = 25, maxPages = 50, idleSleepMs = 200 } = {}) {
  let pages = 0;
  while (pages < maxPages) {
    const state = db.syncState('vibe_indexer');
    if (state && state.status === 'complete' && !state.cursor) return { pages: pages, complete: true };
    const result = await tick({ limit: limit });
    if (!result) return { pages: pages, complete: false, error: lastError };
    pages++;
    if (!result.hasMore) return { pages: pages, complete: true };
    await new Promise(function (resolve) { setTimeout(resolve, idleSleepMs); });
  }
  return { pages: pages, complete: false, reason: 'max_pages_reached' };
}

function start({ intervalMs = 5 * 60 * 1000, limit = 25 } = {}) {
  if (workerHandle) return false;
  workerHandle = setInterval(function () { tick({ limit: limit }).catch(function () { /* logged */ }); }, intervalMs);
  tick({ limit: limit }).catch(function () { /* logged */ });
  return true;
}

function stop() {
  if (!workerHandle) return false;
  clearInterval(workerHandle);
  workerHandle = null;
  return true;
}

module.exports = { tick, status, start, stop, runUntilComplete };
