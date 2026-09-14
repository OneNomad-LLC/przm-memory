/**
 * Lanes.
 *
 * One machine can run Claude Code under more than one config directory (a personal
 * `~/.claude` and a work `~/.claude-work`, say), and every one of those sessions reads
 * and writes the same store. Before lanes, a work session opened on a personal
 * session's crash checkpoint and the other way round. A lane is the name of the config
 * directory a session runs under, and handoffs and checkpoints stay inside their lane
 * unless a handoff is addressed across to another one.
 *
 * `hooks/lane.sh` computes the same name in bash for the hooks; tests/lane.test.ts
 * holds the two to each other.
 */

import { basename } from 'node:path';

const DEFAULT_LANE = 'claude';

export function normalizeLane(raw: string): string {
  const lane = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return lane || DEFAULT_LANE;
}

/** `~/.claude` is "claude", `~/.claude-work` is "claude-work", unset is "claude". */
export function laneFromConfigDir(configDir: string | undefined): string {
  const dir = configDir?.trim().replace(/\/+$/, '');
  if (!dir) return DEFAULT_LANE;
  return normalizeLane(basename(dir).replace(/^\.+/, ''));
}

export function currentLane(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PRZM_MEMORY_LANE?.trim();
  if (override) return normalizeLane(override);
  return laneFromConfigDir(env.CLAUDE_CONFIG_DIR);
}

/** The working directory's name, which is also how project memories are keyed. */
export function projectOf(cwd: string | undefined): string {
  if (!cwd) return '';
  const p = basename(cwd).toLowerCase();
  return p === '/' || p === '.' ? '' : p;
}
