/**
 * Session-start context.
 *
 * The store now pushes rules, corrections, the latest handoff and project
 * memories into a new session instead of waiting to be asked. These tests pin
 * what gets included, in what order, and that the caps hold.
 *
 * Run: `npm test` or `node --import tsx --test tests/session-context.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSessionContext, dedupe, stripLeakedMarkup } from '../src/session-context.js';
import { writeHandoff } from '../src/handoff.js';
import type { Storage } from '../src/storage.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-ctx-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function chunk(over: Record<string, unknown>) {
  return { id: 'x', type: 'fact', importance: 0.5, content: '', domain: undefined, createdAt: '2026-09-09T00:00:00Z', cognitiveLayer: 'semantic', ...over };
}

function rule(text: string, confidence: number, reinforcements = 0, contradictions = 0) {
  return { rule: text, confidence, domain: 'general', reinforcements, contradictions };
}

function fakeStorage(chunks: Array<Record<string, unknown>>, rules: Array<ReturnType<typeof rule>>): Storage {
  return { listChunks: async () => chunks, getRules: async () => rules } as unknown as Storage;
}

/** Push a written handoff's timestamp into the past so ordering does not depend on the clock. */
function backdate(dir: string, name: string, iso: string) {
  const hd = join(dir, 'handoffs');
  for (const f of readdirSync(hd).filter(f => f.endsWith('.json'))) {
    const p = join(hd, f);
    const note = JSON.parse(readFileSync(p, 'utf8'));
    if (note.name === name) writeFileSync(p, JSON.stringify({ ...note, timestamp: iso }));
  }
}

describe('buildSessionContext', () => {
  it('returns nothing for an empty store', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      assert.equal(await buildSessionContext(fakeStorage([], []), dir), '');
    } finally { cleanup(); }
  });

  it('includes rules above the confidence floor, strongest first, and drops the rest', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const out = await buildSessionContext(fakeStorage([], [
        rule('weak rule', 0.2),
        rule('strong rule', 0.9),
        rule('medium rule', 0.6),
        rule('repeated rule', 0.6, 4),
        rule('disputed rule', 0.9, 1, 3),
      ]), dir);
      assert.match(out, /## Standing rules/);
      assert.ok(out.indexOf('repeated rule') < out.indexOf('strong rule'), 'reinforced rules come first');
      assert.ok(out.indexOf('strong rule') < out.indexOf('medium rule'));
      assert.doesNotMatch(out, /weak rule/);
      assert.doesNotMatch(out, /disputed rule/, 'a rule contradicted more than reinforced is dropped');
    } finally { cleanup(); }
  });

  it('surfaces high-importance corrections and preferences but not ordinary facts', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const out = await buildSessionContext(fakeStorage([
        chunk({ id: 'a', type: 'correction', importance: 0.95, content: 'Verify a diagnosis before proposing a fix.' }),
        chunk({ id: 'b', type: 'preference', importance: 0.9, content: 'Keep workflows small.' }),
        chunk({ id: 'c', type: 'correction', importance: 0.6, content: 'A minor nit.' }),
        chunk({ id: 'd', type: 'fact', importance: 0.99, content: 'The sky is blue.' }),
      ], []), dir);
      assert.match(out, /## Things the user has corrected or asked for/);
      assert.match(out, /Verify a diagnosis/);
      assert.match(out, /Keep workflows small/);
      assert.doesNotMatch(out, /A minor nit/);
      assert.doesNotMatch(out, /sky is blue/);
    } finally { cleanup(); }
  });

  it('selects project memories by the working directory name', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const out = await buildSessionContext(fakeStorage([
        chunk({ id: 'a', domain: 'argos', importance: 0.8, content: 'Argos uses pkexec for root.' }),
        chunk({ id: 'b', domain: 'nexus', importance: 0.8, content: 'Nexus is something else.' }),
      ], []), dir, { cwd: '/home/matt/development/Argos' });
      assert.match(out, /## About argos/);
      assert.match(out, /pkexec/);
      assert.doesNotMatch(out, /Nexus is something else/);
    } finally { cleanup(); }
  });

  it('prefers the crash checkpoint when it is newer than the last handoff in the lane', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, { sessionId: null, reason: 'manual', name: 'older', lane: 'claude', currentTask: 'the old task', completed: [], nextSteps: ['old next'], openQuestions: [], fileRefs: [], decisions: [], notes: '' });
      backdate(dir, 'older', '2020-01-01T00:00:00.000Z');
      // Exactly the file the stop hook writes: one per session, tagged with its lane.
      mkdirSync(join(dir, 'handoffs', 'checkpoints'), { recursive: true });
      writeFileSync(join(dir, 'handoffs', 'checkpoints', 's.json'), JSON.stringify({
        timestamp: '2030-01-01T00:00:00.000Z', sessionId: 's', reason: 'context-pressure', lane: 'claude', currentTask: 'the crashed task',
        completed: [], nextSteps: [], openQuestions: [], fileRefs: [], decisions: [], notes: '',
      }));
      // The rolling file every session used to share is not read any more.
      writeFileSync(join(dir, 'handoffs', 'session-checkpoint.json'), JSON.stringify({
        timestamp: '2031-01-01T00:00:00.000Z', sessionId: 'x', reason: 'context-pressure', currentTask: 'the shared legacy checkpoint',
        completed: [], nextSteps: [], openQuestions: [], fileRefs: [], decisions: [], notes: '',
      }));
      const out = await buildSessionContext(fakeStorage([], []), dir, { lane: 'claude' });
      assert.match(out, /crash checkpoint/);
      assert.match(out, /the crashed task/);
      assert.doesNotMatch(out, /the old task/);
      assert.doesNotMatch(out, /shared legacy checkpoint/);
    } finally { cleanup(); }
  });

  it('keeps another lane\'s handoffs and checkpoints out of the session', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const base = { sessionId: null, reason: 'manual' as const, completed: [], nextSteps: [], openQuestions: [], fileRefs: [], decisions: [], notes: '' };
      writeHandoff(dir, { ...base, name: 'mine', lane: 'claude', currentTask: 'the personal task' });
      backdate(dir, 'mine', '2026-01-01T00:00:00.000Z');
      writeHandoff(dir, { ...base, name: 'theirs', lane: 'claude-work', currentTask: 'the work task' });
      backdate(dir, 'theirs', '2026-06-01T00:00:00.000Z');
      mkdirSync(join(dir, 'handoffs', 'checkpoints'), { recursive: true });
      writeFileSync(join(dir, 'handoffs', 'checkpoints', 'w.json'), JSON.stringify({ ...base, timestamp: '2030-01-01T00:00:00.000Z', reason: 'context-pressure', lane: 'claude-work', currentTask: 'the work crash' }));

      const out = await buildSessionContext(fakeStorage([], []), dir, { lane: 'claude' });
      assert.match(out, /the personal task/);
      assert.doesNotMatch(out, /the work task|the work crash/);
    } finally { cleanup(); }
  });

  it('puts handoffs addressed to the lane first, and never shows them to the sender', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const base = { sessionId: null, reason: 'manual' as const, completed: [], nextSteps: [], openQuestions: [], fileRefs: [], decisions: [], notes: '' };
      writeHandoff(dir, { ...base, lane: 'claude-work', currentTask: 'the work resume note' });
      writeHandoff(dir, { ...base, lane: 'claude', project: 'pryzm-ai-poc', to: 'claude-work', currentTask: 'push feature/gbp-data-freshness' });

      const work = await buildSessionContext(fakeStorage([], []), dir, { lane: 'claude-work' });
      assert.match(work, /## Handoffs waiting for you \(lane claude-work\)/);
      assert.match(work, /from claude\/pryzm-ai-poc/);
      assert.match(work, /confirm with the user before acting/);
      assert.ok(work.indexOf('Handoffs waiting for you') < work.indexOf('the work resume note'));

      const personal = await buildSessionContext(fakeStorage([], []), dir, { lane: 'claude' });
      assert.doesNotMatch(personal, /push feature\/gbp-data-freshness/);
    } finally { cleanup(); }
  });

  it('holds the size cap', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const many = Array.from({ length: 200 }, (_, i) => chunk({ id: `c${i}`, type: 'preference', importance: 0.9, content: `preference number ${i} `.repeat(20) }));
      const out = await buildSessionContext(fakeStorage(many, []), dir, { maxChars: 2000, maxCorrections: 200 });
      assert.ok(out.length <= 2000, `got ${out.length}`);
      assert.match(out, /cut at the size cap/);
    } finally { cleanup(); }
  });
});

