/**
 * Handoff / named checkpoint tests.
 *
 * Covers the named-checkpoint extension: write with name, list returns name,
 * read by name resolves the newest match, read by stamp still works, and
 * unknown identifiers surface as null.
 *
 * Run: `npm test` or `node --import tsx --test tests/handoff.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeHandoff, readHandoff, listHandoffs, listInbox, ackHandoff, readLatestCheckpoint, checkpointDir } from '../src/handoff.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-handoff-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseNote(overrides: Partial<Parameters<typeof writeHandoff>[1]> = {}) {
  return {
    sessionId: null,
    reason: 'manual' as const,
    currentTask: 'test task',
    completed: [],
    nextSteps: [],
    openQuestions: [],
    fileRefs: [],
    decisions: [],
    notes: '',
    ...overrides,
  };
}

describe('handoff named checkpoints', () => {
  it('writes and round-trips a named checkpoint', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const written = writeHandoff(dir, baseNote({ name: 'pyre-auth-flow', currentTask: 'wire device-code login' }));
      assert.equal(written.name, 'pyre-auth-flow');

      const loaded = readHandoff(dir, 'pyre-auth-flow');
      assert.ok(loaded);
      assert.equal(loaded.name, 'pyre-auth-flow');
      assert.equal(loaded.currentTask, 'wire device-code login');
    } finally {
      cleanup();
    }
  });

  it('list returns the user-facing name on entries that have one', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ name: 'feature-a', currentTask: 'a' }));
      writeHandoff(dir, baseNote({ currentTask: 'unnamed' }));
      writeHandoff(dir, baseNote({ name: 'feature-b', currentTask: 'b' }));

      const entries = listHandoffs(dir);
      assert.equal(entries.length, 3);
      const named = entries.filter(e => e.name);
      assert.deepEqual(named.map(e => e.name).sort(), ['feature-a', 'feature-b']);

      // Unnamed entry should NOT have a name key set.
      const unnamed = entries.find(e => e.currentTask === 'unnamed');
      assert.ok(unnamed);
      assert.equal(unnamed.name, undefined);
    } finally {
      cleanup();
    }
  });

  it('read by name resolves the newest matching checkpoint when a name is reused', () => {
    const { dir, cleanup } = tmpDir();
    try {
      // Writing the same name twice must not break — newest wins.
      const first = writeHandoff(dir, baseNote({ name: 'reused', currentTask: 'first' }));
      // Force a distinct timestamp so the second file sorts after the first.
      // stampFilename() is second-resolution, so a tiny sleep is enough.
      const start = Date.now();
      while (Date.now() - start < 1100) { /* spin */ }
      const second = writeHandoff(dir, baseNote({ name: 'reused', currentTask: 'second' }));

      assert.notEqual(first.timestamp, second.timestamp);
      const loaded = readHandoff(dir, 'reused');
      assert.ok(loaded);
      assert.equal(loaded.currentTask, 'second');
    } finally {
      cleanup();
    }
  });

  it('read with no identifier returns the latest', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ currentTask: 'older' }));
      const start = Date.now();
      while (Date.now() - start < 1100) { /* spin */ }
      writeHandoff(dir, baseNote({ name: 'newer-named', currentTask: 'newer' }));

      const loaded = readHandoff(dir);
      assert.ok(loaded);
      assert.equal(loaded.currentTask, 'newer');
    } finally {
      cleanup();
    }
  });

  it('read with unknown name returns null', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ name: 'real', currentTask: 'real task' }));
      const loaded = readHandoff(dir, 'does-not-exist');
      assert.equal(loaded, null);
    } finally {
      cleanup();
    }
  });
});

describe('handoff sanitising', () => {
  it('strips a leaked closing tag and the parameter that followed it', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const written = writeHandoff(dir, baseNote({
        currentTask: 'Argos wave two running.</currentTask>\n<parameter name="completed">["a", "b"]',
        completed: ['done thing</completed>\n<parameter name="nextSteps">[]'],
      }));
      assert.equal(written.currentTask, 'Argos wave two running.');
      assert.deepEqual(written.completed, ['done thing']);
      assert.equal(readHandoff(dir)?.currentTask, 'Argos wave two running.');
    } finally {
      cleanup();
    }
  });
});

