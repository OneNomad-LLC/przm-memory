#!/usr/bin/env node
/**
 * przm Memory CLI router.
 *
 * Usage:
 *   przm-memory-mcp                                                 → run MCP stdio server (back-compat)
 *   przm-memory-mcp search --query <q> [--project <p>] [--limit N]
 *                     [--min-relevance F] [--format json|text]
 *   przm-memory-mcp query  [--project <p>] [--tier <t>]
 *                     [--min-importance F] [--limit N] [--format json|text]
 *   przm-memory-mcp help
 *
 * The CLI is additive — it wraps the same search/storage primitives the
 * MCP server uses so hook scripts can pull memories without speaking
 * stdio JSON-RPC.
 */
import { parseArgs } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { search, formatRecalledMemories } from './search.js';
import { gradeTranscript } from './inferred-outcome.js';
import { buildSessionContext } from './session-context.js';
import { main as runHandoffCli, markAnnounced, HANDOFF_HELP } from './handoff-cli.js';
import { listInbox } from './handoff.js';
import { currentLane, normalizeLane } from './lane.js';
import { rebuildRules } from './maintenance.js';
import { repairStore } from './repair.js';
const HELP = `przm-memory-mcp — memory CLI

Usage:
  przm-memory-mcp                                              run MCP stdio server
  przm-memory-mcp search  --query <q> [opts]                   hybrid search
  przm-memory-mcp query   [opts]                               filter listing
  przm-memory-mcp reembed [--dry-run]                          re-embed all memories
                                                               with the active model
  przm-memory-mcp compact                                      prune old table versions,
                                                               reclaim disk
  przm-memory-mcp grade   --transcript <path> --session <id>   infer recall outcomes from a
                          [--final] [--min-turns N] [--dry-run]  Claude Code transcript
  przm-memory-mcp grade   --all [--dry-run]                     the same over every transcript
                                                               under ~/.claude/projects
  przm-memory-mcp context [--cwd <dir>] [--max-chars N]        print session-start context:
                          [--lane L] [--session <id>]            inbox, handoff, rules,
                                                               corrections, project memories
  przm-memory-mcp inbox   [--lane L] [--all] [--new --session <id>]
                                                               handoffs addressed to this lane
  przm-memory-mcp handoff send|list|read|ack ...               send a handoff to another lane,
                                                               list, read or acknowledge one
                                                               (przm-memory-mcp handoff help)
  przm-memory-mcp rules   list [--scope <slug>] | rebuild      show the rules table, or throw it
                                                               away and re-derive it from the
                                                               correction and preference chunks
  przm-memory-mcp repair  [--dry-run]                          re-ingest memories whose pieces
                                                               were cut, trim truncated
                                                               summaries, lift user-stated
                                                               corrections to the rule floor
  przm-memory-mcp login   <server-url> | --server <url>        pair with przm Cloud
  przm-memory-mcp logout                                       remove cached credentials
  przm-memory-mcp help                                         this message

search options:
  --query <q>            (required) natural-language query
  --project <p>          filter by domain (project namespace)
  --topic <t>            filter by topic
  --tag <t>              filter by exact tag
  --limit <n>            max results (default 10)
  --min-relevance <f>    drop results with vector similarity < f (0..1)
  --format json|text     output mode (default json)
  --no-embed             skip embedding model load (keyword/IDF only,
                         ~1.5s faster cold-start, lower recall)

reembed options:
  --dry-run              report what would be re-embedded without writing
  Run this once after changing the embedding model (the server logs a
  warning at boot when stored vectors don't match the active model).

query options:
  --project <p>          filter by domain
  --topic <t>            filter by topic
  --tag <t>              filter by exact tag
  --tier <t>             daily | short-term | long-term | archive
  --layer <l>            episodic | semantic | procedural
  --min-importance <f>   drop chunks with importance < f (0..1)
  --limit <n>            max results (default 25)
  --format json|text     output mode (default json)

login options:
  <server-url>           (required) przm server URL, e.g. https://przm.sh
  --server <url>         alternative to the positional arg
                         (PYRE_API_URL env var also works)

Environment:
  PRZM_MEMORY_DATA_DIR   data directory (default ~/.claude/przm-memory;
                         legacy ENGRAM_DATA_DIR also honored)
  PRZM_MEMORY_EMBEDDING_MODEL
                         embedding model (default Xenova/bge-small-en-v1.5;
                         legacy ENGRAM_EMBEDDING_MODEL also honored)
  PYRE_API_URL           przm server server URL (login subcommand; alternative
                         to positional arg / --server flag)
  PYRE_CREDENTIALS_FILE  override ~/.pyre/credentials.json location
`;
const SEARCH_OPTS = {
    query: { type: 'string' },
    project: { type: 'string' },
    topic: { type: 'string' },
    tag: { type: 'string' },
    limit: { type: 'string' },
    'min-relevance': { type: 'string' },
    format: { type: 'string' },
    'no-embed': { type: 'boolean' },
};
const LOGIN_OPTS = {
    server: { type: 'string' },
};
const QUERY_OPTS = {
    project: { type: 'string' },
    topic: { type: 'string' },
    tag: { type: 'string' },
    tier: { type: 'string' },
    layer: { type: 'string' },
    'min-importance': { type: 'string' },
    limit: { type: 'string' },
    format: { type: 'string' },
};
function parseFloatOpt(v, name) {
    if (v === undefined)
        return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
        fail(`--${name} must be a number, got "${v}"`);
    }
    return n;
}
function parseIntOpt(v, name) {
    if (v === undefined)
        return undefined;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) {
        fail(`--${name} must be a non-negative integer, got "${v}"`);
    }
    return n;
}
function parseFormat(v) {
    if (v === undefined)
        return 'json';
    if (v !== 'json' && v !== 'text')
        fail(`--format must be json|text, got "${v}"`);
    return v;
}
function parseTier(v) {
    if (v === undefined)
        return undefined;
    const allowed = ['daily', 'short-term', 'long-term', 'archive'];
    if (!allowed.includes(v)) {
        fail(`--tier must be one of ${allowed.join('|')}, got "${v}"`);
    }
    return v;
}
function fail(msg) {
    process.stderr.write(`przm-memory-mcp: ${msg}\n`);
    process.exit(2);
}
function chunkToWire(c) {
    return {
        id: c.id,
        content: c.content,
        type: c.type,
        layer: c.cognitiveLayer,
        tier: c.tier,
        domain: c.domain || undefined,
        topic: c.topic || undefined,
        tags: c.tags.length > 0 ? c.tags : undefined,
        source: c.source || undefined,
        importance: c.importance,
        createdAt: c.createdAt || undefined,
    };
}
async function runSearch(argv) {
    const { values } = parseArgs({ args: argv, options: SEARCH_OPTS, allowPositionals: false });
    if (!values.query)
        fail('search: --query is required');
    const limit = parseIntOpt(values.limit, 'limit') ?? 10;
    const minRelevance = parseFloatOpt(values['min-relevance'], 'min-relevance') ?? 0;
    const format = parseFormat(values.format);
    if (values['no-embed']) {
        process.env.ENGRAM_SKIP_EMBED = '1';
    }
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    const filters = {};
    if (values.project)
        filters.domain = values.project;
    if (values.topic)
        filters.topic = values.topic;
    if (values.tag)
        filters.tag = values.tag;
    let results = [];
    try {
        results = await search(config, storage, values.query, limit, filters);
    }
    catch (err) {
        fail(`search failed: ${err.message}`);
    }
    // --min-relevance promises a 0..1 scale, which the composite score no
    // longer is under RRF (rank-fusion values top out near ~0.07). Filter
    // on the raw vector similarity when available; keyword-only results
    // (--no-embed) fall back to the composite score.
    const filtered = results
        .filter(r => (r.vectorSimilarity ?? r.score) >= minRelevance)
        .slice(0, limit);
    if (format === 'text') {
        process.stdout.write(formatRecalledMemories(filtered));
        return;
    }
    process.stdout.write(JSON.stringify({
        total: results.length,
        returned: filtered.length,
        results: filtered.map(r => ({
            ...chunkToWire(r.chunk),
            score: Math.round(r.score * 1000) / 1000,
            ...(r.vectorSimilarity !== undefined
                ? { similarity: Math.round(r.vectorSimilarity * 1000) / 1000 }
                : {}),
        })),
    }, null, 2) + '\n');
}
async function runQuery(argv) {
    const { values } = parseArgs({ args: argv, options: QUERY_OPTS, allowPositionals: false });
    const limit = parseIntOpt(values.limit, 'limit') ?? 25;
    const minImportance = parseFloatOpt(values['min-importance'], 'min-importance') ?? 0;
    const format = parseFormat(values.format);
    const tier = parseTier(values.tier);
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    const opts = {};
    if (tier)
        opts.tier = tier;
    else
        opts.excludeTiers = ['archive'];
    if (values.layer)
        opts.cognitiveLayer = values.layer;
    if (values.project)
        opts.domain = values.project;
    if (values.topic)
        opts.topic = values.topic;
    if (values.tag)
        opts.tag = values.tag;
    let chunks = [];
    try {
        chunks = await storage.listChunks(opts);
    }
    catch (err) {
        fail(`query failed: ${err.message}`);
    }
    const filtered = chunks
        .filter(c => c.importance >= minImportance)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, limit);
    if (format === 'text') {
        const fakeResults = filtered.map(c => ({ chunk: c, score: c.importance }));
        process.stdout.write(formatRecalledMemories(fakeResults));
        return;
    }
    process.stdout.write(JSON.stringify({
        total: chunks.length,
        returned: filtered.length,
        results: filtered.map(chunkToWire),
    }, null, 2) + '\n');
}
async function runReembed(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { 'dry-run': { type: 'boolean' } },
        allowPositionals: false,
    });
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    const { getEmbeddingModelName } = await import('./llm.js');
    const { readEmbeddingMeta, reembedAll } = await import('./reembed.js');
    const current = getEmbeddingModelName();
    const meta = readEmbeddingMeta(config.dataDir);
    process.stderr.write(`przm-memory-mcp: active model  ${current}\n`);
    process.stderr.write(`przm-memory-mcp: corpus model  ${meta?.model ?? '(unknown — pre-marker store)'}\n`);
    const chunks = await storage.listChunks();
    const targets = chunks.filter(c => c.consolidationLevel !== -1);
    if (values['dry-run']) {
        process.stdout.write(JSON.stringify({
            dryRun: true,
            activeModel: current,
            corpusModel: meta?.model ?? null,
            wouldReembed: targets.length,
        }, null, 2) + '\n');
        return;
    }
    // Preflight: embed a probe and make sure the produced dimension matches
    // what's already stored. A mismatched write corrupts the vector column;
    // fail with instructions instead.
    const { embed } = await import('./llm.js');
    const probe = await embed(config, 'dimension probe');
    if (probe.length === 0) {
        fail('embedding model failed to load — cannot re-embed');
    }
    const sample = targets.find(c => c.embedding && c.embedding.length > 0);
    if (sample?.embedding && sample.embedding.length !== probe.length) {
        fail(`dimension mismatch: stored vectors are ${sample.embedding.length}-dim but the active model ` +
            `produces ${probe.length}-dim. The vector column width is fixed at table creation. ` +
            `Either set ENGRAM_EMBEDDING_DIM=${sample.embedding.length} (Matryoshka truncation, ` +
            `valid only for MRL-trained models) or export + re-import into a fresh data dir.`);
    }
    process.stderr.write(`przm-memory-mcp: re-embedding ${targets.length} memories...\n`);
    const started = Date.now();
    const stats = await reembedAll(config, storage, (done, total) => {
        process.stderr.write(`przm-memory-mcp: ${done}/${total}\n`);
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(JSON.stringify({ ...stats, model: current, seconds: Number(seconds) }, null, 2) + '\n');
    if (stats.failed > 0) {
        process.stderr.write(`przm-memory-mcp: ${stats.failed} chunks failed — marker not updated, boot warning stays. Re-run to retry.\n`);
        process.exit(1);
    }
    process.stderr.write(`przm-memory-mcp: done in ${seconds}s — corpus now in ${current} space\n`);
}
async function runCompact(argv) {
    parseArgs({ args: argv, options: {}, allowPositionals: false });
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    // Prune every non-current version. Single-process CLI op, so
    // deleteUnverified is safe. Reclaims the fragment/version bloat that
    // per-row writes (recall stats, pre-batch reembed) accumulate over time.
    process.stderr.write('przm-memory-mcp: compacting chunk table (pruning old versions)...\n');
    const started = Date.now();
    await storage.optimizeChunks(0, true);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(JSON.stringify({ compacted: true, seconds: Number(seconds) }, null, 2) + '\n');
    process.stderr.write(`przm-memory-mcp: done in ${seconds}s — run \`du -sh <dataDir>/lance\` to see reclaimed space\n`);
}
async function runLoginCmd(argv) {
    // Server URL is required.  Accept three sources, in precedence:
    //   1. Positional arg: przm-memory-mcp login https://...
    //   2. --server flag:  przm-memory-mcp login --server https://...
    //   3. PYRE_API_URL env var.
    // If none supplied -- exit 1 with the spec'd message. No defaults
    // are baked in; this binary works against any przm server instance the
    // user points at.
    const { values, positionals } = parseArgs({ args: argv, options: LOGIN_OPTS, allowPositionals: true });
    const { resolveServerUrl, runLogin } = await import('./auth/login.js');
    const apiUrl = resolveServerUrl({ positional: positionals[0], flag: values.server });
    if (!apiUrl) {
        process.stderr.write('Server URL required. Pass it as an argument or set PYRE_API_URL.\n');
        process.exit(1);
    }
    const code = await runLogin({ apiUrl });
    process.exit(code);
}
async function runLogoutCmd(argv) {
    // Accept no flags today — but parse anyway so `--help` etc. don't
    // silently become positional args.
    parseArgs({ args: argv, options: {}, allowPositionals: false });
    const { runLogout } = await import('./auth/login.js');
    process.exit(runLogout());
}
const GRADE_OPTS = {
    transcript: { type: 'string' },
    session: { type: 'string' },
    final: { type: 'boolean' },
    'min-turns': { type: 'string' },
    'dry-run': { type: 'boolean' },
    all: { type: 'boolean' },
};
/** Every Claude Code transcript on this machine, as (path, session id) pairs. */
function allTranscripts() {
    const root = join(homedir(), '.claude', 'projects');
    if (!existsSync(root))
        return [];
    const out = [];
    for (const project of readdirSync(root)) {
        const dir = join(root, project);
        let files = [];
        try {
            files = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const f of files) {
            if (!f.endsWith('.jsonl'))
                continue;
            out.push({ path: join(dir, f), session: f.slice(0, -'.jsonl'.length) });
        }
    }
    return out;
}
/**
 * Grade memory-search results from a transcript and record helpful / irrelevant outcomes.
 * Called by the stop and session-end hooks, so it has to be quiet and cheap: storage is only
 * opened when a search has matured and not been graded yet.
 */
async function runGrade(argv) {
    const { values } = parseArgs({ args: argv, options: GRADE_OPTS, allowPositionals: false });
    const minTurns = parseIntOpt(values['min-turns'], 'min-turns');
    const config = loadConfig();
    let storage = null;
    const open = async () => {
        if (!storage) {
            storage = new Storage(config.dataDir);
            await storage.ensureReady();
        }
        return storage;
    };
    const dryRun = !!values['dry-run'];
    // Backfill from history. Every transcript is graded final, since nothing more is coming for
    // any of them, and each search is still graded only once thanks to the per-session state.
    if (values.all) {
        const totals = { transcripts: 0, withSearches: 0, graded: 0, helpful: 0, irrelevant: 0, alreadyGraded: 0 };
        for (const t of allTranscripts()) {
            totals.transcripts++;
            try {
                const s = await gradeTranscript(config, open, t.path, t.session, { final: true, dryRun });
                if (s.graded || s.alreadyGraded)
                    totals.withSearches++;
                totals.graded += s.graded;
                totals.helpful += s.helpful;
                totals.irrelevant += s.irrelevant;
                totals.alreadyGraded += s.alreadyGraded;
            }
            catch (err) {
                process.stderr.write(`grade: ${t.path}: ${err.message}\n`);
            }
        }
        process.stdout.write(JSON.stringify({ ...totals, dryRun }) + '\n');
        return;
    }
    if (!values.transcript)
        fail('grade: --transcript is required (or --all)');
    if (!values.session)
        fail('grade: --session is required');
    const summary = await gradeTranscript(config, open, String(values.transcript), String(values.session), { final: !!values.final, minTurnsAfter: minTurns ?? undefined, dryRun });
    process.stdout.write(JSON.stringify(summary) + '\n');
}
const CONTEXT_OPTS = {
    cwd: { type: 'string' },
    'max-chars': { type: 'string' },
    lane: { type: 'string' },
    session: { type: 'string' },
};
/**
 * Print what a fresh session should know before its first message. Called by the
 * SessionStart hook, whose stdout Claude Code adds to context. Any failure prints
 * nothing and exits 0: a memory problem must never block a session.
 */
async function runContext(argv) {
    const { values } = parseArgs({ args: argv, options: CONTEXT_OPTS, allowPositionals: false });
    const maxChars = parseIntOpt(values['max-chars'], 'max-chars');
    try {
        const config = loadConfig();
        const lane = values.lane ? normalizeLane(String(values.lane)) : currentLane();
        const storage = new Storage(config.dataDir);
        await storage.ensureReady();
        const out = await buildSessionContext(storage, config.dataDir, {
            cwd: values.cwd ? String(values.cwd) : process.cwd(),
            lane,
            maxChars: maxChars ?? undefined,
        });
        if (out)
            process.stdout.write(out + '\n');
        // Session start has now shown the inbox, so the user-prompt hook must not repeat it.
        if (values.session)
            markAnnounced(config.dataDir, String(values.session), listInbox(config.dataDir, lane).map(e => e.stamp));
    }
    catch {
        // Quiet by design.
    }
}
const RULES_OPTS = {
    scope: { type: 'string' },
};
async function runRules(argv) {
    const [action, ...rest] = argv;
    const { values } = parseArgs({ args: rest, options: RULES_OPTS, allowPositionals: false });
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    if (action === 'rebuild') {
        const r = await rebuildRules(config, storage);
        process.stdout.write(JSON.stringify(r) + '\n');
        return;
    }
    if (action === 'list' || !action) {
        const rules = (await storage.getRules()).filter(r => values.scope === undefined || (r.scope ?? '') === String(values.scope));
        rules.sort((a, b) => (a.scope ?? '').localeCompare(b.scope ?? '') || b.reinforcements - a.reinforcements || b.confidence - a.confidence);
        for (const r of rules) {
            process.stdout.write(`${(r.scope || 'global').padEnd(16)} ${r.domain.padEnd(13)} c=${r.confidence.toFixed(2)} r=${r.reinforcements} x=${r.contradictions}  ${r.rule}\n`);
        }
        process.stdout.write(`${rules.length} rules\n`);
        return;
    }
    fail(`rules: unknown action "${action}" (list | rebuild)`);
}
const REPAIR_OPTS = {
    'dry-run': { type: 'boolean' },
};
async function runRepair(argv) {
    const { values } = parseArgs({ args: argv, options: REPAIR_OPTS, allowPositionals: false });
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    const report = await repairStore(config, storage, { dryRun: !!values['dry-run'] });
    process.stdout.write(JSON.stringify(report) + '\n');
}
async function main() {
    const [, , sub, ...rest] = process.argv;
    if (!sub || sub.startsWith('-')) {
        // Back-compat: bare invocation runs the MCP stdio server.
        await import('./server.js');
        return;
    }
    switch (sub) {
        case 'help':
        case '--help':
        case '-h':
            process.stdout.write(HELP);
            return;
        case 'search':
            await runSearch(rest);
            return;
        case 'query':
            await runQuery(rest);
            return;
        case 'reembed':
            await runReembed(rest);
            return;
        case 'compact':
            await runCompact(rest);
            return;
        case 'grade':
            await runGrade(rest);
            return;
        case 'context':
            await runContext(rest);
            return;
        case 'inbox':
        case 'handoff': {
            if (sub === 'handoff' && (rest[0] === 'help' || rest[0] === '--help')) {
                process.stdout.write(HANDOFF_HELP);
                return;
            }
            const code = await runHandoffCli([sub, ...rest]);
            if (code)
                process.exit(code);
            return;
        }
        case 'rules':
            await runRules(rest);
            return;
        case 'repair':
            await runRepair(rest);
            return;
        case 'login':
            await runLoginCmd(rest);
            return;
        case 'logout':
            await runLogoutCmd(rest);
            return;
        default:
            process.stderr.write(`przm-memory-mcp: unknown subcommand "${sub}"\n\n${HELP}`);
            process.exit(2);
    }
}
main().catch(err => {
    process.stderr.write(`przm-memory-mcp: ${err.stack ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map