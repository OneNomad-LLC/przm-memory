/**
 * HANDOFF NOTES — "where we left off" lifeline for cross-session continuity.
 *
 * Unlike diary entries (free-form journal) or session-state (ephemeral scratchpad),
 * handoffs are *structured* resume-from-here snapshots written immediately before
 * context compaction or session end. If the context window fills before compaction
 * runs, the user abandons the chat — the handoff is the ONLY way to continue in
 * a fresh session without re-explaining everything.
 *
 * Schema is opinionated on purpose: a fresh agent can pick up from any field
 * without hunting through prose.
 *
 * Since 1.6.0 a handoff carries the lane it was written in (see src/lane.ts). A
 * handoff with `to` set is a message for another lane rather than a resume note:
 * it waits in that lane's inbox until a session there acknowledges it.
 */
export type HandoffStatus = 'pending' | 'picked-up';
export interface HandoffNote {
    /** ISO timestamp of when this handoff was written */
    timestamp: string;
    /** Optional human-friendly checkpoint name (e.g. "engram-named-checkpoints"). Allows list-and-pick resume across many saved sessions. */
    name?: string;
    /** Session or conversation identifier */
    sessionId: string | null;
    /** Why the handoff was written: compact, session-end, manual, context-pressure */
    reason: 'compact' | 'session-end' | 'manual' | 'context-pressure';
    /** One-sentence description of the active task */
    currentTask: string;
    /** What's already been completed in this session */
    completed: string[];
    /** The very next concrete action(s) to take on resume */
    nextSteps: string[];
    /** Unresolved questions, blockers, or decisions awaiting user input */
    openQuestions: string[];
    /** File paths (ideally path:line) the next agent needs to look at */
    fileRefs: string[];
    /** Key decisions made this session that shape future work */
    decisions: string[];
    /** Anything else the next agent MUST know — hidden constraints, quirks, gotchas */
    notes: string;
    /** Lane of the session that wrote it. Handoffs without one predate lanes and lane-scoped reads skip them. */
    lane?: string;
    /** Working directory name of the session that wrote it. */
    project?: string;
    /** Lane this handoff is addressed to. When set it is a message, not the writer's own resume note. */
    to?: string;
    /** Addressed handoffs only. */
    status?: HandoffStatus;
    pickedUpAt?: string;
    pickedUpBy?: string;
}
/**
 * Which handoffs a read may see. With neither field set nothing is filtered, which is
 * what callers that predate lanes get. `lane` limits a read to handoffs written in that
 * lane plus those addressed to it; `all` lifts the limit. `project` only breaks ties
 * when picking the latest.
 */
export interface HandoffScope {
    lane?: string;
    all?: boolean;
    project?: string;
}
/** One rolling file per session, written by hooks/engram_stop_hook.sh. */
export declare function checkpointDir(dataDir: string): string;
/** Write a handoff note. Persists BOTH JSON (machine-readable) and markdown (human-readable). */
export declare function writeHandoff(dataDir: string, rawNote: Omit<HandoffNote, 'timestamp'>): HandoffNote & {
    stamp: string;
};
/**
 * Read the most recent handoff, or a specific one by stamp or name.
 *
 * Identifier resolution order:
 *   1. No identifier → latest resume note in scope (addressed handoffs are messages, never a resume note)
 *   2. Identifier matches stamp regex → load by stamp
 *   3. Otherwise → scan handoff JSONs for `name` field match (newest match wins)
 */
export declare function readHandoff(dataDir: string, identifier?: string, scope?: HandoffScope): HandoffNote | null;
export interface HandoffListEntry {
    stamp: string;
    timestamp: string;
    reason: string;
    currentTask: string;
    name?: string;
    lane?: string;
    project?: string;
    to?: string;
    status?: HandoffStatus;
}
/**
 * List handoff checkpoints, newest first. Includes the optional `name` so a
 * caller can present a list-and-pick UI keyed on either stamp or name.
 */
export declare function listHandoffs(dataDir: string, limit?: number, scope?: HandoffScope): HandoffListEntry[];
/** Handoffs addressed to a lane, newest first. Picked-up ones only when asked for. */
export declare function listInbox(dataDir: string, lane: string, opts?: {
    includePickedUp?: boolean;
}): HandoffListEntry[];
/**
 * Mark a handoff addressed to `lane` as picked up. Returns null when there is no such
 * handoff or it was addressed to a different lane; a second ack returns it unchanged.
 */
export declare function ackHandoff(dataDir: string, stamp: string, lane: string): HandoffNote | null;
/** The newest per-session checkpoint in scope, same project first. */
export declare function readLatestCheckpoint(dataDir: string, scope?: HandoffScope): HandoffNote | null;