describe('dedupe and leaked markup', () => {
  it('strips a leaked closing tag and parameter opening', () => {
    assert.equal(stripLeakedMarkup('Real content here.</content>\n<parameter name="domain">argos'), 'Real content here.');
    assert.equal(stripLeakedMarkup('<parameter name="domain">argos'), '');
  });

  it('drops markup-only fragments, short scraps and near-duplicates, keeping the first', () => {
    const out = dedupe([
      chunk({ id: 'a', content: 'Rule from Matt: verify a diagnosis before proposing a fix. Do not present a hypothesis.' }),
      chunk({ id: 'b', content: 'Rule from Matt: verify a diagnosis before proposing a fix. Do not present a hypothesis as a conclusion. Why: ...' }),
      chunk({ id: 'c', content: '<parameter name="domain">global' }),
      chunk({ id: 'd', content: 'too short' }),
      chunk({ id: 'e', content: 'Something entirely different that should survive the pass.' }),
    ] as never);
    assert.deepEqual(out.map(c => c.id), ['a', 'e']);
  });

  it('collapses the pieces the chunker made of one ingest by their shared source', () => {
    const out = dedupe([
      chunk({ id: 'p1', source: 'wal:1', content: 'Rule from Matt (2026-09-09): verify a diagnosis before proposing a fix.' }),
      chunk({ id: 'p2', source: 'wal:1', content: 'How to apply: before recommending an action, ask what would prove the theory wrong.' }),
      chunk({ id: 'p3', source: 'wal:1', content: 'Why: three confident fixes in a row were each wrong.' }),
      chunk({ id: 'q1', source: 'wal:2', content: 'An unrelated memory from a different ingest entirely.' }),
    ] as never);
    assert.deepEqual(out.map(c => c.id), ['p1', 'q1']);
  });
});
