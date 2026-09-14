/**
 * Handoff commands for the hooks and the shell.
 *
 * Kept apart from cli.ts on purpose. That module loads the vector store when it is
 * imported, and the user-prompt hook runs this before every prompt, so it has to start
 * in milliseconds. Nothing here touches anything but the handoffs folder.
 *
 *   node dist/handoff-cli.js inbox [--lane L] [--all] [--format json|text]
 *   node dist/handoff-cli.js inbox --new --session <id>
 *   node dist/handoff-cli.js handoff send --to <lane> --task "<one line>" [--next "<step>"]... [--notes "<text>"] [--name <n>]
 *   node dist/handoff-cli.js handoff list [--lane L] [--all] [--limit N] [--format json|text]
 *   node dist/handoff-cli.js handoff read <stamp> [--lane L] [--all]
 *   node dist/handoff-cli.js handoff ack <stamp> [--lane L]
 */
export declare const HANDOFF_HELP = "przm-memory handoffs\n\n  inbox [--lane L] [--all] [--format json|text]   handoffs addressed to this lane\n  inbox --new --session <id>                      only ones this session has not been told about\n  handoff send --to <lane> --task \"<one line>\"    send a handoff to another lane\n               [--next \"<step>\"]... [--notes \"<text>\"] [--name <n>]\n  handoff list [--lane L] [--all] [--limit N]     handoffs written in a lane\n  handoff read <stamp> [--lane L] [--all]         one handoff in full, as JSON\n  handoff ack <stamp> [--lane L]                  mark a handoff to this lane picked up\n\nThe lane is the Claude Code config directory's name (~/.claude-work is \"claude-work\").\nPRZM_MEMORY_LANE overrides it.\n";
type Out = (text: string) => void;
/** Remember which inbox stamps a session has already been shown, so no hook repeats them. */
export declare function markAnnounced(dataDir: string, sessionId: string, stamps: string[]): void;
/** Text for handoffs to `lane` this session has not been shown yet; '' when there are none. */
export declare function announceNew(dataDir: string, lane: string, sessionId: string, now?: Date): string;
export declare function main(argv: string[], out?: Out, err?: Out): Promise<number>;
export {};
