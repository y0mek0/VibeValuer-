const state = { agents: [], levels: [], summary: null, vibe: null, registry: null, creators: null, syncState: null, audit: null, public: null, auth: { authenticated: false, user: null }, security: null, appeals: [], watchtower: { duplicates: [], patterns: [], recent: [] }, discoveryCursor: null, workerRunning: false, liveEvents: [] };
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

async function get(url, options) { const response = await fetch(url, options); if (!response.ok) throw new Error((await response.json()).error || response.statusText); return response.json(); }
async function getOptional(url, fallback) { try { return await get(url); } catch (e) { return fallback; } }
function allRuns() { return state.agents.flatMap(a => (a.runs || []).map(r => ({ ...r, agentName: a.name }))).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
function renderHero() {
  if (!state.agents || state.agents.length === 0) return;
  // Office level = highest-level agent (lead by progression, not raw xp)
  const lead = state.agents.reduce((a, b) => {
    const al = (a.level?.level || a.metrics?.level || 1);
    const bl = (b.level?.level || b.metrics?.level || 1);
    return bl > al ? b : a;
  }, state.agents[0]);
  const lv = (lead.metrics?.level || (lead.level?.level || 1));
  const xp = lead.metrics?.xp || 0;
  const levelInfo = lead.level || {};
  const total = 30;
  const next = levelInfo.next || null;
  $('#hero-level').textContent = 'LVL ' + (lv || 1);
  $('#hero-stage-name').textContent = levelInfo.name || 'Operator';
  $('#hero-level-meta').textContent = (lv || 1) + ' / ' + total;
  if (next) {
    const remain = Math.max(0, (next.xp || 0) - xp);
    $('#hero-level-next').textContent = '+ ' + remain + ' XP TO LVL ' + (next.level);
  } else {
    $('#hero-level-next').textContent = 'FINAL LEVEL';
  }
  // Progress = (xp - current.xp) / (next.xp - current.xp) toward next
  if (next) {
    const cur = (levelInfo.xp || 0);
    const nx = (next.xp != null ? next.xp : cur + 50);
    const span = Math.max(1, nx - cur);
    const pct = Math.max(0, Math.min(100, Math.round(((xp - cur) / span) * 100)));
    $('#hero-progress').style.width = pct + '%';
  } else {
    $('#hero-progress').style.width = '100%';
  }
  // Autonomy rate = total automated runs / total runs (across agents), % 0-100
  let totalRuns = 0;
  let totalAutomated = 0;
  state.agents.forEach(a => {
    const runs = a.runs || [];
    totalRuns += runs.length;
    totalAutomated += runs.filter(r => r.trigger && r.trigger !== 'user').length;
  });
  const aut = totalRuns > 0 ? Math.round((totalAutomated / totalRuns) * 100) : 0;
  $('#signal-autonomy').textContent = aut;
  // Mini-bars = per-agent autonomy %, agents without runs show muted 8%
  const bars = $('#signal-bars').children;
  for (let i = 0; i < bars.length; i++) {
    const a = state.agents[i];
    if (!a) { bars[i].style.height = '8%'; continue; }
    const runs = a.runs || [];
    const agentRuns = runs.length;
    if (agentRuns === 0) { bars[i].style.height = '8%'; continue; }
    const agentAuto = runs.filter(r => r.trigger && r.trigger !== 'user').length;
    const r = Math.round((agentAuto / agentRuns) * 100);
    bars[i].style.height = Math.max(8, Math.min(94, r)) + '%';
  }
}
function renderMetrics() {
  const totals = state.agents.reduce((t, a) => { const m=a.metrics||{}; t.tasks+=(m.completed||0); t.verified+=(m.verified||0); t.auto+=(m.automatedRuns||m.automated||0); t.xp+=(m.xp||0); t.interventions+=(m.interventions||0); return t; }, {tasks:0,verified:0,auto:0,xp:0,interventions:0});
  const cards = [['VERIFIED TASKS', totals.verified, 'ALL AGENTS'], ['AUTOMATED RUNS', totals.auto, 'EVENT + SCHEDULE'], ['TOTAL XP', totals.xp, 'EVIDENCE-BACKED'], ['HUMAN INTERVENTIONS', totals.interventions, 'LOWER IS BETTER']];
  $('#metric-grid').innerHTML = cards.map(([label,value,note]) => `<div class="metric"><span class="label">${label}</span><strong>${value.toLocaleString()}</strong><em>${note}</em></div>`).join('');
}
function renderTrustFlow() {
  const counts = state.registry?.counts || { discovered:0, evaluated:0, unavailable:0 };
  const linked = (state.registry?.agents || []).filter(a => a.linkStatus && a.linkStatus !== 'unlinked').length;
  const onchain = ((state.summary?.evidenceBreakdown || []).find(b => b.source === 'onchain_tx') || { count:0 }).count;
  const blocks = [
    ['DISCOVERED', counts.discovered, 'found launches / creators'],
    ['LINKED', linked, 'identity candidate'],
    ['EVIDENCE', onchain, 'on-chain proof events'],
    ['EVALUATED', counts.evaluated, 'ranked agents only']
  ];
  const host = document.getElementById('trust-flow');
  if (host) host.innerHTML = blocks.map(([l,v,n],i)=>`<div class="flow-step"><span>${String(i+1).padStart(2,'0')}</span><b>${l}</b><strong>${v}</strong><em>${n}</em></div>`).join('<i class="flow-arrow">→</i>');
}
function renderAdmin() {
  const dup = state.watchtower.duplicates || [];
  const syb = state.watchtower.patterns || [];
  const recent = state.watchtower.recent || [];
  const worker = state.syncState?.worker || {};
  const metrics = [['DUPLICATE EVIDENCE', dup.length, 'SAME TX / SOURCE'], ['SYBIL PATTERNS', syb.length, 'SAME WALLET REUSE'], ['REPLAY BUFFER', recent.length, 'RECENT EVENTS'], ['WORKER', worker.running ? 'ON' : 'OFF', worker.lastError || 'SYNC STATE']];
  const mhost = document.getElementById('admin-metrics');
  if (mhost) mhost.innerHTML = metrics.map(([l,v,n])=>`<div class="metric"><span class="label">${l}</span><strong>${esc(v)}</strong><em>${esc(n)}</em></div>`).join('');
  const rows = [
    ...dup.slice(0,12).map(d => ['DUPLICATE', d.agentId, d.txHash ? d.txHash.slice(0,14)+'…' : '—', d.duplicateRunId || '—']),
    ...syb.slice(0,12).map(s => ['SYBIL', s.fromAddress, `${s.agentCount} agents`, (s.agents||[]).join(', ')])
  ];
  const whost = document.getElementById('watchtower-table');
  if (whost) whost.innerHTML = `<div class="data-row"><div>TYPE</div><div>TARGET</div><div>SIGNAL</div><div>DETAIL</div></div>` + (rows.length ? rows.map(r=>`<div class="data-row"><div><span class="tag warn">${esc(r[0])}</span></div><div>${esc(r[1])}</div><div>${esc(r[2])}</div><div>${esc(r[3])}</div></div>`).join('') : '<div class="data-row"><div>CLEAR</div><div>No duplicate/sybil signals</div><div>—</div><div>—</div></div>');
  renderSecurity();
}
function renderAuth() {
  const user = state.auth && state.auth.user;
  const chip = $('#role-chip');
  if (chip) chip.textContent = user ? `${(user.role || 'viewer').toUpperCase()} / ${user.actor}` : 'ANON / VIEWER';
  const btn = $('#login-open');
  if (btn) btn.textContent = user ? 'LOGOUT' : 'LOGIN';
  const adminState = $('#admin-action-state');
  if (adminState) adminState.textContent = user && ['admin','owner'].includes(user.role) ? 'READY' : 'LOGIN REQUIRED';
}
function renderSecurity() {
  const s = state.security || { status:'unknown', problems:[] };
  const host = $('#security-table');
  const label = $('#security-state');
  if (label) label.textContent = String(s.status || 'unknown').toUpperCase();
  if (host) host.innerHTML = `<div class="data-row"><div>AREA</div><div>STATUS</div><div>DETAIL</div><div>ACTION</div></div>` + [
    ['ROLE MODEL','OWNER / ADMIN / AGENT / VIEWER', 'session + bearer + hmac', 'browser-safe cookie'],
    ['SECRETS', s.problems && s.problems.length ? 'WARN' : 'OK', (s.problems || []).join(', ') || 'env configured / no default leaks', s.hardened ? 'hardened' : 'dev mode'],
    ['FRONTEND', 'SAFE', 'no HMAC secret stored in JS', 'login cookie only'],
    ['PRODUCTION', s.hardened ? 'STRICT' : 'DEV', 'NODE_ENV=production or VALUER_HARDENED=1 blocks defaults', 'set env before deploy']
  ].map(r=>`<div class="data-row"><div><b>${esc(r[0])}</b></div><div><span class="tag ${r[1]==='WARN'?'warn':''}">${esc(r[1])}</span></div><div>${esc(r[2])}</div><div>${esc(r[3])}</div></div>`).join('');
}
function renderAppeals() {
  const appeals = state.appeals || [];
  const open = appeals.filter(a => a.status === 'open').length;
  const host = $('#appeal-metrics');
  if (host) host.innerHTML = [['OPEN APPEALS',open,'NEEDS REVIEW'],['TOTAL APPEALS',appeals.length,'AUDITED'],['DECIDED',appeals.length-open,'RESOLVED']].map(([l,v,n])=>`<div class="metric"><span class="label">${l}</span><strong>${v}</strong><em>${n}</em></div>`).join('');
  const table = $('#appeals-table');
  if (table) table.innerHTML = `<div class="data-row"><div>APPEAL</div><div>AGENT/RUN</div><div>STATUS</div><div>ACTION</div></div>` + (appeals.length ? appeals.map(a=>`<div class="data-row"><div><b>${esc(a.id)}</b><span class="agent-role">${esc(a.reason).slice(0,120)}</span></div><div>${esc(a.agentId)}<span class="agent-role">${esc(a.runId||'no run')}</span></div><div><span class="tag">${esc(a.status.toUpperCase())}</span></div><div>${a.status==='open'?`<button class="text-button decide-appeal" data-appeal="${esc(a.id)}" data-status="needs_more_evidence">NEED MORE</button><button class="text-button decide-appeal" data-appeal="${esc(a.id)}" data-status="approved">APPROVE</button><button class="text-button decide-appeal" data-appeal="${esc(a.id)}" data-status="rejected">REJECT</button>`:esc(a.decision||'—')}</div></div>`).join('') : '<div class="data-row"><div>EMPTY</div><div>No appeals</div><div>—</div><div>—</div></div>');
}
async function refreshAppeals() { const res = await getOptional('/api/appeals?limit=100', {appeals:[]}); state.appeals = res.appeals || []; renderAppeals(); }
function renderAgents() {
  $('#agent-table').innerHTML = state.agents.map(a => `<div class="data-row"><div class="agent-name">${esc(a.name)}<span class="agent-role">${esc(a.role)}</span></div><div><span class="tag">LVL ${a.level ? a.level.level : '?'}</span></div><div>${a.metrics.successRate}%<span class="agent-role">SUCCESS</span></div><div>${a.metrics.xp} XP</div></div>`).join('');
  $('#agent-cards').innerHTML = state.agents.map(a => `<article class="agent-card"><span class="tag">LVL ${a.level ? a.level.level : '?'} / ${esc((a.level && a.level.name) ? a.level.name.toUpperCase() : 'N/A')}</span><h3>${esc(a.name)}</h3><span class="agent-role">${esc(a.role)} · ${esc(a.status)}</span><div class="agent-stats"><div class="agent-stat"><small>XP</small><b>${a.metrics.xp}</b></div><div class="agent-stat"><small>SUCCESS</small><b>${a.metrics.successRate}%</b></div><div class="agent-stat"><small>AUTONOMY</small><b>${a.metrics.autonomyRate}%</b></div><div class="agent-stat"><small>EVIDENCE</small><b>${a.metrics.evidenceRate}%</b></div></div></article>`).join('');
  const breakdown = (state.summary && state.summary.evidenceBreakdown) || [];
  const policy = (state.summary && state.summary.policyViolations) || 0;
  $('#evidence-metrics').innerHTML = [
    ['VERIFIED RUNS', state.agents.reduce((s,a)=>s+a.metrics.verified,0), 'OUT OF ALL COMPLETED'],
    ['POLICY VIOLATIONS', policy, 'BLOCK XP PROMOTION'],
    ['ON-CHAIN EVIDENCE', breakdown.filter(b=>b.source==='onchain_tx').reduce((s,b)=>s+b.count,0), 'TX-CONFIRMED EVENTS'],
    ['SIMULATED / UNVERIFIED', breakdown.filter(b=>b.source==='runtime_event' || b.source==='none').reduce((s,b)=>s+b.count,0), 'NOT PROMOTED']
  ].map(([l,v,n])=>`<div class="metric"><span class="label">${l}</span><strong>${v}</strong><em>${n}</em></div>`).join('');
}
function renderGates() {
  const gates = state.levels.filter(l => l.transition).map(l => { const current=state.agents[0]?.level.level || 1; const pct=Math.min(100, Math.round((current/l.level)*100)); return `<div class="level-mini"><div class="level-mini-top"><span><b>LVL ${l.level}</b> / ${l.name}</span><span>${current >= l.level ? 'CLEARED' : `${pct}%`}</span></div><div class="mini-progress"><i style="width:${current >= l.level ? 100 : pct}%"></i></div></div>`; }).join('');
  $('#gate-list').innerHTML = gates;
}
function renderLevels() { $('#level-table').innerHTML = state.levels.map(l => `<tr class="${l.transition ? 'transition' : ''}"><td>${String(l.level).padStart(2,'0')}</td><td>${esc(l.name)}</td><td>${l.manual}</td><td>${l.delegated}</td><td>${l.automated}</td><td>${l.xp}</td></tr>`).join(''); }
function renderRuns() { $('#run-table').innerHTML = `<div class="data-row"><div>RUN / AGENT</div><div>TYPE</div><div>STATUS</div><div>XP</div></div>` + allRuns().map(r => `<div class="data-row"><div><b>${esc(r.id)}</b><span class="agent-role">${esc(r.agentName)} · ${new Date(r.createdAt).toLocaleString()} · ${esc(r.evidence?.source || 'none')}${r.evidence?.txHash ? ' · '+esc(r.evidence.txHash.slice(0,12))+'…' : ''}</span>${r.policyViolation?'<em class="agent-role" style="color:var(--red)">POLICY VIOLATION</em>':''}</div><div class="run-kind">${esc(r.kind.toUpperCase())}</div><div><span class="tag">${esc(r.verification.toUpperCase())}</span></div><div>+${r.xpAwarded}</div></div>`).join(''); const runs=state.agents.flatMap(a=>(a.runs||[])); const total=runs.length; const evidence=runs.filter(r=>r.evidence&&r.evidence.source==='onchain_tx').length; const sim=runs.filter(r=>r.verification==='simulated'||r.policyViolation).length; const reviewed=runs.filter(r=>r.evidenceReviewed).length; $('#runs-metrics').innerHTML=[['TOTAL EVENTS',total,'INCLUDING DRAFTS'],['ON-CHAIN EVIDENCE',evidence,'TX-CONFIRMED'],['SIM / VIOLATION',sim,'ZERO XP'],['OPERATOR-REVIEWED',reviewed,'BOOSTED SCORING']].map(([l,v,n])=>`<div class="metric"><span class="label">${l}</span><strong>${v}</strong><em>${n}</em></div>`).join(''); }
function renderDiscovery() { const c=state.registry.counts; const creators=state.creators||{count:0,creators:[]}; $('#discovery-metrics').innerHTML=[['DISCOVERED LAUNCHES',c.discovered,'VIBE INDEXER'],['CREATORS',creators.count,'UNIQUE ADDRESSES'],['UNAVAILABLE EVIDENCE',c.unavailable,'NO USABLE EVIDENCE']].map(([l,v,n])=>`<div class="metric"><span class="label">${l}</span><strong>${v}</strong><em>${n}</em></div>`).join(''); const rows=state.registry.agents.map(a=>`<div class="data-row discovery-row"><div><b>${esc(a.name)}</b><span class="agent-role">${esc(a.id)} · ${esc(a.creatorAddress||'no creator')}</span></div><div><span class="tag">${esc(a.source.toUpperCase())}</span></div><div>${esc((a.symbol||a.lifecycle||'').toUpperCase()||'—')}</div><div>${a.evaluated?'EVALUATED':a.linkStatus==='evaluated'?'EVALUATED':a.linkStatus==='linked_unverified'?'LINKED / UNVERIFIED':`<button class="text-button link-record" data-id="${esc(a.id)}" data-name="${esc(a.name)}">LINK →</button>`}</div></div>`).join(''); $('#discovery-table').innerHTML=`<div class="data-row"><div>LAUNCH / CREATOR</div><div>SOURCE</div><div>SYMBOL / LIFECYCLE</div><div>STATE</div></div>${rows}`; const crow=creators.creators.slice(0,15).map(c=>`<div class="data-row"><div><b>${esc(c.creatorAddress)}</b></div><div>${c.launches}</div><div>${esc(c.firstSeen?new Date(c.firstSeen).toLocaleDateString():'—')}</div><div>${esc(c.lastSeen?new Date(c.lastSeen).toLocaleString():'—')}</div></div>`).join(''); $('#creators-table').innerHTML=`<div class="data-row"><div>CREATOR ADDRESS</div><div>LAUNCHES</div><div>FIRST SEEN</div><div>LAST SEEN</div></div>${crow}`; }
function renderSyncState() { const s=state.syncState; if(!s||(!s.status&&!s.pages_total)) return; const cur=state.discoveryCursor||(s.cursor?{cursor:s.cursor}:null); const rows=[['STATUS',(s.status||'idle').toUpperCase()],['PAGES',String(s.pages_total||0)],['CURSOR',(s.cursor?'RESUMABLE':'COMPLETE')],['LAST BLOCK',s.last_block?String(s.last_block):'—'],['LAST IMPORT',String(s.last_imported||0)],['LAST ERROR',s.last_error||'—'],['WORKER',s.worker?(s.worker.running?'ON':'OFF'):'—']].map(([l,v])=>`<div class="metric"><span class="label">SYNC ${l}</span><strong style="font-size:18px">${esc(v)}</strong></div>`).join(''); const host=document.getElementById('sync-state'); if(host) host.innerHTML=rows; const workerButton=$('#worker-toggle'); if(workerButton){ workerButton.textContent=state.workerRunning?'WORKER ON':'WORKER OFF'; workerButton.style.color=state.workerRunning?'var(--lime)':'var(--text)'; } }
function renderAudit() { const entries=(state.audit&&state.audit.entries)||[]; const rows=entries.map(e=>`<div class="data-row"><div><b>${esc(e.action)}</b><span class="agent-role">${esc(e.createdAt)} · ${esc(e.actor||'system')}</span></div><div>${esc(e.agentId||e.registryId||e.runId||'—')}</div><div><span class="tag">${(e.level||'INFO').toUpperCase()}</span></div><div>${e.details?`<code>${esc(JSON.stringify(e.details).slice(0,140))}</code>`:'—'}</div></div>`).join(''); $('#audit-table').innerHTML=`<div class="data-row"><div>ACTION</div><div>TARGET</div><div>LEVEL</div><div>DETAILS</div></div>${rows||'<div class="data-row"><div>NO AUDIT ENTRIES</div><div></div><div></div><div></div></div>'}`; }
function renderLiveEvents() { const rows=state.liveEvents.map(e=>`<div class="data-row"><div><b>${esc(e.type)}</b><span class="agent-role">${esc(e.ts)}</span></div><div>${esc(e.runId||e.registryId||e.agentId||e.reason||'—')}</div><div><span class="tag">${esc(e.xpAwarded !== undefined ? e.xpAwarded + ' XP' : (e.hasMore !== undefined ? (e.hasMore ? 'MORE' : 'DONE') : (e.slashedXp !== undefined ? 'SLASHED ' + e.slashedXp : '—')))}</span></div><div>${esc(JSON.stringify(e).slice(0,200))}</div></div>`).join(''); $('#live-stream-table').innerHTML=`<div class="data-row"><div>EVENT TYPE</div><div>TARGET</div><div>VALUE</div><div>PAYLOAD</div></div>${rows||'<div class="data-row"><div>WAITING FOR EVENTS...</div><div></div><div></div><div></div></div>'}`; const statusHost=document.getElementById('live-stream-status'); if(statusHost){ statusHost.innerHTML=[['LIVE EVENTS',String(state.liveEvents.length),'IN-MEMORY BUFFER']].map(function(l){return '<div class="metric"><span class="label">'+l[0]+'</span><strong>'+l[1]+'</strong><em>'+l[2]+'</em></div>';}).join(''); } }
function renderPublic() { const list=(state.public&&state.public.agents)||[]; $('#public-metrics').innerHTML=[['PUBLIC RANKING',list.length,'READ-ONLY'],['TOP XP',list[0]?list[0].xp:0,'SORTED BY EVIDENCE']].map(([l,v,n])=>`<div class="metric"><span class="label">${l}</span><strong>${v}</strong><em>${n}</em></div>`).join(''); const rows=list.map(a=>`<div class="data-row"><div><b>${esc(a.name)}</b><span class="agent-role">${esc(a.id)}</span></div><div><span class="tag">LVL ${a.level}</span></div><div>${a.xp} XP</div><div>SUCC ${a.successRate}% / AUT ${a.autonomyRate}% / EVD ${a.evidenceRate}%</div></div>`).join(''); $('#public-table').innerHTML=`<div class="data-row"><div>AGENT</div><div>LEVEL</div><div>XP</div><div>METRICS</div></div>${rows}`; }
const VIEW_TITLES = {
  overview: 'Overview',
  agents: 'Agents',
  levels: 'Level matrix',
  runs: 'Run log',
  discovery: 'Discovery',
  public: 'Public ranking',
  audit: 'Audit',
  admin: 'Admin',
  moderation: 'Moderation',
  onboarding: 'Onboarding'
};
function showView(view) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active-view'));
  const target = document.getElementById(view + '-view');
  if (target) target.classList.add('active-view');
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#page-title').textContent = VIEW_TITLES[view] || view;
  setObStep(1);
}
async function load() { const [agents, levels, summary, vibe, registry, creators, syncState, audit, publicAgents, worker, duplicates, sybil, recent, auth, security, appeals] = await Promise.all([get('/api/agents'), get('/api/levels'), get('/api/summary'), get('/api/vibe/status'), get('/api/registry'), get('/api/registry/creators'), get('/api/registry/sync-state'), get('/api/audit'), get('/api/public/agents'), get('/api/worker/status'), getOptional('/api/watchtower/duplicates', {duplicates:[]}), getOptional('/api/watchtower/sybil?threshold=2', {patterns:[]}), getOptional('/api/events/recent', {events:[]}), getOptional('/api/auth/me', {authenticated:false,user:null}), getOptional('/api/security/status', {status:'unknown',problems:[]}), getOptional('/api/appeals?limit=100', {appeals:[]})]); state.agents=agents.agents; state.levels=levels.levels; state.summary=summary; state.vibe=vibe; state.registry=registry; state.creators=creators; state.syncState=syncState; state.audit=audit; state.public=publicAgents; state.auth=auth; state.security=security; state.appeals=appeals.appeals||[]; state.watchtower={duplicates:duplicates.duplicates||[],patterns:sybil.patterns||[],recent:recent.events||[]}; state.workerRunning=worker&&worker.running; if(syncState.state&&syncState.state.cursor) state.discoveryCursor=syncState.state.cursor; $('#registry-count').textContent=`${registry.counts.evaluated} EVALUATED / ${registry.counts.discovered} DISCOVERED`; $('#network-chip').innerHTML=`ROBINHOOD TESTNET <b>${vibe.chainId || 46630}</b> <em style="color:${vibe.available && vibe.chainMatch ? 'var(--lime)' : 'var(--red)'}">${vibe.available && vibe.chainMatch ? 'LIVE RPC' : 'UNAVAILABLE'}</em>`; renderAuth(); renderHero(); renderMetrics(); renderTrustFlow(); renderAgents(); renderGates(); renderLevels(); renderRuns(); renderDiscovery(); renderSyncState(); renderAudit(); renderPublic(); renderLiveEvents(); renderAdmin(); renderAppeals(); $('#run-agent').innerHTML=state.agents.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join(''); $('#link-agent').innerHTML=state.agents.map(a=>`<option value="${a.id}">${esc(a.name)} — ${esc(a.id)}</option>`).join(''); const appealAgent=$('#appeal-agent'); if(appealAgent) appealAgent.innerHTML=state.agents.map(a=>`<option value="${a.id}">${esc(a.name)} — ${esc(a.id)}</option>`).join(''); }

