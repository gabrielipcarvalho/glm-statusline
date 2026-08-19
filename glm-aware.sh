#!/usr/bin/env bash
# Model-aware Claude Code status line.
#   GLM (z.ai / bigmodel.cn) sessions -> glm-statusline.js: real GLM quota + effort + context.
#   Everything else                   -> ccstatusline, unchanged.
# Resolve through symlinks so this works no matter where the repo is cloned.
script_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
input="$(cat)"
case "${ANTHROPIC_BASE_URL:-}" in
  *z.ai*|*bigmodel*)
    printf '%s' "$input" | node "$script_dir/glm-statusline.js"
    ;;
  *)
    printf '%s' "$input" | bunx -y ccstatusline@latest
    ;;
esac
