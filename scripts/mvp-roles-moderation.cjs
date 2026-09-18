const base = process.env.BASE_URL || 'http://127.0.0.1:4310';

async function req(path, options = {}, jar = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (jar.cookie) headers.cookie = jar.cookie;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, Object.assign({}, options, { headers }));
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar.cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { text }; }
  return { status: res.status, json, cookie: jar.cookie };
}

(async () => {
  const owner = {};
  const viewer = {};
  let r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'owner-local-demo' }) }, owner);
  console.log('owner_login:', r.status, r.json.user && r.json.user.role, !!owner.cookie);
  if (r.status !== 200 || r.json.user.role !== 'owner') throw new Error('owner login failed');

  r = await req('/api/auth/me', {}, owner);
  console.log('owner_me:', r.status, r.json.user && r.json.user.role);
  if (r.json.user.role !== 'owner') throw new Error('owner session missing');

  r = await req('/api/worker/stop', { method: 'POST' }, owner);
  console.log('owner_admin_action:', r.status);
  if (r.status !== 200) throw new Error('owner admin action failed');

  r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'viewer', password: 'viewer-local-demo' }) }, viewer);
  console.log('viewer_login:', r.status, r.json.user && r.json.user.role, !!viewer.cookie);
  if (r.status !== 200 || r.json.user.role !== 'viewer') throw new Error('viewer login failed');

  r = await req('/api/worker/stop', { method: 'POST' }, viewer);
  console.log('viewer_admin_reject:', r.status, r.json.error);
  if (r.status !== 401) throw new Error('viewer should be rejected from admin action');

  r = await req('/api/appeals', { method: 'POST', body: JSON.stringify({ agentId: 'quant-01', reason: 'Manual review needed for rejected evidence', evidenceUrl: 'local://proof' }) }, viewer);
  console.log('appeal_create:', r.status, r.json.appeal && r.json.appeal.status);
  if (r.status !== 201) throw new Error('appeal create failed');
  const appealId = r.json.appeal.id;

  r = await req('/api/appeals/decide', { method: 'POST', body: JSON.stringify({ appealId, status: 'needs_more_evidence', decision: 'Need receipt hash and runtime log' }) }, owner);
  console.log('appeal_decide:', r.status, r.json.appeal && r.json.appeal.status);
  if (r.status !== 200 || r.json.appeal.status !== 'needs_more_evidence') throw new Error('appeal decision failed');

  r = await req('/api/security/status', {}, owner);
  console.log('security:', r.status, r.json.status, (r.json.problems || []).length);
  if (r.status !== 200 || !r.json.auth || !r.json.auth.roles.includes('owner')) throw new Error('security status failed');
})().catch(e => { console.error(e); process.exit(1); });
