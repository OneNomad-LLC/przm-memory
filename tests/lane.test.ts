/**
 * Lanes.
 *
 * The MCP server names a session's lane in TypeScript and the hooks name it in bash.
 * If the two ever disagree, a checkpoint lands in one lane and session start looks
 * for it in another, so both run over the same inputs here.
 *
 * Run: `npm test` or `node --import tsx --test tests/lane.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { currentLane, laneFromConfigDir, normalizeLane, projectOf } from '../src/lane.js';

const LANE_SH = join(import.meta.dirname, '..', 'hooks', 'lane.sh');

function bashLane(env: Record<string, string | undefined>): string {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/someone' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return execFileSync('bash', ['-c', `source "${LANE_SH}"; przm_lane`], { env: clean, encoding: 'utf8' });
}

const CASES: { label: string; env: Record<string, string | undefined>; lane: string }[] = [
  { label: 'unset config dir', env: {}, lane: 'claude' },
  { label: 'default config dir', env: { CLAUDE_CONFIG_DIR: '/home/someone/.claude' }, lane: 'claude' },
  { label: 'work config dir', env: { CLAUDE_CONFIG_DIR: '/home/someone/.claude-work' }, lane: 'claude-work' },
  { label: 'trailing slashes', env: { CLAUDE_CONFIG_DIR: '/home/someone/.claude-work//' }, lane: 'claude-work' },
  { label: 'no leading dot, mixed case', env: { CLAUDE_CONFIG_DIR: '/opt/Claude Client' }, lane: 'claude-client' },
  { label: 'empty config dir', env: { CLAUDE_CONFIG_DIR: '' }, lane: 'claude' },
  { label: 'override wins', env: { CLAUDE_CONFIG_DIR: '/home/someone/.claude-work', PRZM_MEMORY_LANE: 'Night Shift' }, lane: 'night-shift' },
  { label: 'blank override is ignored', env: { CLAUDE_CONFIG_DIR: '/home/someone/.claude-work', PRZM_MEMORY_LANE: '  ' }, lane: 'claude-work' },
];

describe('lane naming', () => {
  for (const c of CASES) {
    it(`TypeScript and bash agree: ${c.label}`, () => {
      assert.equal(currentLane(c.env as NodeJS.ProcessEnv), c.lane);
      assert.equal(bashLane(c.env), c.lane);
    });
  }

  it('normalizes lanes given by hand', () => {
    assert.equal(normalizeLane('  Claude-Work '), 'claude-work');
    assert.equal(normalizeLane('***'), '-');
    assert.equal(normalizeLane(''), 'claude');
    assert.equal(laneFromConfigDir('/x/.claude-work'), 'claude-work');
  });

  it('takes the project from the working directory name', () => {
    assert.equal(projectOf('/Users/someone/development/Pryzm-AI-POC'), 'pryzm-ai-poc');
    assert.equal(projectOf(undefined), '');
    assert.equal(projectOf('/'), '');
  });
});
