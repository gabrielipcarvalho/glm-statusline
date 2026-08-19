#!/usr/bin/env node
/**
 * First-party GLM statusline (replaces @wangjs-jacky/glm-coding-plan-statusline).
 * Shows: model, session effort (real, from Claude Code stdin), session tokens,
 * context %, 5h-credit window with countdown to reset, weekly credits used.
 * Data: stdin JSON (tokens/context/effort, real) + Z.ai quota endpoint (real metering).
 * Quota cache: 60s in ~/.cache/glm-statusline/quota.json (statusline redraws every 10s).
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_FILE = path.join(os.homedir(), '.cache', 'glm-statusline', 'quota.json');
const CACHE_TTL_MS = 60 * 1000;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const percentColor = (p) => (p < 50 ? C.green : p < 80 ? C.yellow : C.red);
const bar = (p, w = 8) => {
  // ceil + min-1-block: round() shows 0 filled blocks below 100/w % (empty-looking bar)
  const f = p <= 0 ? 0 : Math.min(w, Math.max(1, Math.ceil(p * w / 100)));
  return `${percentColor(p)}${'█'.repeat(f)}${'░'.repeat(w - f)}${C.reset}`;
};
const fmtTokens = (n) => {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};
const fmtCountdown = (ms) => {
  if (!ms || ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtResetDate = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
};
// Z.ai buckets Claude's 5 levels into low/high/max (docs.z.ai/devpack/latest-model)
const glmBucket = (e) => ({ low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', ultracode: 'max' }[e]);

function hostFromEnv() {
  const base = process.env.ANTHROPIC_BASE_URL || '';
  if (base.includes('bigmodel')) return 'open.bigmodel.cn';
  return 'api.z.ai';
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - j.fetchedAt < CACHE_TTL_MS) return Promise.resolve(j.data);
  } catch (_) { /* miss */ }
  return null;
}

function fetchQuota() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: hostFromEnv(),
      port: 443,
      path: '/api/monitor/usage/quota/limit',
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
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const limits = parsed?.data?.limits || parsed?.limits || [];
          fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
          fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), data: limits }));
          resolve(limits);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// Current API: CREDIT_LIMIT entries, unit 3 = hours (number 5 => 5h window),
// unit 6 = weeks (number 1 => weekly). Legacy: TOKENS_LIMIT = 5h, TIME_LIMIT = monthly MCP.
function classify(limits) {
  let fiveHour = null, weekly = null;
  for (const l of limits) {
    if (l.type === 'CREDIT_LIMIT') {
      if (l.unit === 3 && l.number === 5) fiveHour = l;
      if (l.unit === 6 && l.number === 1) weekly = l;
    } else if (l.type === 'TOKENS_LIMIT') {
      fiveHour = fiveHour || l;
    }
  }
  return { fiveHour, weekly };
}

async function main() {
  let stdin = '';
  await new Promise((r) => {
    process.stdin.on('data', (d) => { stdin += d; });
    process.stdin.on('end', r);
    setTimeout(r, 1000);
  });
  let ctx = {};
  try { ctx = JSON.parse(stdin); } catch (_) { /* render quota-only */ }
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(CACHE_FILE), 'last-stdin.json'), stdin);
  } catch (_) { /* debug dump only */ }

  const model = ctx?.model?.display_name || 'GLM';
  const cw = ctx?.context_window || {};
  const usage = cw.current_usage || {};
  const sessionTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const ctxPct = Math.round(cw.used_percentage || 0);

  // Effort: stdin sends {level: "..."} (verified live); tolerate a bare string.
  // Absent => Z.ai serves its default bucket (max) — mark with *.
  const effortRaw = ctx?.effort;
  const effort = (effortRaw && typeof effortRaw === 'object' ? effortRaw.level : effortRaw) || null;
  const bucket = effort ? glmBucket(effort) || effort : 'max';
  const effortLabel = effort
    ? `${C.magenta}${effort === bucket ? bucket : effort + '→' + bucket}${C.reset}`
    : `${C.magenta}max*${C.reset}`;

  const cached = readCache();
  const limits = cached ? await cached : await fetchQuota();
  const { fiveHour, weekly } = classify(limits);

  const parts = [
    `${C.cyan}${C.bold}${model}${C.reset}`,
    `⚡${effortLabel}`,
    `${C.dim}Sess:${fmtTokens(sessionTokens)}${C.reset}`,
    `Ctx ${bar(ctxPct, 6)} ${ctxPct}%`
      + (cw.context_window_size
        ? ` ${C.dim}(${fmtTokens(sessionTokens || Math.round(cw.context_window_size * ctxPct / 100))}/${fmtTokens(cw.context_window_size)})${C.reset}`
        : ''),
  ];

  if (fiveHour) {
    const pct = Math.round(fiveHour.percentage || 0);
    const left = fiveHour.nextResetTime ? fiveHour.nextResetTime - Date.now() : null;
    parts.push(`5H ${bar(pct, 6)} ${percentColor(pct)}${pct}% `
      + `${C.dim}(${Math.round(fiveHour.currentValue || 0)}/${Math.round(fiveHour.usage || 0)}) `
      + `↻ ${fmtCountdown(left)}${C.reset}`);
  }
  if (weekly) {
    const pct = Math.round(weekly.percentage || 0);
    const reset = fmtResetDate(weekly.nextResetTime);
    parts.push(`Wk ${bar(pct, 6)} ${percentColor(pct)}${pct}%${C.reset} `
      + `${C.dim}(${Math.round(weekly.currentValue || 0)}/${Math.round(weekly.usage || 0)})`
      + (reset ? ` (${reset})` : '') + `${C.reset}`);
  }

  // Second line: cwd (home abbreviated) + session name when set
  const rawDir = ctx?.workspace?.current_dir || ctx?.cwd || '';
  const dir = rawDir ? rawDir.replace(os.homedir(), '~') : '';
  const sessionName = (ctx?.session_name || '').trim();
  const line2 = [dir && `${C.dim}${dir}${C.reset}`, sessionName && `${C.blue}${sessionName}${C.reset}`]
    .filter(Boolean).join(' │ ');

  process.stdout.write(parts.join(' │ ') + (line2 ? `\n${line2}` : ''));
}

main();
