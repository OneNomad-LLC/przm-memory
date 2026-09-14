#!/usr/bin/env bash
# Engram session-start hook — runs once when a Claude Code session starts,
# resumes, clears, or comes back from compaction.
#
# Prints what the session should know before its first message: handoffs other
# sessions addressed to this lane, the latest handoff or crash checkpoint from
# this lane, the standing procedural rules, the corrections and preferences the
# user has given, and memories about the current project. Claude Code adds a
# SessionStart hook's stdout to the session context, so none of this depends on
# the agent remembering to ask.
#
# The session id is passed along so the user-prompt hook does not announce the
# same inbox again on the first prompt.
#
# Quiet on any failure. A broken store must never block a session.

DATA_DIR="${PRZM_MEMORY_DATA_DIR:-${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-$HOME/.claude/przm-memory}}}"
PAYLOAD=$(cat 2>/dev/null || true)   # cwd is the process cwd

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/cli.js"
[ -f "$CLI" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

SESSION=$(printf '%s' "$PAYLOAD" | node -e '
  let p = {}; try { p = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
  process.stdout.write(p.session_id || "");
' 2>/dev/null)

if [ -n "$SESSION" ]; then
  PRZM_MEMORY_DATA_DIR="$DATA_DIR" node "$CLI" context --cwd "$PWD" --session "$SESSION" 2>/dev/null || true
else
  PRZM_MEMORY_DATA_DIR="$DATA_DIR" node "$CLI" context --cwd "$PWD" 2>/dev/null || true
fi
exit 0
