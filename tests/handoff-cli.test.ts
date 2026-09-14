/**
 * Handoff commands.
 *
 * The user-prompt hook runs `inbox --new` before every prompt. It must tell a
 * session about a handoff once, count session start as telling, and stay silent
 * otherwise, or the same request lands in the context on every turn.
 *
 * Run: `npm test` or `node --import tsx --test tests/handoff-cli.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { announceNew, main, markAnnounced } from '../src/handoff-cli.js';
import { listInbox, writeHandoff } from '../src/handoff.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-handoff-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function send(dir: string, task: string) {
  return writeHandoff(dir, {
    sessionId: null, reason: 'manual', currentTask: task, completed: [], nextSteps: [], openQuestions: [], fileRefs: [], decisions: [], notes: '',
    lane: 'claude', project: 'pryzm-ai-poc', to: 'claude-work',
  });
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe('inbox --new', () => {
  it('tells a session about a handoff once, then stays silent', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const first = send(dir, 'push the branch');
      const text = announceNew(dir, 'claude-work', 'session-1');
      assert.match(text, /## New handoff for lane claude-work/);
      assert.match(text, new RegExp(first.stamp));
      assert.match(text, /from claude\/pryzm-ai-poc/);
      assert.equal(announceNew(dir, 'claude-work', 'session-1'), '');
      assert.match(announceNew(dir, 'claude-work', 'session-2'), /push the branch/, 'another session is told separately');

      send(dir, 'open the PR');
      const later = announceNew(dir, 'claude-work', 'session-1');
      assert.match(later, /open the PR/);
      assert.doesNotMatch(later, /push the branch/);
    } finally {
      cleanup();
    }
  });

  it('counts session start as telling', () => {
    const { dir, cleanup } = tmpDir();
    try {
      send(dir, 'push the branch');
      markAnnounced(dir, 'session-1', listInbox(dir, 'claude-work').map(e => e.stamp));
      assert.equal(announceNew(dir, 'claude-work', 'session-1'), '');
    } finally {
      cleanup();
    }
  });

  it('says nothing to the lane that sent it', () => {
    const { dir, cleanup } = tmpDir();
    try {
      send(dir, 'push the branch');
      assert.equal(announceNew(dir, 'claude', 'session-1'), '');
    } finally {
      cleanup();
    }
  });
});

describe('handoff commands', () => {
  it('sends from the current lane, lists the inbox, and acks from the addressed lane', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      let out = '';
      let err = '';
      const capture = (s: string) => { out += s; };
      const capErr = (s: string) => { err += s; };

      await withEnv({ PRZM_MEMORY_DATA_DIR: dir, PRZM_MEMORY_LANE: 'claude' }, async () => {
        assert.equal(await main(['handoff', 'send', '--to', 'claude-work', '--task', 'push the branch', '--next', 'rebase onto stage'], capture, capErr), 0);
      });
      const stamp = /Sent (\S+) from claude to claude-work/.exec(out)?.[1];
      assert.ok(stamp, out);

      out = '';
      await withEnv({ PRZM_MEMORY_DATA_DIR: dir, PRZM_MEMORY_LANE: 'claude-work' }, async () => {
        assert.equal(await main(['inbox', '--format', 'json'], capture, capErr), 0);
        const parsed = JSON.parse(out) as { lane: string; handoffs: { stamp: string }[] };
        assert.equal(parsed.lane, 'claude-work');
        assert.deepEqual(parsed.handoffs.map(h => h.stamp), [stamp]);

        assert.equal(await main(['handoff', 'ack', stamp!, '--lane', 'claude'], capture, capErr), 1, 'the sender cannot ack its own message');
        assert.match(err, /not|No handoff/);
        assert.equal(await main(['handoff', 'ack', stamp!], capture, capErr), 0);
      });
      assert.equal(listInbox(dir, 'claude-work').length, 0);
    } finally {
      cleanup();
    }
  });

  it('refuses a send without a lane or a task', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      let err = '';
      await withEnv({ PRZM_MEMORY_DATA_DIR: dir }, async () => {
        assert.equal(await main(['handoff', 'send', '--task', 'no lane'], () => {}, s => { err += s; }), 2);
      });
      assert.match(err, /needs --to/);
    } finally {
      cleanup();
    }
  });
});
