#!/usr/bin/env node
/**
 * glm-statusline — first-party statusline for Claude Code on a GLM Coding Plan
 * (Z.ai / BigModel via the Anthropic-compatible endpoint).
 *
 * Philosophy: every segment shows REAL data — either Claude Code's stdin payload
 * (tokens, context, effort, duration), the session transcript (cumulative usage,
 * speed, compactions), Z.ai's monitor endpoints (credit windows, day/month
 * tokens), or the local system (git, RAM). No dollar figures: Claude Code's
 * total_cost_usd is client-side Anthropic pricing, fiction on GLM.
 *
 * Hide segments:   GLM_SL_HIDE="git,ram,speed"   (comma-separated)
 * Segment keys:    model effort duration git credits inout speed ctx 5h wk
 *                  daymon cache compactions ram dir session
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'glm-statusline');
const CACHE_TTL_MS = 60 * 1000;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const percentColor = (p) => (p < 50 ? C.green : p < 80 ? C.yellow : C.red);
const ramColor = (p) => (p < 70 ? C.green : p < 85 ? C.yellow : C.red);
const bar = (p, w = 6) => {
  const f = p <= 0 ? 0 : Math.min(w, Math.max(1, Math.ceil(p * w / 100)));
  return `${percentColor(p)}${'█'.repeat(f)}${'░'.repeat(w - f)}${C.reset}`;
};
const fmtTokens = (n) => {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
const fmtCountdown = (ms) => {
  if (!ms || ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
};
const fmtDuration = (ms) => {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtResetDate = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// Z.ai buckets Claude's levels into low/high/max (docs.z.ai/devpack/latest-model)
const glmBucket = (e) => ({ low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultracode: 'max' }[e]);

const HIDE = new Set((process.env.GLM_SL_HIDE || '').split(',').map((s) => s.trim()).filter(Boolean));
const show = (k) => !HIDE.has(k);

/* ---------- Z.ai monitor endpoints (cached 60s) ---------- */

function hostFromEnv() {
  const base = process.env.ANTHROPIC_BASE_URL || '';
  if (base.includes('bigmodel')) return 'open.bigmodel.cn';
  return 'api.z.ai';
}

function apiGet(pathname) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: hostFromEnv(),
      port: 443,
      path: pathname,
      method: 'GET',
      headers: {
        Authorization: process.env.ANTHROPIC_AUTH_TOKEN || '',
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Current shape: CREDIT_LIMIT entries, unit 3/number 5 = 5h window, unit 6/number 1 = weekly.
// Legacy TOKENS_LIMIT kept as fallback. If bars go dead, this is the function to fix.
function classifyLimits(limits) {
  let fiveHour = null, weekly = null;
  for (const l of limits || []) {
    if (l.type === 'CREDIT_LIMIT') {
      if (l.unit === 3 && l.number === 5) fiveHour = l;
      if (l.unit === 6 && l.number === 1) weekly = l;
    } else if (l.type === 'TOKENS_LIMIT') {
      fiveHour = fiveHour || l;
    }
  }
  return { fiveHour, weekly };
}

function pad2(n) { return String(n).padStart(2, '0'); }
const localDateTime = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

async function fetchApiData() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const qs = `?startTime=${encodeURIComponent(localDateTime(monthStart))}&endTime=${encodeURIComponent(localDateTime(now))}`;
  const [quota, usage] = await Promise.all([
    apiGet('/api/monitor/usage/quota/limit'),
    apiGet(`/api/monitor/usage/model-usage${qs}`),
  ]);

  const out = { fiveHour: null, weekly: null, day: null, month: null };
  const limits = quota?.data?.limits || quota?.limits || [];
  ({ fiveHour: out.fiveHour, weekly: out.weekly } = classifyLimits(limits));

  // model-usage returns per-hour series: x_time[] ("YYYY-MM-DD HH:mm:ss" or ISO) + tokensUsage[]
  const times = usage?.data?.x_time || [];
  const tokens = usage?.data?.tokensUsage || [];
  const today = now.toISOString().slice(0, 10);
  const todayLocal = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  let day = 0, month = 0;
  for (let i = 0; i < times.length; i++) {
    month += tokens[i] || 0;
    if (times[i] && (times[i].startsWith(today) || times[i].startsWith(todayLocal))) day += tokens[i] || 0;
  }
  out.day = day; out.month = month;

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'api.json'), JSON.stringify({ fetchedAt: Date.now(), data: out }));
  } catch (_) { /* cache write best-effort */ }
  return out;
}