function connectSse() { try { const es = new EventSource('/api/events/stream?since=' + encodeURIComponent(new Date().toISOString())); es.onopen = function() { const host=document.getElementById('live-stream-state'); if(host){ host.textContent='CONNECTED'; host.style.color='var(--lime)'; } }; es.onmessage = function(ev) { try { const data = JSON.parse(ev.data); state.liveEvents.unshift(data); if (state.liveEvents.length > 50) state.liveEvents.length = 50; renderLiveEvents(); } catch (e) { /* ignore */ } }; es.onerror = function() { const host=document.getElementById('live-stream-state'); if(host){ host.textContent='ERROR'; host.style.color='var(--red)'; } }; window.__sse = es; } catch (e) { console.error('sse_failed', e); } }
document.addEventListener('click', e => { const nav=e.target.closest('[data-view]'); if(nav) showView(nav.dataset.view); const link=e.target.closest('.link-record'); if(link){ $('#link-registry-id').value=link.dataset.id; $('#link-entity').textContent=`${link.dataset.name} · ${link.dataset.id}`; $('#link-status').textContent=''; $('#link-dialog').showModal(); } });
$('#record-open').addEventListener('click', () => $('#record-dialog').showModal());
$('#run-complexity').addEventListener('input', e => $('#complexity-value').value = e.target.value);
$('#sync-discovery').addEventListener('click', async () => { const button=$('#sync-discovery'); const status=$('#discovery-status'); button.disabled=true; status.textContent='SYNCING…'; try { const result=await get('/api/registry/sync-vibe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:25,cursor:state.discoveryCursor})}); state.discoveryCursor=result.page.nextCursor || null; status.textContent=`IMPORTED ${result.imported} · ${result.page.hasMore?'MORE AVAILABLE':'INDEX COMPLETE'}`; await load(); } catch(error) { status.textContent=`SYNC ERROR: ${error.message}`; } finally { button.disabled=false; } });
$('#worker-toggle').addEventListener('click', async () => { const button=$('#worker-toggle'); if(state.workerRunning){ await get('/api/worker/stop',{method:'POST'}); state.workerRunning=false; button.textContent='WORKER OFF'; button.style.color='var(--text)'; } else { await get('/api/worker/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}); state.workerRunning=true; button.textContent='WORKER ON'; button.style.color='var(--lime)'; } });
const watchRefresh = document.getElementById('watchtower-refresh');
if (watchRefresh) watchRefresh.addEventListener('click', async () => { watchRefresh.textContent='CHECKING…'; const [d,s,r]=await Promise.all([getOptional('/api/watchtower/duplicates',{duplicates:[]}),getOptional('/api/watchtower/sybil?threshold=2',{patterns:[]}),getOptional('/api/events/recent',{events:[]})]); state.watchtower={duplicates:d.duplicates||[],patterns:s.patterns||[],recent:r.events||[]}; renderAdmin(); watchRefresh.textContent='REFRESH →'; });
$('#link-form').addEventListener('submit', async e => { e.preventDefault(); try { await get('/api/registry/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({registryId:$('#link-registry-id').value,agentId:$('#link-agent').value})}); $('#link-status').textContent='LINKED / UNVERIFIED — no level change'; await load(); setTimeout(() => $('#link-dialog').close(), 700); } catch(error) { $('#link-status').textContent=error.message; } });
$('#record-form').addEventListener('submit', async e => { e.preventDefault(); const body={agentId:$('#run-agent').value,kind:$('#run-kind').value,complexity:$('#run-complexity').value,trigger:$('#run-trigger').value,verification:$('#run-verification').value,status:'completed',idempotencyKey:`ui-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,evidence:{source:'user_recorded',operation:'unknown',chainId:46630,blockNumber:0,sourceEventId:'ui_form',verificationMethod:'manual_entry'},evidenceReviewed:$('#run-reviewed').checked}; try { const result=await get('/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); $('#form-status').textContent=`RECORDED +${result.run.xpAwarded} XP`; await load(); setTimeout(() => $('#record-dialog').close(), 600); } catch(error) { $('#form-status').textContent=error.message; } });
$('#login-open').addEventListener('click', async () => { if(state.auth && state.auth.authenticated){ await get('/api/auth/logout',{method:'POST'}); state.auth={authenticated:false,user:null}; renderAuth(); await load(); return; } $('#login-status').textContent=''; $('#login-dialog').showModal(); });
$('#record-open').addEventListener('click', () => { $('#form-status').textContent=''; $('#record-dialog').showModal(); });
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); try { const result=await get('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('#login-username').value,password:$('#login-password').value})}); $('#login-status').textContent=`LOGGED IN AS ${result.user.role.toUpperCase()}`; await load(); setTimeout(()=>$('#login-dialog').close(),500); } catch(error) { $('#login-status').textContent=error.message; } });
document.addEventListener('click', async e => { const action=e.target.closest('.admin-action'); if(action){ const out=$('#admin-output'); out.textContent='RUNNING '+action.dataset.adminAction+'…'; try { let res; if(action.dataset.adminAction==='sync-now') res=await get('/api/worker/sync-now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:10,maxPages:5})}); if(action.dataset.adminAction==='watchtower-run') res=await get('/api/watchtower/run',{method:'POST'}); if(action.dataset.adminAction==='backup-create') res=await get('/api/backup/create',{method:'POST'}); if(action.dataset.adminAction==='decay') res=await get('/api/reputation/decay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thresholdDays:30,decayPercent:5,minDecay:1})}); if(action.dataset.adminAction==='cleanup') res=await get('/api/registry/cleanup-stale',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({staleDays:30})}); if(action.dataset.adminAction==='export') res=await get('/api/export'); out.textContent=JSON.stringify(res,null,2).slice(0,4000); await load(); } catch(error) { out.textContent='ERROR: '+error.message; } }
  const dec=e.target.closest('.decide-appeal'); if(dec){ try { await get('/api/appeals/decide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appealId:dec.dataset.appeal,status:dec.dataset.status,decision:'Browser moderation decision'})}); await refreshAppeals(); } catch(error) { alert(error.message); } }
});
const appealOpen=$('#appeal-open'); if(appealOpen) appealOpen.addEventListener('click',()=>$('#appeal-dialog').showModal());
const appealsRefresh=$('#appeals-refresh'); if(appealsRefresh) appealsRefresh.addEventListener('click',refreshAppeals);
let obState = { onboardingId: null, walletAddress: null, challenge: null, step: 1 };
function setObStep(n) {
  obState.step = n;
  ['ob-step-1','ob-step-2','ob-step-3'].forEach((id,i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active-step', i+1 === n);
    el.classList.toggle('done-step', i+1 < n);
  });
}
$('#ob-register')?.addEventListener('click', async () => {
  const name = $('#ob-name')?.value?.trim();
  if (!name) return $('#ob-s1-status').textContent = 'name required';
  $('#ob-s1-status').textContent = 'registering…';
  try {
    const r = await get('/api/onboarding/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, email: $('#ob-email')?.value?.trim() || null }) });
    const id = (r.onboarding && r.onboarding.id) || (r.agent && r.agent.id);
    if (!id) throw new Error('server returned no id');
    obState.onboardingId = id;
    obState.step = 2;
    setObStep(2);
    $('#ob-s1-status').textContent = `Registered: ${id}`;
  } catch(e) { $('#ob-s1-status').textContent = e.message; }
});
$('#ob-challenge')?.addEventListener('click', async () => {
  const wallet = $('#ob-wallet')?.value?.trim();
  if (!wallet) return $('#ob-s2-status').textContent = 'wallet address required';
  if (!obState.onboardingId) return $('#ob-s2-status').textContent = 'step 1 not completed';
  $('#ob-s2-status').textContent = 'generating challenge…';
  try {
    const r = await get('/api/onboarding/challenge', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ onboardingId: obState.onboardingId, walletAddress: wallet }) });
    obState.walletAddress = wallet;
    obState.challenge = r;
    document.getElementById('ob-challenge-box').style.display = 'block';
    document.getElementById('ob-message').textContent = r.message;
    $('#ob-s2-status').textContent = 'sign the message above with your wallet';
  } catch(e) { $('#ob-s2-status').textContent = e.message; }
});
$('#ob-verify')?.addEventListener('click', async () => {
  const sig = $('#ob-signature')?.value?.trim();
  if (!sig) return $('#ob-s2-status').textContent = 'signature required';
  if (!obState.challenge) return $('#ob-s2-status').textContent = 'generate challenge first';
  $('#ob-s2-status').textContent = 'verifying…';
  try {
    const r = await get('/api/onboarding/verify', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ onboardingId: obState.onboardingId, walletAddress: obState.walletAddress, nonce: obState.challenge.nonce, expires: obState.challenge.expires, signature: sig }) });
    obState.step = 3;
    setObStep(3);
    $('#ob-s2-status').textContent = 'wallet verified! address: ' + (r.recoveredAddress || '').slice(0, 14) + '…';
  } catch(e) { $('#ob-s2-status').textContent = e.message; }
});
$('#ob-complexity')?.addEventListener('input', () => {
  const v = $('#ob-complexity')?.value;
  const out = $('#ob-complexity-val');
  if (out) out.textContent = v;
});
$('#ob-finalize')?.addEventListener('click', async () => {
  const agentId = $('#ob-agent-id')?.value?.trim();
  if (!agentId) return $('#ob-s3-status').textContent = 'agent id required (step 1 result)';
  if (!obState.onboardingId) return $('#ob-s3-status').textContent = 'onboarding not started';
  $('#ob-s3-status').textContent = 'finalizing…';
  try {
    const txHash = $('#ob-tx-hash')?.value?.trim();
    const evidence = txHash ? { source: 'onchain_tx', txHash, chainId: 46630 } : { source: 'user_recorded', operation: 'onboarding_first_run' };
    const finalize = await get('/api/onboarding/finalize', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ onboardingId: obState.onboardingId, agentId }) });
    const runBody = { agentId, kind: $('#ob-run-kind')?.value || 'verified', complexity: $('#ob-complexity')?.value || 4, trigger: 'agent', verification: txHash ? 'verified' : 'user_confirmed', status: 'completed', idempotencyKey: `ob-${Date.now()}`, evidence, evidenceReviewed: !!txHash };
    const run = await get('/api/runs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(runBody) });
    const result = document.getElementById('ob-result');
    if (result) { result.style.display = 'block'; result.innerHTML = `<h3>AGENT ONBOARDED</h3><p><b>Agent ID:</b> ${esc(finalize.agent?.id || agentId)}</p><p><b>XP earned:</b> ${run.run?.xpAwarded || 0}</p><p><b>Wallet verified:</b> ${esc(finalize.onboarding?.walletAddress || '—')}</p><p><b>Next:</b> View in <b>02 AGENTS</b> or record more runs in <b>03 RUN LOG</b>.</p>`; }
    $('#ob-s3-status').textContent = `DONE — ${run.run?.xpAwarded || 0} XP`;
  } catch(e) { $('#ob-s3-status').textContent = e.message; }
});
$('#appeal-form').addEventListener('submit', async e => { e.preventDefault(); try { const res=await get('/api/appeals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:$('#appeal-agent').value,runId:$('#appeal-run').value||null,reason:$('#appeal-reason').value,evidenceUrl:$('#appeal-url').value||null})}); $('#appeal-status').textContent=`CREATED ${res.appeal.id}`; await refreshAppeals(); setTimeout(()=>$('#appeal-dialog').close(),600); } catch(error) { $('#appeal-status').textContent=error.message; } });
load().catch(error => { document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;bottom:20px;right:20px;background:#ff5d65;color:#080b08;padding:12px;font:12px monospace">API ERROR: ${esc(error.message)}</div>`); });
connectSse();
initHelpTips();
function initHelpTips() { document.querySelectorAll('[data-help]').forEach(el => { const existing = el.querySelector('.help-tip'); if (existing) return; const tip = document.createElement('span'); tip.className = 'help-tip'; tip.textContent = '?'; tip.title = el.dataset.help; el.appendChild(tip); }); }
