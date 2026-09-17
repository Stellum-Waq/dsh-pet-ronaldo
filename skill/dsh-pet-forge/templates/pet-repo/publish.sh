#!/usr/bin/env bash
# =============================================================================
# 把这份宠物包发布到 GitHub。
#
#   ./publish.sh              # init + commit + push
#   ./publish.sh --no-push    # 只 init + commit
#   REMOTE=<url> ./publish.sh # 指定/覆盖 origin
#
# 本脚本只在自己所在目录里跑 git。插件**不会**替你执行它 —— 发布永远是作者的显式动作。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="${REMOTE:-{{repo}}}"
MESSAGE="${MESSAGE:-pet: {{name}} (DPSL-1.0)}"
PUSH=1
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    --remote=*) REMOTE="${arg#--remote=}" ;;
  esac
done

if [ ! -d .git ]; then
  echo "[1/4] git init"
  git init >/dev/null
  git branch -M main
fi

echo "[2/4] staging"
git add -A

echo "[3/4] committing"
if [ -n "$(git status --porcelain)" ]; then
  git commit -m "$MESSAGE"
else
  echo "      nothing to commit"
fi

if [ -n "$REMOTE" ] && [[ "$REMOTE" != *"owner/repo"* ]]; then
  cur="$(git remote get-url origin 2>/dev/null || true)"
  if [ "$cur" != "$REMOTE" ]; then
    if [ -n "$cur" ]; then git remote set-url origin "$REMOTE"; else git remote add origin "$REMOTE"; fi
    echo "      origin -> $REMOTE"
  fi
else
  echo "      no remote configured (REMOTE=https://github.com/you/your-repo ./publish.sh)"
fi

if [ "$PUSH" = "0" ]; then
  echo "[4/4] skipped push (--no-push)"
  exit 0
fi

echo "[4/4] pushing"
git push -u origin main

cat <<'EOF'

完成。还剩两件事：
  1. 给仓库加上 topic「{{topic}}」（About → ⚙️ → Topics）—— 这是插件发现你的唯一依据；
  2. 回插件：设置 → ⚽ 桌宠 → 🌐 宠物社区 → 刷新。
EOF