async function loadApiData() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'api.json'), 'utf8'));
    if (Date.now() - j.fetchedAt < CACHE_TTL_MS) return j.data;
  } catch (_) { /* miss */ }
  return fetchApiData();
}

/* ---------- session credits burned (snapshot delta of the 5h window) ---------- */

function sessionCredits(sessionId, current5h) {
  if (!sessionId || current5h == null) return null;
  const file = path.join(CACHE_DIR, 'sessions.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* fresh */ }
  const now = Date.now();
  for (const k of Object.keys(map)) if (now - map[k].ts > 30 * 86400e3) delete map[k]; // prune
  let snap = map[sessionId];
  if (!snap || current5h < snap.start) snap = map[sessionId] = { start: current5h, ts: now };
  snap.ts = now;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
  } catch (_) { /* best-effort */ }
  const burned = current5h - snap.start;
  return burned >= 0 ? burned : 0;
}

/* ---------- transcript metrics (mtime-guarded) ---------- */

function transcriptMetrics(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const stat = fs.statSync(transcriptPath);
  const cacheFile = path.join(CACHE_DIR, `tr-${stat.ino}.json`);
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j.mtimeMs === stat.mtimeMs && j.size === stat.size) return j.metrics;
  } catch (_) { /* miss */ }

  const m = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, compactions: 0, recentOut: 0 };
  const cutoff = Date.now() - 60 * 1000;
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"isCompactSummary":true')) m.compactions++;
    const idx = line.indexOf('"type":"assistant"');
    if (idx === -1) continue;
    try {
      const d = JSON.parse(line);
      const u = d?.message?.usage;
      if (!u) continue;
      m.in += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      m.out += u.output_tokens || 0;
      m.cacheRead += u.cache_read_input_tokens || 0;
      m.cacheWrite += u.cache_creation_input_tokens || 0;
      if (d.timestamp && new Date(d.timestamp).getTime() > cutoff) m.recentOut += u.output_tokens || 0;
    } catch (_) { /* skip malformed line */ }
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ mtimeMs: stat.mtimeMs, size: stat.size, metrics: m }));
  } catch (_) { /* best-effort */ }
  return m;
}

/* ---------- local system ---------- */

