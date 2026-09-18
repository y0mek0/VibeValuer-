const RPC_URL = process.env.VIBE_RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID = 46630;
const TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const MAX_RECEIPT_LOOKUP_AGE = 7200;
const MAX_FUTURE_BLOCK_DRIFT = 6;

async function rpc(method, params = [], timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }), signal: controller.signal });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || 'RPC error');
    return payload.result;
  } finally { clearTimeout(timer); }
}

async function getNetworkStatus() {
  const checkedAt = new Date().toISOString();
  try {
    const [chainHex, blockHex] = await Promise.all([rpc('eth_chainId'), rpc('eth_blockNumber')]);
    const chainId = Number.parseInt(chainHex, 16);
    return { source: 'live_rpc', available: true, rpcUrl: RPC_URL, chainId, expectedChainId: CHAIN_ID, chainMatch: chainId === CHAIN_ID, latestBlock: Number.parseInt(blockHex, 16), checkedAt };
  } catch (error) {
    return { source: 'live_rpc', available: false, rpcUrl: RPC_URL, chainId: null, expectedChainId: CHAIN_ID, chainMatch: false, latestBlock: null, checkedAt, error: error.message };
  }
}

async function fetchVibeLaunches({ limit = 25, cursor } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const params = new URLSearchParams({ limit: String(safeLimit) });
  if (cursor) params.set('cursor', String(cursor));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}/launches?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Vibe indexer HTTP ${response.status}`);
    const payload = await response.json();
    return { source: 'vibe_indexer', chainId: CHAIN_ID, items: payload.data?.items || [], page: payload.data?.page || {}, meta: payload.meta || {} };
  } finally { clearTimeout(timer); }
}

function launchesToRegistry(items) {
  return items.map(item => ({
    id: `launch:${item.launchId}`,
    name: item.content?.name || item.name || `Launch ${String(item.launchId).slice(0, 12)}`,
    role: 'Vibe launch record',
    source: 'vibe_indexer',
    status: 'discovered_launch',
    evidenceStatus: 'unavailable',
    chainId: CHAIN_ID,
    tokenId: item.tokenAddress,
    creatorAddress: item.creatorAddress,
    launchId: item.launchId,
    symbol: item.symbol,
    lifecycle: item.curve?.lifecycle,
    asOfBlock: item.asOfBlock,
    evaluated: false
  }));
}
async function fetchVibeCreator(creatorAddress) { return { creatorAddress, name: `Creator ${String(creatorAddress).slice(0, 10)}`, source: 'vibe_indexer' }; }

async function fetchTransactionReceipt(txHash) {
  if (!txHash || !TX_HASH.test(txHash)) throw new Error('invalid txHash');
  return rpc('eth_getTransactionReceipt', [txHash]);
}

async function fetchTransactionByHash(txHash) {
  if (!txHash || !TX_HASH.test(txHash)) throw new Error('invalid txHash');
  return rpc('eth_getTransactionByHash', [txHash]);
}

async function fetchBlock(blockNumber) {
  if (blockNumber === null || blockNumber === undefined) throw new Error('blockNumber required');
  const tag = typeof blockNumber === 'string' && blockNumber.startsWith('0x') ? blockNumber : '0x' + Number(blockNumber).toString(16);
  return rpc('eth_getBlockByNumber', [tag, false]);
}

async function scanLogs({ fromBlock, toBlock, address, topics, limit = 1000 }) {
  async function resolveBlock(b) {
    if (b === null || b === undefined) return null;
    if (typeof b === 'string' && b.startsWith('0x')) return b;
    if (typeof b === 'string' && b.startsWith('latest-')) {
      const delta = Number(b.slice('latest-'.length)) || 0;
      const head = Number.parseInt(await rpc('eth_blockNumber'), 16);
      return '0x' + Math.max(0, head - delta).toString(16);
    }
    if (typeof b === 'string' && b === 'latest') {
      return 'latest';
    }
    return '0x' + Number(b).toString(16);
  }
  const fromTag = await resolveBlock(fromBlock);
  const toTag = await resolveBlock(toBlock);
  const filter = { fromBlock: fromTag, toBlock: toTag };
  if (address) filter.address = address;
  if (topics && topics.length) filter.topics = topics;
  const logs = await rpc('eth_getLogs', [filter]);
  return { logs: (logs || []).slice(0, limit), fromBlock: fromBlock, toBlock: toBlock, count: (logs || []).length };
}

async function scanCreatorActivity({ creatorAddress, fromBlock, toBlock }) {
  if (!creatorAddress || !/^0x[a-fA-F0-9]{40}$/.test(creatorAddress)) throw new Error('invalid creatorAddress');
  const finalToBlock = toBlock || await rpc('eth_blockNumber').then(h => Number.parseInt(h, 16));
  return { creatorAddress: creatorAddress, fromBlock: fromBlock || 0, toBlock: finalToBlock, txCount: 0, note: 'requires archive node for full history; default scan reports block range only' };
}

function parseHexBlock(hex) {
  if (!hex) return null;
  try { return Number.parseInt(hex, 16); } catch (error) { return null; }
}

async function verifyOnchainEvidence({ txHash, expectedChainId, expectedFrom, expectedTo, blockTolerance }) {
  const checkedAt = new Date().toISOString();
  if (!txHash || !TX_HASH.test(txHash)) return { ok: false, reason: 'invalid_tx_hash_format', checkedAt };
  let receipt;
  try {
    receipt = await fetchTransactionReceipt(txHash);
  } catch (error) {
    return { ok: false, reason: `rpc_error:${error.message}`, checkedAt };
  }
  if (!receipt) return { ok: false, reason: 'receipt_not_found', checkedAt };
  const status = (receipt.status || '').toLowerCase();
  if (status !== '0x1') return { ok: false, reason: 'receipt_status_not_success', receiptStatus: status, checkedAt };
  const blockNumber = parseHexBlock(receipt.blockNumber);
  if (!Number.isInteger(blockNumber)) return { ok: false, reason: 'missing_block_number', checkedAt };
  const network = await getNetworkStatus();
  if (expectedChainId && network.chainId !== expectedChainId) return { ok: false, reason: 'chain_mismatch', networkChainId: network.chainId, expectedChainId, checkedAt };
  if (network.latestBlock && Number.isInteger(network.latestBlock)) {
    const age = network.latestBlock - blockNumber;
    if (age > MAX_RECEIPT_LOOKUP_AGE) return { ok: false, reason: 'receipt_too_old', age, checkedAt };
    if (age < -MAX_FUTURE_BLOCK_DRIFT) return { ok: false, reason: 'receipt_in_future', age, checkedAt };
    if (Number.isInteger(blockTolerance) && age > blockTolerance) return { ok: false, reason: 'block_tolerance_exceeded', age, blockTolerance, checkedAt };
  }
  if (expectedFrom && receipt.from && receipt.from.toLowerCase() !== expectedFrom.toLowerCase()) return { ok: false, reason: 'from_mismatch', actual: receipt.from, expected: expectedFrom, checkedAt };
  if (expectedTo) {
    const actualTo = (receipt.to || '').toLowerCase();
    const expected = expectedTo.toLowerCase();
    if (actualTo !== expected) return { ok: false, reason: 'to_mismatch', actual: receipt.to, expected: expectedTo, checkedAt };
  }
  return { ok: true, blockNumber, blockHash: receipt.blockHash, from: receipt.from, to: receipt.to, gasUsed: parseHexBlock(receipt.gasUsed), checkedAt };
}

module.exports = { RPC_URL, CHAIN_ID, getNetworkStatus, fetchVibeLaunches, launchesToRegistry, fetchVibeCreator, fetchTransactionReceipt, fetchTransactionByHash, fetchBlock, scanLogs, scanCreatorActivity, verifyOnchainEvidence, TX_HASH };
