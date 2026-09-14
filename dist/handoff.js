import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLane } from './lane.js';
function handoffDir(dataDir) {
    return join(dataDir, 'handoffs');
}
/** One rolling file per session, written by hooks/engram_stop_hook.sh. */
export function checkpointDir(dataDir) {
    return join(handoffDir(dataDir), 'checkpoints');
}
function stampFilename() {
    // YYYY-MM-DD_HH-MM-SS — safe for filenames, chronologically sortable
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('-').slice(0, 6).join('-');
}
function handoffJsonPath(dataDir, stamp) {
    return join(handoffDir(dataDir), `${stamp}.json`);
}
function handoffMdPath(dataDir, stamp) {
    return join(handoffDir(dataDir), `${stamp}.md`);
}
/**
 * Some MCP clients bleed the closing tag of one parameter and the opening of the next into a
 * string value. Seen on a real handoff: currentTask ended with "</currentTask>" and the whole
 * "completed" array as text, while "completed" itself arrived empty. Strip it from every string
 * before the note is written.
 */
function cleanText(value) {
    return value.replace(/<\/[a-zA-Z]+>[\s\S]*$/, '').replace(/<parameter name="[^"]*">[^\n]*/g, '').trim();
}
function cleanNote(note) {
    const out = { ...note };
    for (const [k, v] of Object.entries(out)) {
        if (typeof v === 'string')
            out[k] = cleanText(v);
        else if (Array.isArray(v))
            out[k] = v.map(x => (typeof x === 'string' ? cleanText(x) : x)).filter(x => x !== '');
    }
    return out;
}
/**
 * Atomic write for the JSON+MD pair. Two non-atomic writeFileSync calls in a row could leave
 * a JSON file with no markdown sibling (or vice versa) on crash, breaking the pairing
 * readHandoff relies on. Stage both as .tmp first, then rename both -- minimizes the crash
 * window to the gap between two consecutive renameSync calls (sub-millisecond). True
 * cross-file atomicity isn't expressible in POSIX; this is the best practical approximation.
 */
function persist(dataDir, stamp, note) {
    const jsonPath = handoffJsonPath(dataDir, stamp);
    const mdPath = handoffMdPath(dataDir, stamp);
    writeFileSync(`${jsonPath}.tmp`, JSON.stringify(note, null, 2), 'utf-8');
    writeFileSync(`${mdPath}.tmp`, formatHandoffMarkdown(note), 'utf-8');
    renameSync(`${jsonPath}.tmp`, jsonPath);
    renameSync(`${mdPath}.tmp`, mdPath);
}
/** Write a handoff note. Persists BOTH JSON (machine-readable) and markdown (human-readable). */
export function writeHandoff(dataDir, rawNote) {
    const note = cleanNote(rawNote);
    if (note.lane)
        note.lane = normalizeLane(note.lane);
    if (note.to) {
        note.to = normalizeLane(note.to);
        note.status = note.status ?? 'pending';
    }
    const dir = handoffDir(dataDir);
    // 0700 = owner-only access. Handoffs contain "where we left off"
    // session context -- file refs, decisions, open questions. Not
    // world-readable on shared systems.
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString();
    const full = { ...note, timestamp };
    // Stamps are second-resolution; two handoffs written within the same
    // second (a hook checkpoint racing an agent handoff) would silently
    // overwrite each other. Suffix until the name is free.
    let stamp = stampFilename();
    for (let n = 2; existsSync(handoffJsonPath(dataDir, stamp)); n++) {
        stamp = `${stampFilename()}-${n}`;
    }
    persist(dataDir, stamp, full);
    return { ...full, stamp };
}
// Timestamped handoff filenames look like "2026-04-22_14-32-05-123Z" (what
// stampFilename() produces). Anything else in the directory -- the pre-1.6
// rolling `session-checkpoint.json`, the checkpoints/ folder -- is not a
// handoff and never shadows one.
//
// A second handoff written in the same millisecond gets a "-2" (then "-3")
// suffix from writeHandoff, so that is allowed too.
//
// SECURITY: anchored at end with optional millisecond+timezone suffix.
// An earlier version was unanchored, which allowed a `stamp` like
// "2026-01-01_00-00-00/../../.pyre/credentials" to match and then be
// joined into the file path -- arbitrary `.json` file read.
const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+Z?)?(-\d+)?$/;
// Defense-in-depth path-safety check on any user-provided identifier
// before it touches the filesystem. Even with STAMP_RE anchored, a
// future change that loosens the regex shouldn't reopen the traversal.
function isSafeHandoffIdentifier(identifier) {
    if (!identifier)
        return false;
    if (identifier.length > 200)
        return false;
    if (identifier.includes('/') || identifier.includes('\\'))
        return false;
    if (identifier.includes('..'))
        return false;
    if (identifier.includes('\0'))
        return false;
    return true;
}
function loadHandoffFile(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
/** Every timestamped handoff, newest first. */
function loadAll(dataDir) {
    const dir = handoffDir(dataDir);
    if (!existsSync(dir))
        return [];
    const out = [];
    const stamps = readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''))
        .filter(s => STAMP_RE.test(s))
        .sort()
        .reverse();
    for (const stamp of stamps) {
        const note = loadHandoffFile(handoffJsonPath(dataDir, stamp));
        if (note)
            out.push({ stamp, note });
    }
    return out;
}
function visible(note, scope) {
    if (!scope || scope.all || !scope.lane)
        return true;
    const lane = normalizeLane(scope.lane);
    return note.lane === lane || note.to === lane;
}
/** Same-project notes first, then newest. */
function pickLatest(notes, project) {
    if (!notes.length)
        return null;
    const sorted = [...notes].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    if (project) {
        const same = sorted.find(n => n.project === project);
        if (same)
            return same;
    }
    return sorted[0];
}
/**
 * Read the most recent handoff, or a specific one by stamp or name.
 *
 * Identifier resolution order:
 *   1. No identifier → latest resume note in scope (addressed handoffs are messages, never a resume note)
 *   2. Identifier matches stamp regex → load by stamp
 *   3. Otherwise → scan handoff JSONs for `name` field match (newest match wins)
 */
