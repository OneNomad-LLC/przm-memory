#!/usr/bin/env bash
# Engram stop hook — runs after every assistant turn.
#
# Behavior (autonomous):
#  - Writes a lightweight mechanical "session checkpoint" handoff to disk
#    so there is ALWAYS a fresh lifeline if the context window fills before
#    /compact can run. Cheap: single transcript read, no LLM.
#  - Never blocks. The old every-10-messages block was a nag that could
#    interrupt flow; Claude's MCP instructions already push proactive
#    memory-ingest / memory-kg-add / persona_signal calls.
#
# Each session keeps its own checkpoint at handoffs/checkpoints/<session>.json,
# tagged with its lane (see hooks/lane.sh) and project. Before 1.6.0 every
# session on the machine overwrote one shared session-checkpoint.json, so a
# session could resume from another account's work; that file is removed here.
# Checkpoints and announcement records older than two weeks are pruned.

DATA_DIR="${PRZM_MEMORY_DATA_DIR:-${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-$HOME/.claude/przm-memory}}}"

# Capture the Claude Code payload: { session_id, transcript_path, cwd, stop_hook_active }.
PAYLOAD=$(cat 2>/dev/null || true)

# shellcheck source=lane.sh
. "$(dirname "${BASH_SOURCE[0]}")/lane.sh" 2>/dev/null
LANE="$(przm_lane 2>/dev/null || printf 'claude')"

ENGRAM_DATA_DIR="$DATA_DIR" \
CC_PAYLOAD="$PAYLOAD" \
PRZM_LANE="$LANE" \
node -e "
  (() => {
    const fs = require('fs');
    const path = require('path');

    let payload = {};
    try { payload = JSON.parse(process.env.CC_PAYLOAD || '{}'); } catch {}
    const transcriptPath = payload.transcript_path;
    const sessionId = payload.session_id;
    if (!transcriptPath || !sessionId || !fs.existsSync(transcriptPath)) return;

    const handoffDir = path.join(process.env.ENGRAM_DATA_DIR, 'handoffs');
    const checkpointDir = path.join(handoffDir, 'checkpoints');
    const safeSession = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const checkpointPath = path.join(checkpointDir, safeSession + '.json');
    const cwd = payload.cwd || process.cwd();
    const project = (path.basename(cwd) || '').toLowerCase();

    let lines;
    try {
      lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    } catch { return; }

    const userMsgs = [];
    const fileSet = new Set();
    const writeSet = new Set();
    const commits = [];
    let lastAssistantText = '';

    for (const l of lines) {
      let obj;
      try { obj = JSON.parse(l); } catch { continue; }
      if (obj.type === 'user') {
        const c = obj.message && obj.message.content;
        if (Array.isArray(c) && c.some(p => p && p.type === 'tool_result')) continue;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
            : '';
        if (text.trim()) userMsgs.push(text.trim());
      } else if (obj.type === 'assistant') {
        const c = obj.message && obj.message.content;
        if (!Array.isArray(c)) continue;
        for (const p of c) {
          if (p && p.type === 'text' && p.text) lastAssistantText = p.text;
          if (p && p.type === 'tool_use') {
            const name = p.name || '';
            const input = p.input || {};
            if (name === 'Read' && input.file_path) fileSet.add(input.file_path);
            else if ((name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && input.file_path) {
              fileSet.add(input.file_path);
              writeSet.add(input.file_path);
            } else if (name === 'Bash' && typeof input.command === 'string') {
              // Two shapes: a plain -m message, and a message piped in from a heredoc, where
              // the subject is the first line after the EOF opener. The old regex reported the
              // literal command-substitution text from the second shape as the commit.
              let m = input.command.match(/git\s+commit[^\n]*<<\s*['\"]?EOF['\"]?\s*\n([^\n]+)/);
              if (!m) m = input.command.match(/git\s+commit[^\"']*-m\s+[\"']([^\"'$][^\"']*)[\"']/);
              if (m) commits.push(m[1].split(/\\n|\n/)[0].slice(0, 120));
            }
          }
        }
      }
    }

    const checkpoint = {
      timestamp: new Date().toISOString(),
      sessionId,
      reason: 'context-pressure',
      lane: process.env.PRZM_LANE || 'claude',
      ...(project && project !== '/' && project !== '.' ? { project } : {}),
      currentTask: userMsgs.length ? userMsgs[userMsgs.length - 1].split('\n')[0].slice(0, 200) : '',
      completed: [...writeSet].slice(-20).map(f => 'edited ' + f),
      nextSteps: [],
      openQuestions: [],
      fileRefs: [...fileSet].slice(-30),
      decisions: commits.slice(-10).map(m => 'commit: ' + m),
      notes:
        'Rolling checkpoint for this session from engram_stop_hook.sh. Mechanical ' +
        'extraction — overwritten on every assistant turn. If /compact ' +
        'never ran, this is the freshest lifeline. Tool-distilled handoffs ' +
        '(via memory-handoff-write) live one folder up as timestamped entries.' +
        (lastAssistantText ? '\n\nLast assistant note: ' +
          lastAssistantText.trim().split('\n').slice(-3).join(' ').slice(0, 300) : ''),
    };

    try {
      if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(checkpointPath + '.tmp', JSON.stringify(checkpoint, null, 2), 'utf8');
      fs.renameSync(checkpointPath + '.tmp', checkpointPath);
    } catch { /* non-fatal — approve regardless */ }

    // The shared pre-1.6 checkpoint, and per-session records nobody has touched in two weeks.
    try { fs.rmSync(path.join(handoffDir, 'session-checkpoint.json'), { force: true }); } catch {}
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const dir of [checkpointDir, path.join(handoffDir, 'announced')]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
        }
      } catch {}
    }
  })();
" 2>/dev/null

# Grade any memory-search results that have had a few turns to prove themselves. This is the
# recall feedback loop that used to depend on the agent calling memory-outcome, which it never
# did. Backgrounded so the hook returns at once; the CLI opens storage only when there is
# something new to record.
CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/cli.js"
if [ -f "$CLI" ] && command -v node >/dev/null 2>&1; then
  read -r TRANSCRIPT SESSION < <(printf '%s' "$PAYLOAD" | node -e '
    let p = {}; try { p = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
    process.stdout.write((p.transcript_path || "") + " " + (p.session_id || ""));
  ' 2>/dev/null)
  if [ -n "$TRANSCRIPT" ] && [ -n "$SESSION" ]; then
    PRZM_MEMORY_DATA_DIR="$DATA_DIR" nohup node "$CLI" grade --transcript "$TRANSCRIPT" --session "$SESSION" >/dev/null 2>&1 &
  fi
fi

# Always approve — never interrupt the user's flow with a block.
echo '{"decision":"approve"}'
