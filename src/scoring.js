const LEVELS = [
  { level: 1, name: 'Manual start', manual: 1, delegated: 0, automated: 0, xp: 0 },
  { level: 2, name: 'Repeatable manual', manual: 2, delegated: 0, automated: 0, xp: 2 },
  { level: 3, name: 'Stable manual', manual: 5, delegated: 0, automated: 0, xp: 5 },
  { level: 4, name: 'First brief', manual: 10, delegated: 1, automated: 0, xp: 10 },
  { level: 5, name: 'First working agent', manual: 15, delegated: 2, automated: 0, xp: 18, transition: true },
  { level: 6, name: 'Assistant', manual: 20, delegated: 5, automated: 0, xp: 27 },
  { level: 7, name: 'Reliable assistant', manual: 25, delegated: 10, automated: 0, xp: 40 },
  { level: 8, name: 'Context assistant', manual: 30, delegated: 20, automated: 0, xp: 60 },
  { level: 9, name: 'Prepared operator', manual: 40, delegated: 35, automated: 0, xp: 85 },
  { level: 10, name: 'Automation enabled', manual: 50, delegated: 50, automated: 10, xp: 120, transition: true },
  { level: 11, name: 'Stable automation', manual: 55, delegated: 65, automated: 25, xp: 155 },
  { level: 12, name: 'Monitor', manual: 60, delegated: 80, automated: 50, xp: 195 },
  { level: 13, name: 'Quality control', manual: 70, delegated: 100, automated: 75, xp: 240 },
  { level: 14, name: 'Safe automation', manual: 80, delegated: 125, automated: 100, xp: 290 },
  { level: 15, name: 'Independent operator', manual: 100, delegated: 150, automated: 125, xp: 350, transition: true },
  { level: 16, name: 'Multi-step operator', manual: 110, delegated: 180, automated: 160, xp: 420 },
  { level: 17, name: 'Fault tolerant', manual: 120, delegated: 210, automated: 200, xp: 500 },
  { level: 18, name: 'Planner', manual: 135, delegated: 250, automated: 250, xp: 590 },
  { level: 19, name: 'Bounded autonomy', manual: 150, delegated: 300, automated: 300, xp: 690 },
  { level: 20, name: 'Office runs itself', manual: 175, delegated: 350, automated: 400, xp: 800, transition: true },
  { level: 21, name: 'Process manager', manual: 190, delegated: 425, automated: 525, xp: 930 },
  { level: 22, name: 'Resource manager', manual: 210, delegated: 500, automated: 675, xp: 1080 },
  { level: 23, name: 'Verifiable memory', manual: 230, delegated: 600, automated: 850, xp: 1250 },
  { level: 24, name: 'Coordinator', manual: 250, delegated: 725, automated: 1050, xp: 1450 },
  { level: 25, name: 'Agent team', manual: 275, delegated: 850, automated: 1250, xp: 1700, transition: true },
  { level: 26, name: 'Specialist team', manual: 300, delegated: 1000, automated: 1500, xp: 1980 },
  { level: 27, name: 'Operating loop', manual: 325, delegated: 1200, automated: 1800, xp: 2300 },
  { level: 28, name: 'Self-checking system', manual: 350, delegated: 1450, automated: 2150, xp: 2650 },
  { level: 29, name: 'Autonomous organization', manual: 400, delegated: 1750, automated: 2600, xp: 3050 },
  { level: 30, name: 'Agent organization', manual: 500, delegated: 2000, automated: 3000, xp: 3500, transition: true }
];

const XP = { manual: 1, simple: 3, verified: 6, automated: 10, multiStep: 20, recovery: 8, delegated: 25, critical: 30 };

function calculateXp(run) {
  if (run.policyViolation) return 0;
  if (run.verification === 'simulated' || run.status === 'simulated') return 0;
  if (run.evidence && run.evidence.source === 'onchain_tx') {
    if (run.evidence.operation !== 'real_operation') return 0;
    if (!run.evidence.txHash) return 0;
    if (!run.evidence.receiptStatus) return 0;
    if (run.evidence.receiptStatus !== 'success' && run.evidence.receiptStatus !== '0x1') return 0;
  }
  if (run.evidence && run.evidence.operation === 'simulation') return 0;
  const base = XP[run.kind] || XP.simple;
  const complexity = Math.max(1, Math.min(10, Number(run.complexity) || 1));
  const evidence = run.verification === 'verified' ? 1 : run.verification === 'user_confirmed' ? 0.5 : 0;
  const outcome = run.status === 'completed' ? 1 : run.status === 'partial' ? 0.5 : 0;
  if (!evidence || !outcome) return 0;
  const reviewBoost = run.evidenceReviewed ? 1 : 0.9;
  return Math.round(base * (1 + (complexity - 1) * 0.15) * evidence * outcome * reviewBoost);
}

function getMetrics(agent) {
  const runs = agent.runs || [];
  const completed = runs.filter(r => r.status === 'completed' || r.status === 'partial');
  const verified = runs.filter(r => r.verification === 'verified' && r.status === 'completed');
  const automated = runs.filter(r => r.trigger !== 'user');
  const autonomous = automated.filter(r => (r.humanInterventions || 0) === 0);
  const manual = runs.filter(r => r.trigger === 'user');
  const delegated = runs.filter(r => r.kind === 'delegated' || r.parentTaskId);
  const xp = runs.reduce((sum, r) => sum + (r.xpAwarded || 0), 0);
  return {
    xp,
    manual: Math.max(agent.manualActions || 0, manual.length),
    delegated: Math.max(agent.delegatedTasks || 0, delegated.length),
    automated: Math.max(agent.automatedRuns || 0, automated.length),
    completed: completed.length,
    verified: verified.length,
    successRate: completed.length ? Math.round((verified.length / completed.length) * 100) : 0,
    autonomyRate: automated.length ? Math.round((autonomous.length / automated.length) * 100) : 0,
    evidenceRate: completed.length ? Math.round((verified.length / completed.length) * 100) : 0,
    interventions: runs.reduce((sum, r) => sum + (r.humanInterventions || 0), 0),
    safetyIncidents: runs.reduce((sum, r) => sum + (r.safetyIncident ? 1 : 0), 0)
  };
}

function getLevel(metrics) {
  const current = LEVELS.reduce((acc, level) => {
    const qualifies = metrics.xp >= level.xp && metrics.manual >= level.manual && metrics.delegated >= level.delegated && metrics.automated >= level.automated;
    return qualifies ? level : acc;
  }, LEVELS[0]);
  const idx = LEVELS.indexOf(current);
  const next = idx >= 0 && idx < LEVELS.length - 1 ? LEVELS[idx + 1] : null;
  return {
    level: current.level,
    name: current.name,
    xp: current.xp,
    manual: current.manual,
    delegated: current.delegated,
    automated: current.automated,
    transition: current.transition || false,
    next: next
  };
}

module.exports = { LEVELS, XP, calculateXp, getMetrics, getLevel };