function gitInfo(cwd) {
  if (!cwd) return null;
  try {
    const branch = execSync('git --no-optional-locks rev-parse --abbrev-ref HEAD', { cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    let dirty = null;
    try {
      dirty = execSync('git --no-optional-locks status --porcelain', { cwd, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split('\n').filter(Boolean).length;
    } catch (_) { /* dirty unknown */ }
    return { branch, dirty };
  } catch (_) { return null; }
}

function ramPercent() {
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = /MemTotal:\s+(\d+) kB/.exec(mi);
    const avail = /MemAvailable:\s+(\d+) kB/.exec(mi);
    if (!total || !avail) return null;
    return Math.round((1 - avail[1] / total[1]) * 100);
  } catch (_) { return null; }
}

/* ---------- main ---------- */

async function main() {
  let stdin = '';
  await new Promise((r) => {
    process.stdin.on('data', (d) => { stdin += d; });
    process.stdin.on('end', r);
    setTimeout(r, 1000);
  });
  let ctx = {};
  try { ctx = JSON.parse(stdin); } catch (_) { /* render what we can */ }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'last-stdin.json'), stdin);
  } catch (_) { /* debug dump only */ }

  const model = ctx?.model?.display_name || 'GLM';
  const cw = ctx?.context_window || {};
  const usage = cw.current_usage || {};
  const windowTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const ctxPct = Math.round(cw.used_percentage || 0);

  const tr = transcriptMetrics(ctx?.transcript_path);

  const effortRaw = ctx?.effort;
  const effort = (effortRaw && typeof effortRaw === 'object' ? effortRaw.level : effortRaw) || null;
  const bucket = effort ? glmBucket(effort) || effort : 'max';

  const api = await loadApiData();
  const seg1 = [], seg2 = [], seg3 = [];

  /* line 1: identity + session */
  if (show('model')) seg1.push(`${C.cyan}${C.bold}${model}${C.reset}`);
  if (show('effort')) {
    seg1.push(`⚡ ${C.magenta}${effort ? (effort === bucket ? bucket : effort + '→' + bucket) : 'max*'}${C.reset}`);
  }
  if (show('duration') && ctx?.cost?.total_duration_ms) {
    seg1.push(`${C.dim}⏱ ${fmtDuration(ctx.cost.total_duration_ms)}${C.reset}`);
  }
  if (show('git')) {
    const g = gitInfo(ctx?.workspace?.current_dir || ctx?.cwd);
    if (g) seg1.push(`${C.green}${g.branch}${g.dirty ? C.yellow + ' *' + (g.dirty > 0 ? C.dim + g.dirty : '') : ''}${C.reset}`);
  }
  if (show('credits')) {
    const burned = sessionCredits(ctx?.session_id, api?.fiveHour?.currentValue);
    if (burned != null) seg1.push(`${C.blue}⛁ ${fmtTokens(burned)} cr${C.reset}`);
  }
  if (show('inout') && tr) {
    seg1.push(`${C.dim}In ${fmtTokens(tr.in)}${C.reset}`);
    seg1.push(`${C.dim}Out ${fmtTokens(tr.out)}${C.reset}`);
  }
  if (show('speed') && tr && tr.recentOut > 0) {
    seg3.push(`${C.dim}${tr.recentOut} t/m${C.reset}`);
  }

  /* line 2: bars */
  if (show('ctx')) {
    seg2.push(`Ctx ${bar(ctxPct)} ${ctxPct}%`
      + (cw.context_window_size ? ` ${C.dim}(${fmtTokens(windowTokens || Math.round(cw.context_window_size * ctxPct / 100))}/${fmtTokens(cw.context_window_size)})${C.reset}` : ''));
  }
  if (show('5h') && api?.fiveHour) {
    const pct = Math.round(api.fiveHour.percentage || 0);
    const left = api.fiveHour.nextResetTime ? api.fiveHour.nextResetTime - Date.now() : null;
    seg2.push(`5H ${bar(pct)} ${percentColor(pct)}${pct}%${C.reset} `
      + `${C.dim}(${Math.round(api.fiveHour.currentValue || 0)}/${Math.round(api.fiveHour.usage || 0)}) ↻ ${fmtCountdown(left)}${C.reset}`);
  }
  if (show('wk') && api?.weekly) {
    const pct = Math.round(api.weekly.percentage || 0);
    const reset = fmtResetDate(api.weekly.nextResetTime);
    seg2.push(`Wk ${bar(pct)} ${percentColor(pct)}${pct}%${C.reset} `
      + `${C.dim}(${Math.round(api.weekly.currentValue || 0)}/${Math.round(api.weekly.usage || 0)})`
      + (reset ? ` (${reset})` : '') + `${C.reset}`);
  }
  if (show('daymon') && api) {
    const parts = [];
    if (api.day) parts.push(`${C.dim}Day ${fmtTokens(api.day)}${C.reset}`);
    if (api.month) parts.push(`${C.blue}Mon ${fmtTokens(api.month)}${C.reset}`);
    if (parts.length) seg2.push(parts.join(' '));
  }

  /* line 3: extras */
  if (show('cache') && tr && tr.in > 0) {
    const hit = Math.round((tr.cacheRead / tr.in) * 100);
    seg3.push(`${C.dim}⌁ cache ${hit}%${C.reset}`);
  }
  if (show('compactions') && tr && tr.compactions > 0) {
    seg3.push(`${C.magenta}⌘ ${tr.compactions}${C.reset}`);
  }
  if (show('ram')) {
    const ram = ramPercent();
    if (ram != null) seg3.push(`${ramColor(ram)}RAM ${ram}%${C.reset}`);
  }
  const rawDir = ctx?.workspace?.current_dir || ctx?.cwd || '';
  const dir = rawDir ? rawDir.replace(os.homedir(), '~') : '';
  if (show('dir') && dir) seg3.push(`${C.dim}${dir}${C.reset}`);
  const sessionName = (ctx?.session_name || '').trim();
  if (show('session') && sessionName) seg3.push(`${C.blue}${sessionName}${C.reset}`);

  const lines = [seg1, seg2, seg3].filter((s) => s.length);
  process.stdout.write(lines.map((s) => s.join(' │ ')).join('\n'));
}

main();
