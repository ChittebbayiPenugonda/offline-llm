#!/bin/zsh
# Double-click in Finder to launch Offline LLM. Works with no internet.
#
# The app starts LM Studio's server (and LM Studio itself, if needed) for you.
# Close the browser window, or this Terminal window, and it puts LM Studio back
# the way it was: models it loaded are unloaded, and the server/app are stopped
# if they weren't running before.
cd "$(dirname "$0")"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (one-time, needs internet)…"
  npm install || exit 1
fi

npm start
