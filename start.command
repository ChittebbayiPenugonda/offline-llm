#!/bin/zsh
# Double-click in Finder to launch Offline LLM. Works with no internet.
cd "$(dirname "$0")"

LMS="$HOME/.lmstudio/bin/lms"
if [[ -x "$LMS" ]]; then
  "$LMS" server start >/dev/null 2>&1 && echo "✓ LM Studio server running"
else
  echo "! lms CLI not found — open LM Studio once so it installs it."
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (one-time, needs internet)…"
  npm install || exit 1
fi

npm start
