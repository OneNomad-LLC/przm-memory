#!/usr/bin/env bash
# Sourced by the hooks. Prints the session's lane: the name of the Claude Code config
# directory it runs under, so ~/.claude is "claude" and ~/.claude-work is "claude-work".
# Must agree with laneFromConfigDir and currentLane in src/lane.ts; tests/lane.test.ts
# runs both over the same inputs.

przm_lane() {
  local raw="${PRZM_MEMORY_LANE:-}"
  if [ -z "$(printf '%s' "$raw" | tr -d '[:space:]')" ]; then
    local dir
    dir="$(printf '%s' "${CLAUDE_CONFIG_DIR:-}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s#/+$##')"
    if [ -z "$dir" ]; then
      printf 'claude'
      return
    fi
    raw="$(basename "$dir")"
    raw="$(printf '%s' "$raw" | sed -E 's/^\.+//')"
  fi
  raw="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g')"
  if [ -n "$raw" ]; then printf '%s' "$raw"; else printf 'claude'; fi
}
