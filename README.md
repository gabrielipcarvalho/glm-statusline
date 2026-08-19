# glm-statusline

A status line for [Claude Code](https://code.claude.com/docs) sessions running on a **GLM Coding Plan** (Z.ai / BigModel via the Anthropic-compatible endpoint), showing real plan metering instead of fabricated numbers.

```
glm-5.3 │ ⚡medium→high │ Sess:665.5K │ Ctx █████░ 68% (665.5K/1.0M) │ 5H █░░░░░ 9% (1118/12000) ↻ 4h32m │ Wk █░░░░░ 3% (2038/60000) (Aug 26 15:19)
~/Projects/my-app │ my session name
```

## Why this exists

Two data problems hit every GLM Coding Plan user in Claude Code at once:

1. **Claude Code's cost figures are fiction on GLM.** `total_cost_usd` (and therefore the cost widget of any status line that renders it) is computed client-side from a bundled *Anthropic* price table. A 27.6k-input / 3-output GLM call reports ~$0.145 at Opus-tier rates. The plan meters credits, not USD, so a dollar figure is the wrong unit entirely.
2. **The quota API changed shape.** Z.ai moved `GET /api/monitor/usage/quota/limit` to credit-metered `CREDIT_LIMIT` entries. Community status lines that parse the legacy `TIME_LIMIT` / `TOKENS_LIMIT` types now silently render `0%` forever. This tool speaks the current shape:

   | `unit` | `number` | meaning |
   |---|---|---|
   | `3` | `5` | 5-hour credit window |
   | `6` | `1` | weekly credit window |

   Each entry carries `currentValue`, `usage` (cap), `percentage`, and `nextResetTime` (epoch ms). If Z.ai reshapes the API again, `classify()` in `glm-statusline.js` is the single function to update.

## What it shows

| Widget | Source | Notes |
|---|---|---|
| Model | Claude Code stdin | display name |
| Effort `⚡medium→high` | Claude Code stdin + Z.ai mapping | session effort and the Z.ai bucket it lands in; Z.ai collapses Claude's five levels into `low / high / max` (their default is `max`, shown as `max*` when unset) |
| Session tokens | Claude Code stdin | input + output + cache, real usage from the GLM endpoint |
| Context `bar % (used/size)` | Claude Code stdin | used = live window contents over declared window size |
| 5H `bar % (cur/cap) ↻ countdown` | Z.ai quota endpoint | credits used in the 5-hour window, countdown to reset |
| Wk `bar % (cur/cap) (reset date)` | Z.ai quota endpoint | weekly credits, absolute reset date/time |
| Line 2: dir + session name | Claude Code stdin | `$HOME` abbreviated to `~`; session name shown when set |

No cost figure is displayed, deliberately: there is no true dollar number to show.

## Install

Requires: Node.js >= 16, a GLM Coding Plan key set as `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` pointing at `https://api.z.ai/api/anthropic` (or the BigModel equivalent).

```bash
git clone https://github.com/gabrielipcarvalho/glm-statusline.git ~/.config/ccstatusline-repo  # anywhere works
```

Then point Claude Code at the wrapper (`~/.claude/settings.json`), adjusting the path to where you cloned:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /path/to/glm-statusline/glm-aware.sh"
  }
}
```

`glm-aware.sh` routes by `ANTHROPIC_BASE_URL`: GLM sessions get `glm-statusline.js`, everything else falls through to [ccstatusline](https://github.com/sirmalloc/ccstatusline) unchanged. If you only ever run GLM, wire `glm-statusline.js` directly and skip the wrapper.

Quota is fetched at most once per 60 seconds and cached in `~/.cache/glm-statusline/quota.json`, so Claude Code's 10-second status line refresh never hammers the endpoint.

## Notes

- The quota request reads `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from the environment Claude Code passes to the status line process. No key is stored anywhere by this tool.
- `classify()` also accepts the legacy `TOKENS_LIMIT` shape as a fallback.
- The last payload Claude Code sent is dumped to `~/.cache/glm-statusline/last-stdin.json`, handy for seeing what other fields are available.

## License

[MIT](LICENSE)
