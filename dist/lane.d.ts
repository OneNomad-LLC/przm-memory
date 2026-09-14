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
export declare function normalizeLane(raw: string): string;
/** `~/.claude` is "claude", `~/.claude-work` is "claude-work", unset is "claude". */
export declare function laneFromConfigDir(configDir: string | undefined): string;
export declare function currentLane(env?: NodeJS.ProcessEnv): string;
/** The working directory's name, which is also how project memories are keyed. */
export declare function projectOf(cwd: string | undefined): string;