export function readHandoff(dataDir, identifier, scope) {
    if (!identifier) {
        const notes = loadAll(dataDir).map(e => e.note).filter(n => !n.to && visible(n, scope));
        return pickLatest(notes, scope?.project);
    }
    if (!isSafeHandoffIdentifier(identifier))
        return null;
    if (STAMP_RE.test(identifier)) {
        const note = loadHandoffFile(handoffJsonPath(dataDir, identifier));
        return note && visible(note, scope) ? note : null;
    }
    return loadAll(dataDir).find(e => e.note.name === identifier && visible(e.note, scope))?.note ?? null;
}
function toEntry(stamp, note) {
    return {
        stamp,
        timestamp: note.timestamp,
        reason: note.reason,
        currentTask: note.currentTask,
        ...(note.name ? { name: note.name } : {}),
        ...(note.lane ? { lane: note.lane } : {}),
        ...(note.project ? { project: note.project } : {}),
        ...(note.to ? { to: note.to, status: note.status ?? 'pending' } : {}),
    };
}
/**
 * List handoff checkpoints, newest first. Includes the optional `name` so a
 * caller can present a list-and-pick UI keyed on either stamp or name.
 */
export function listHandoffs(dataDir, limit = 10, scope) {
    return loadAll(dataDir)
        .filter(e => visible(e.note, scope))
        .slice(0, limit)
        .map(e => toEntry(e.stamp, e.note));
}
/** Handoffs addressed to a lane, newest first. Picked-up ones only when asked for. */
export function listInbox(dataDir, lane, opts = {}) {
    const target = normalizeLane(lane);
    return loadAll(dataDir)
        .filter(e => e.note.to === target && (opts.includePickedUp || e.note.status !== 'picked-up'))
        .map(e => toEntry(e.stamp, e.note));
}
/**
 * Mark a handoff addressed to `lane` as picked up. Returns null when there is no such
 * handoff or it was addressed to a different lane; a second ack returns it unchanged.
 */
export function ackHandoff(dataDir, stamp, lane) {
    if (!isSafeHandoffIdentifier(stamp) || !STAMP_RE.test(stamp))
        return null;
    const note = loadHandoffFile(handoffJsonPath(dataDir, stamp));
    const target = normalizeLane(lane);
    if (!note || note.to !== target)
        return null;
    if (note.status === 'picked-up')
        return note;
    const updated = { ...note, status: 'picked-up', pickedUpAt: new Date().toISOString(), pickedUpBy: target };
    persist(dataDir, stamp, updated);
    return updated;
}
/** The newest per-session checkpoint in scope, same project first. */
export function readLatestCheckpoint(dataDir, scope) {
    const dir = checkpointDir(dataDir);
    if (!existsSync(dir))
        return null;
    const notes = readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => loadHandoffFile(join(dir, f)))
        .filter((n) => n != null)
        .filter(n => !scope || scope.all || !scope.lane || n.lane === normalizeLane(scope.lane));
    return pickLatest(notes, scope?.project);
}
function formatHandoffMarkdown(note) {
    const lines = [
        `# Handoff — ${note.name ?? note.timestamp}`,
        '',
        note.name ? `**Name:** ${note.name}` : '',
        `**Reason:** ${note.reason}`,
        `**Timestamp:** ${note.timestamp}`,
        note.sessionId ? `**Session:** ${note.sessionId}` : '',
        note.lane ? `**Lane:** ${note.lane}${note.project ? ` (${note.project})` : ''}` : '',
        note.to ? `**To:** ${note.to} (${note.status ?? 'pending'}${note.pickedUpAt ? ` ${note.pickedUpAt}` : ''})` : '',
        '',
        '## Current Task',
        note.currentTask || '_unspecified_',
        '',
    ];
    if (note.completed.length) {
        lines.push('## Completed', ...note.completed.map(c => `- ${c}`), '');
    }
    if (note.nextSteps.length) {
        lines.push('## Next Steps', ...note.nextSteps.map(s => `- ${s}`), '');
    }
    if (note.openQuestions.length) {
        lines.push('## Open Questions', ...note.openQuestions.map(q => `- ${q}`), '');
    }
    if (note.fileRefs.length) {
        lines.push('## File Refs', ...note.fileRefs.map(f => `- ${f}`), '');
    }
    if (note.decisions.length) {
        lines.push('## Decisions', ...note.decisions.map(d => `- ${d}`), '');
    }
    if (note.notes.trim()) {
        lines.push('## Notes', note.notes.trim(), '');
    }
    return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}
//# sourceMappingURL=handoff.js.map