/** Set a written handoff's timestamp so ordering does not depend on the clock. */
function stampAt(dir: string, stamp: string, iso: string) {
  const path = join(dir, 'handoffs', `${stamp}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), timestamp: iso }));
}

describe('handoff lanes', () => {
  it('reads the latest resume note from the lane it is asked for', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const personal = writeHandoff(dir, baseNote({ lane: 'claude', currentTask: 'personal task' }));
      const work = writeHandoff(dir, baseNote({ lane: 'claude-work', currentTask: 'work task' }));
      stampAt(dir, personal.stamp, '2026-01-01T00:00:00.000Z');
      stampAt(dir, work.stamp, '2026-02-01T00:00:00.000Z');

      assert.equal(readHandoff(dir, undefined, { lane: 'claude' })?.currentTask, 'personal task');
      assert.equal(readHandoff(dir, undefined, { lane: 'claude-work' })?.currentTask, 'work task');
      assert.equal(readHandoff(dir, work.stamp, { lane: 'claude' }), null, 'a stamp from another lane is not readable');
      assert.equal(readHandoff(dir, work.stamp, { all: true })?.currentTask, 'work task');
      assert.deepEqual(listHandoffs(dir, 10, { lane: 'claude' }).map(e => e.currentTask), ['personal task']);
    } finally {
      cleanup();
    }
  });

  it('skips handoffs written before lanes existed unless all lanes are asked for', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ currentTask: 'pre-lane task' }));
      assert.equal(readHandoff(dir, undefined, { lane: 'claude' }), null);
      assert.equal(readHandoff(dir, undefined, { all: true })?.currentTask, 'pre-lane task');
    } finally {
      cleanup();
    }
  });

  it('prefers the same project when picking the latest', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const mine = writeHandoff(dir, baseNote({ lane: 'claude', project: 'argos', currentTask: 'argos task' }));
      const other = writeHandoff(dir, baseNote({ lane: 'claude', project: 'nexus', currentTask: 'nexus task' }));
      stampAt(dir, mine.stamp, '2026-01-01T00:00:00.000Z');
      stampAt(dir, other.stamp, '2026-02-01T00:00:00.000Z');
      assert.equal(readHandoff(dir, undefined, { lane: 'claude', project: 'argos' })?.currentTask, 'argos task');
      assert.equal(readHandoff(dir, undefined, { lane: 'claude', project: 'unknown' })?.currentTask, 'nexus task');
    } finally {
      cleanup();
    }
  });

  it('delivers an addressed handoff to the other lane, never as the sender\'s resume note', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const sent = writeHandoff(dir, baseNote({ lane: 'claude', project: 'pryzm-ai-poc', to: 'Claude-Work', currentTask: 'push the branch' }));
      assert.equal(sent.to, 'claude-work');
      assert.equal(sent.status, 'pending');

      assert.equal(readHandoff(dir, undefined, { lane: 'claude' }), null);
      assert.equal(readHandoff(dir, undefined, { lane: 'claude-work' }), null, 'a message is not a resume note for the recipient either');
      assert.deepEqual(listInbox(dir, 'claude').map(e => e.stamp), []);

      const inbox = listInbox(dir, 'claude-work');
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].lane, 'claude');
      assert.equal(inbox[0].project, 'pryzm-ai-poc');
      assert.equal(readHandoff(dir, sent.stamp, { lane: 'claude-work' })?.currentTask, 'push the branch');
      assert.equal(readHandoff(dir, sent.stamp, { lane: 'somebody-else' }), null);
    } finally {
      cleanup();
    }
  });

  it('acks only from the addressed lane, once, and keeps the record', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const sent = writeHandoff(dir, baseNote({ lane: 'claude', to: 'claude-work', currentTask: 'push the branch' }));
      assert.equal(ackHandoff(dir, sent.stamp, 'claude'), null);
      assert.equal(ackHandoff(dir, '../../etc/passwd', 'claude-work'), null);

      const acked = ackHandoff(dir, sent.stamp, 'claude-work');
      assert.equal(acked?.status, 'picked-up');
      assert.equal(acked?.pickedUpBy, 'claude-work');
      assert.equal(listInbox(dir, 'claude-work').length, 0);
      assert.equal(listInbox(dir, 'claude-work', { includePickedUp: true })[0].status, 'picked-up');
      assert.equal(ackHandoff(dir, sent.stamp, 'claude-work')?.pickedUpAt, acked?.pickedUpAt);
      assert.match(readFileSync(join(dir, 'handoffs', `${sent.stamp}.md`), 'utf8'), /\*\*To:\*\* claude-work \(picked-up/);
    } finally {
      cleanup();
    }
  });

  it('reads per-session checkpoints from the lane only', () => {
    const { dir, cleanup } = tmpDir();
    try {
      mkdirSync(checkpointDir(dir), { recursive: true });
      const cp = (session: string, lane: string, task: string, ts: string) =>
        writeFileSync(join(checkpointDir(dir), `${session}.json`), JSON.stringify({ ...baseNote({ lane, currentTask: task, reason: 'context-pressure' }), sessionId: session, timestamp: ts }));
      cp('a', 'claude', 'personal crash', '2026-01-01T00:00:00.000Z');
      cp('b', 'claude-work', 'work crash', '2026-03-01T00:00:00.000Z');
      assert.equal(readLatestCheckpoint(dir, { lane: 'claude' })?.currentTask, 'personal crash');
      assert.equal(readLatestCheckpoint(dir, { lane: 'claude-work' })?.currentTask, 'work crash');
      assert.equal(readLatestCheckpoint(dir, { lane: 'nobody' }), null);
    } finally {
      cleanup();
    }
  });
});
