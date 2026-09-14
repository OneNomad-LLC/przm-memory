/**
 * Session-start context.
 *
 * Rules and handoffs only helped when the agent remembered to ask for them, and
 * measured over a day it did not: a rule set at importance 0.95 that morning was
 * never queried that afternoon, and the mistake it described was made again. So
 * the store now pushes instead of waiting to be pulled. A SessionStart hook runs
 * this once and prints it, and Claude Code adds the output to the session's
 * context before the first message.
 *
 * Four sections, each capped, all of it capped again as a whole so a large
 * store cannot flood the window:
 *
 *   1. The latest handoff, or the rolling crash checkpoint if that is newer.
 *   2. Procedural rules, top by confidence.
 *   3. Corrections and preferences with high importance: the things the user
 *      said after something went wrong.
 *   4. Memories whose domain matches the working directory's name.
 *
 * Nothing here needs an LLM. If the store is missing or unreadable the caller
 * prints nothing and exits clean; a memory problem must never block a session.
 */
import type { Storage, StoredChunk } from './storage.js';
export interface SessionContextOptions {
    /** Working directory; its basename selects project memories. */
    cwd?: string;
    /** The session's lane (src/lane.ts). Set, handoffs and checkpoints come from this lane only and its inbox is shown. */
    lane?: string;
    /** Hard cap on the whole output. Roughly 4 chars per token. */
    maxChars?: number;
    maxRules?: number;
    minRuleConfidence?: number;
    maxCorrections?: number;
    minCorrectionImportance?: number;
    maxProjectMemories?: number;
    now?: Date;
}
/**
 * Some ingests arrived with the tool call's closing tag and the next parameter's opening leaked
 * into the content. Strip that when rendering, and treat a chunk that is nothing else as noise.
 */
export declare function stripLeakedMarkup(content: string): string;
/** Keep the first of any near-identical entries, drop leaked markup and anything too short to mean much. */
export declare function dedupe(chunks: StoredChunk[]): StoredChunk[];
export declare function ageOf(iso: string, now: Date): string;
/** Handoffs another session addressed to this lane and nobody has picked up. */
export declare function inboxSection(dataDir: string, lane: string | undefined, now?: Date): string;
/**
 * Build the markdown that a SessionStart hook prints. Never throws on an empty
 * store; returns '' when there is nothing worth saying.
 */
export declare function buildSessionContext(storage: Storage, dataDir: string, opts?: SessionContextOptions): Promise<string>;
