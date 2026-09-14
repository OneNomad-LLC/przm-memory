# Changelog

All notable changes to `@onenomad/przm-memory` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-09-14

Found by running Claude Code under two config directories on one machine. A
work session opened on a personal session's crash checkpoint, because every
session shares the store and there was one checkpoint and one "latest
handoff" for all of them.

### Added

- **Lanes.** A session's lane is the name of its Claude Code config directory
  (`~/.claude` is `claude`, `~/.claude-work` is `claude-work`;
  `PRZM_MEMORY_LANE` overrides it). Handoffs record the lane and project they
  were written in. `src/lane.ts` and `hooks/lane.sh` compute the same name and
  a test holds them to each other.
- **Handoffs between lanes.** `memory-handoff-write` takes `to` and puts the
  handoff in that lane's inbox instead of saving it as the sender's resume
  note. New tools `memory-handoff-inbox` and `memory-handoff-ack`, and CLI
  commands `przm-memory-mcp inbox` and `przm-memory-mcp handoff
  send|list|read|ack`. Session start lists pending handoffs for the lane
  first, and tells the session to confirm with the user before acting on one.
- **User-prompt hook.** `hooks/engram_userprompt_hook.sh` announces a handoff
  that arrives mid-session on the next prompt, once per session, and prints
  nothing otherwise. It runs `dist/handoff-cli.js`, which does not load the
  vector store, so it starts in about 70 ms.

### Changed

- **Handoffs stay in their lane.** Session start, `memory-handoff-read`,
  `memory-handoff-list` and the pre-compact freshness check only see the
  session's own lane, and the latest handoff prefers the current project.
  `lane` and `all` reach outside it.
- **One checkpoint per session.** The stop hook writes
  `handoffs/checkpoints/<session>.json` tagged with lane and project, removes
  the shared `session-checkpoint.json`, and prunes checkpoints older than two
  weeks.
- **Handoffs from before lanes are left out.** They have no lane, so
  lane-scoped reads skip them. `all: true` still reads them.

### Fixed

- **Same-second handoffs were invisible to stamp lookups.** A handoff written
  in the same millisecond as another gets a `-2` suffix, which the stamp
  pattern rejected, so reading it by stamp returned nothing.

## [1.5.1] - 2026-09-10

Found by resuming a real session on 1.5.0.

### Fixed

- **Heredoc commits in mechanical handoffs.** The stop and pre-compact
  hooks read the commit subject with a regex that only knew `-m "..."`.
  A commit written as `-m "$(cat <<'EOF' ...` reported the literal
  `$(cat <<` as the decision, five times over. Both hooks now take the
  first line after the heredoc opener.
- **Pre-compact no longer shadows a fresh handoff.** The hook reused an
  existing handoff only when its reason was `compact`. A named handoff
  written by hand seconds before compaction lost to the mechanical one
  generated 200 ms later, and the session resumed on the worse of the
  two. Any handoff inside the freshness window is reused now.
- **Handoff writes strip leaked parameter markup.** One live handoff
  carried `</currentTask>` and the whole `completed` array as text in
  its task field while `completed` itself was empty. `writeHandoff`
  sanitises every string before it lands, so every writer is covered.

## [1.5.0] - 2026-09-10

### Added

- **`grade --all`.** Grades every Claude Code transcript on the machine
  and records recall outcomes, so a store that predates inferred
  outcomes gets its history back. Each search is still graded once.
- **`repair`.** Re-ingests memories whose child pieces the chunker had
  cut mid-sentence, so they are embedded fresh and re-pieced with the
  fixed splitter; trims derived summaries the old heuristic cut
  mid-word to their last whole sentence; lifts user-stated corrections
  and preferences to the instruction floor. `--dry-run` reports.
- **Consolidation summaries end on a sentence.** The heuristic
  summariser took the first 100 characters of a memory and cut wherever
  that fell, and the LLM path capped at 150 tokens with no trim; 46
  derived summaries on a live store ended mid-word. Both now trim to
  whole sentences.
- **Rules extract from whole memories.** The backfill read child pieces
  and skipped parents, so rules were extracted from text that could
  start mid-thought and carried no label. It now reads parents and
  standalone memories only.
- **Instruction floor.** Corrections and preferences with `origin:
  user` no longer decay below 0.5 in either decay path. A rule the user
  set does not become less true with age; 314 of them had reached the
  0.15 floor on a live store.
- **Chunker tests**, the first the chunker has had.

### Changed

- **One sentence splitter.** The chunker and the rule extractor both
  split at `[.!?]` with no protection for abbreviations or backticks,
  which is how memories came to be stored ending in "(e.g." for
  months. Both now use `splitSentences`, which masks backtick spans
  and "e.g.", "i.e.", "etc." and "vs." before splitting.
- **Chunker threshold stays at 500, on evidence.** Raising it to 1200
  was tried: a long memory is stored whole as a parent plus child
  pieces, and the pieces are what retrieval finds. On a golden set of
  24 paraphrased questions, recall at 5 was 0.79 with pieces and 0.33
  with parents alone. After this release's repairs, the instruction
  floor and the outcome backfill, the same questions score recall at 1
  0.50, at 5 0.83, at 10 0.92, mean reciprocal rank 0.64, up from 0.42,
  0.79, 0.88 and 0.58.
- **`grade` output** documents that `graded` counts searches while
  `helpful` and `irrelevant` count chunks.

## [1.4.0] - 2026-09-09

### Added

- **Inferred recall outcomes.** The feedback loop behind promotion,
  decay and edge strengthening was fed only by an agent calling
  `memory-outcome`, and agents do not: one measured session made five
  searches, seven ingests and zero outcome calls. The stop hook now
  grades `memory-search` results from the transcript with no LLM. Once
  a search has had a few assistant turns to prove itself, each returned
  chunk is checked against what the assistant said or did afterwards;
  a path or an id on its own counts, two identifiers count, prose does
  not. Used is recorded `helpful`, unused is `irrelevant`. A new
  SessionEnd hook grades whatever is left with no wait. `corrected` is
  never inferred, because a substring check cannot tell a wrong memory
  from an unused one. New CLI: `przm-memory-mcp grade`.
- **Session-start context.** A SessionStart hook prints the latest
  handoff (or the crash checkpoint if that is newer), the standing rules
  ranked by reinforcement, the high-importance corrections and
  preferences, and memories whose domain matches the working
  directory. Claude Code adds the output to the session before the
  first message, so none of it depends on the agent remembering to
  ask. Capped at about 10k characters; prints nothing if the store is
  unreachable. New CLI: `przm-memory-mcp context`.
- **Rule scope.** A procedural rule now carries a `scope`: empty means
  everywhere, otherwise the project slug of the memory it came from, or
  a project named in the memory's label ("Stave-admin workflow rule:")
  carried forward to the memory's later sentences. Session-start
  context and `formatRulesForPrompt` show a project's rules only inside
  that project. The file adapter adds the column in place on open.
- **`przm-memory-mcp rules list | rebuild`.** The table is a function of
  the correction and preference chunks and the extractor; `rebuild`
  throws it away and derives it again, grouped by project, with
  starting confidence seeded from each source memory's importance.

### Changed

- **Rule extraction is a directive gate.** The heuristic extractor fired
  on any sentence containing "always" or "never", so narrative like
  "the fix was never half-applied" and facts like "corpse_fx.gd is never
  saved" became standing rules, and one long memory became several
  rows. A sentence now has to start as an instruction after an optional
  label and an optional scoping clause; narration, first-person
  accounts, facts and fragments do not. The sentence splitter no longer
  breaks inside backticks or after "e.g.", and text the chunker visibly
  cut mid-sentence is refused. The LLM prompt says a rule is about how
  the user works, not what to build.
- **Restatements reinforce instead of duplicating.** Matching compares
  content words with dates, quotes and names stripped, on the directive
  rather than its label, and accepts strong overlap or the shorter rule
  sitting mostly inside the longer one. Semantic restatements with
  different vocabulary stay separate; that is the LLM path's job.
- **Session-start rendering dedupes by ingest source** and strips
  tool-call markup that had leaked into chunk content, and the rules
  floor is 0.35 rather than 0.5 because seeded confidence from decayed
  memories sits lower than the old flat 0.5.
- **`hooks/` ships in the package** so an installed copy carries its own
  hooks.

### Fixed

- **Voice bridge inflated confidence on every pass.** `importRulesFromBridge`
  bumped every matched rule by 0.05 on every maintenance run whether the
  bridge entry had changed or not, and read a file hardcoded under
  `$HOME` even from inside the test suite; that was the standing
  `reembed-maintenance` failure. A bridge entry now reinforces a rule
  only when it is newer than the rule, and the path is read at call time
  and overridable with `PRZM_MEMORY_BRIDGE_PATH`.
- **Crash checkpoint was unreadable.** The stop hook writes one plain
  `session-checkpoint.json` with no name and no stamp, so neither of
  `readHandoff`'s lookups could see it. Session-start context reads it
  by path.
- **Build stripped the executable bit** from `dist/server.js`,
  `dist/cli.js` and `dist/migrate.js`, so linked binaries broke after
  every rebuild until someone chmodded them. The build script restores
  it.

## [1.3.0] - 2026-09-01

### Added

- **Short-term -> archive lifecycle.** Short-term was a terminal tier:
  demotion only ran on long-term, so never-recalled default-importance
  chunks accumulated forever (a live store had 1491 of them). Stale
  short-term chunks (older than `shortTermRetentionDays`, zero recalls,
  importance below the promotion threshold, origin not `user`) now
  archive during consolidation. The `dailyRetentionDays`,
  `shortTermRetentionDays`, and `longTermRetentionDays` config knobs are
  now actually read instead of hardcoded constants, and a
  tier-lifecycle test pins the full daily -> short-term -> long-term ->
  archive path.
- **LLM knowledge-graph extraction.** When an LLM is configured,
  maintenance extracts triples with a closed 15-predicate vocabulary in
  bounded batches: a one-shot backfill over existing long-term chunks
  plus an incremental pass over chunks created since the last run. The
  regex extractor stays as the per-ingest fallback. The backfill stamp
  is only written when the LLM was actually available, so configuring a
  model later still triggers it.
- **`budgetTokens` on memory-search.** Greedy token-budget fill (score
  x importance) applied to search results, sharing the memory-budget
  implementation.
- **Diary auto-digest.** Daily maintenance writes a short digest of the
  day's ingest activity to the diary when no entry exists for the day,
  so the diary stays alive without any agent calling memory-diary-write.
- **Degraded-features surfacing.** memory-stats now lists which
  subsystems are running in heuristic mode when no LLM is configured,
  with a hint for enabling one.

### Changed

- **`engram-*` aliases are now opt-in.** Set
  `PRZM_MEMORY_LEGACY_ALIASES=1` to register the 20 legacy aliases.
  Off by default: they doubled the tool surface every MCP client paid
  schema tokens for on every session.
- **Graph rerank (lite) is now the default on memory-search.** It
  self-no-ops on stores without graph data; pass `graphRerank: false`
  for pure similarity ranking. Both rerank modes now fetch the triple
  store once per call instead of once per candidate.
- **Removed the LLM listwise reranker from the memory-search handler.**
  It ran on every search the moment an API key was configured, adding
  0.5-2s latency for a ranking pass the benchmarks showed hurts
  (DEBT-009). The benchmarked search path never included it, so
  published numbers now describe production behavior. `selectRelevant`
  stays exported for the benchmark harnesses.
- **Taxonomy normalization.** Ingest now strips wrapping quotes,
  brackets, and whitespace from domain/topic and lowercases domains; a
  conservative maintenance pass rewrites existing rows to the same
  canonical form (case/quote/whitespace variants only, no fuzzy
  merging).
- **listChunks memo.** Search no longer pays a full-corpus LanceDB read
  per query for IDF scoring; the Storage shim caches list results and
  drops the cache on any chunk mutation (see DEBT-021 for the real
  BM25 fix).
- **Trimmed server instructions.** The shouty six-step MANDATORY block
  is now three declarative lines; behavioral triggers live in the tool
  descriptions (R-008).

### Fixed

- **Bundled hooks wrote to the wrong data dir.** The stop/precompact
  hooks defaulted to `~/.claude/engram` and ignored
  `PRZM_MEMORY_DATA_DIR`; checkpoint handoffs landed where the server
  never read them. The env fallback chain is now
  `PRZM_MEMORY_DATA_DIR` > `ENGRAM_DATA_DIR` > `SMART_MEMORY_DATA_DIR`
  > `~/.claude/przm-memory`.
- **Stale slash commands.** The shipped `.claude/commands/*.md` and
  `hooks/README.md` referenced dead `engram-*` tool names, including
  `engram-check-duplicate` which no longer exists (dedupe is inline in
  memory-ingest).
- **Doc corrections.** README tool count (29, not 20), BENCHMARKS.md
  title and clone URL (przm-memory, not engram-mcp).

## [1.2.0] - 2026-07-07

### Added

- **`onboard` prompt (slash command).** The server now exposes an MCP
  prompt that Claude Code surfaces as a slash command (e.g.
  `/przm-memory (MCP) -> onboard`). It runs a guided onboarding for a
  fresh install: assess what rules already exist, interview the user for
  their durable rules and preferences (identity/attribution, emails,
  communication style, code + workflow conventions, hard rules, project
  scoping), store each as a `preference`/`correction` memory so it
  extracts into a procedural rule and (when przm-voice is connected)
  syncs into tone, and optionally add a przm-memory usage block to
  CLAUDE.md. Reachable on any MCP-connected install with no plugin or
  file copying. Safe to re-run to add more.

### Fixed

- **Search recall-stat writes are batched.** Every search bumps
  `recallCount` + `lastRecalledAt` on each returned chunk; that was one
  per-row LanceDB update apiece, and each writes a fresh fragment. A busy
  day of searches left thousands of fragment versions that only got
  reclaimed at the daily maintenance, so the store drifted into the
  hundreds of MB between runs. The bump is now a single `mergeInsert` per
  search (full-row upsert, embedding preserved), collapsing a search's
  writes into one version. Covered by `tests/recall-bump-batch.test.ts`,
  which pins that the upsert never clobbers the stored embedding.

## [1.1.1] - 2026-07-07

### Fixed

- **Consolidation is no longer O(hours) on real stores.** `consolidate()`
  issued a separate LanceDB point-update per chunk, and its decay/link
  passes touch nearly every row — on a ~1,300-chunk store that was
  thousands of serialized scan-and-rewrite operations, made far worse by
  fragment bloat (see below). One full pass took over 1.5 hours. It now
  buffers every update/delete and commits them as a single `mergeInsert`
  upsert + bulk delete + compaction: the same store consolidates in ~30s.
  New `Storage.beginBatch()` / `flushBatch()` and the adapter primitives
  `updateChunks` / `deleteChunks` / `optimizeChunks` back it.
- **`reembed` no longer bloats the store 15x.** The re-embed loop wrote
  one fragment per chunk with no compaction, so two passes grew a 260MB
  store to ~4GB of dead versions (which is what made consolidation
  pathological). It now batches the upserts and prunes old versions at
  the end.
- **Auto-maintenance now compacts.** Each consolidation flush prunes
  versions older than an hour, so per-search recall-stat writes and each
  pass stop silently re-bloating the store.

### Added

- **`przm-memory-mcp compact`** — prune non-current table versions and
  reclaim disk. Recovers stores already bloated by pre-1.1.1 writes (a
  live 4.2GB store compacted to 23MB with no data loss).

## [1.1.0] - 2026-07-07

### Changed

- **Default embedding model upgraded to `Xenova/bge-small-en-v1.5`**
  (same 384 dims, substantially better retrieval than MiniLM-L6-v2 on
  BEIR-style benchmarks). Model selection moved behind
  `getEmbeddingModelName()` with a new `PRZM_MEMORY_EMBEDDING_MODEL`
  env var (legacy `ENGRAM_EMBEDDING_MODEL` / `SMART_MEMORY_EMBEDDING_MODEL`
  still honored). Retrieval knobs that are model-family-specific —
  query-side prefix, vector similarity floors, dedupe thresholds — now
  come from a per-family profile (`getEmbeddingModelProfile()`), with
  BGE floors calibrated empirically — first against the alien-query
  corpus, then corrected against the live 1.3k-chunk store, where
  long contextual-prefixed memories compress relevant hits to
  ~0.46-0.55 (floor 0.42; synthetic alien noise tops out at 0.503).

- **Consolidation now runs automatically.** `consolidate()` used to fire
  only on a manual `memory-maintain` call, which in practice never
  happened — chunks sat frozen in short-term forever. The server now
  schedules a maintenance pass ~20s after boot when the last run is
  older than `PRZM_MEMORY_MAINTAIN_INTERVAL_HOURS` (default 24), plus
  an interval timer for long-lived processes. Disable with
  `PRZM_MEMORY_AUTO_MAINTAIN=0`. State in `<dataDir>/maintenance.json`.

- **Procedural rules extract automatically.** `memory-ingest` with
  `type: preference` or `type: correction` now runs the rule extractor
  over the content (LLM when a key is set, heuristic patterns
  otherwise). The first maintenance pass also replays existing
  preference/correction chunks through the extractor once (stamped in
  `maintenance.json` so confidence is never re-reinforced). New
  heuristic patterns for the `rule: ...` and bare `prefers X`
  phrasings that ingested memories actually use.

### Added

- **`przm-memory-mcp reembed`** — re-embeds the whole corpus with the
  active model (with `--dry-run`). An `embedding-meta.json` marker in
  the data dir records which model the corpus was embedded with; the
  server warns loudly at boot when it mismatches the active model, and
  `memory-stats` reports `corpusEmbeddedWith` / `reembedNeeded`.
  Stores that predate the marker are assumed to be MiniLM (the old
  default). Resolves DEBT-008.

### Fixed

- **Ingest dedupe was inert under RRF.** The duplicate check filtered
  on `score >= 0.75`, but RRF composite scores top out near ~0.07, so
  no ingest was ever flagged as a duplicate. Search results now carry
  `vectorSimilarity` (raw cosine, 0..1) alongside the composite score;
  dedupe and its recommendation ladder run against that, with
  thresholds from the model profile. `memory-search` results and the
  CLI expose the same field, and CLI `--min-relevance` filters on it.

## [1.0.3] - 2026-05-21

### Fixed

- **`npx @onenomad/przm-memory` crashed on startup with
  `ERR_MODULE_NOT_FOUND` for `web-streams-polyfill/dist/ponyfill.mjs`.**
  Root cause: `openai@^4.80` → `formdata-node@4.4.1` does a deep
  `import 'web-streams-polyfill/dist/ponyfill.mjs'`, but
  `formdata-node@4.4.1` itself declares a dependency on
  `web-streams-polyfill@4.0.0-beta.3` — and v4 dropped the `.mjs`
  file from `dist/` (only exposes it through the `exports` field as
  `./dist/ponyfill.js`). The deep import resolved against v4 and
  blew up before the MCP transport ever started. Fixed by pinning
  `web-streams-polyfill` to `^3.3.3` via the package's `overrides`
  field, which still has `dist/ponyfill.mjs` as a real file. No code
  changes required.

## [1.0.2] - 2026-05-20

### Added

- **`src/version.ts`** — single source of truth for the MCP server's
  self-reported version. Reads `package.json` once at startup and
  caches the result. Replaces the hardcoded `'1.0.0'` string in
  `server.ts` that drifted as soon as v1.0.1 shipped earlier today.
  The MCP server now identifies itself as `przm-memory@1.0.2` instead
  of `przm-memory@1.0.0` in client logs and the MCP debugger.
- **`warmEmbeddings()` in `llm.ts`** — exported helper that triggers
  the embedding-model pipeline construction. The server now fires
  this in the background after `server.connect(transport)` so the
  ~1.5–5s ONNX cold-start cost (or the 10–30s first-time model
  download) happens during the MCP handshake + user's "what should I
  ask?" think-time, instead of inside the user's first
  `memory-search`. No-op when `ENGRAM_SKIP_EMBED=1`. Failures are
  swallowed (server logs the warning but stays up; `embed()` continues
  to fall through to keyword-only mode on demand).

### Performance

- **First-query latency drops by the full embedding cold-start cost.**
  Previously: user opens an MCP client, server boots, accepts the
  first `memory-search`, then spends 1.5–5s loading the embedding
  pipeline before any results come back. Now: pipeline starts loading
  the moment the server connects, so the first search either finds it
  ready (typical case) or only waits for the residual load time. Hot
  path is unchanged — this only affects the very first query in each
  server process.

## [1.0.1] - 2026-05-20

### Security

- **Storage routing is no longer silent.** Every startup now logs the
  resolved backend to stderr (`przm-memory: storage=…`), naming the
  reason (explicit env var, auto-routed via credentials file, default
  file mode). Previously a stale `~/.pyre/credentials.json` would
  silently route writes to przm Cloud with no on-screen signal — a
  shared machine, a benchmark adapter, or a local script could leak
  memories to the wire without the operator noticing.
- **`ENGRAM_NO_AUTO_CLOUD=1` opt-out.** New escape hatch that suppresses
  the credentials-file probe entirely. The file is left in place,
  explicit `STORAGE_BACKEND=cloud` still works, but the implicit
  auto-route is disabled. Use this in benchmarks, CI, and local dev
  against a real credentials file you don't want consulted.

### Changed

- **Corrupt credentials file no longer crashes the server.** If
  `~/.pyre/credentials.json` exists but fails validation (malformed
  JSON, missing fields), the factory now falls through to local file
  mode and logs the fallback explicitly, rather than throwing inside
  the cloud branch when `readCredentials` returns null.

## [1.0.0] - 2026-05-19

Initial public release on npm under the `przm` umbrella. Prior internal development happened under the `engram` / `@onenomad/engram-mcp` name; that package is deprecated in favor of this one. The repo, package, and version line all start fresh at 1.0.0.

### Added

- **Hybrid retrieval pipeline.** Nine-stage search combining vector ANN (LanceDB, 384-dim MiniLM), IDF-weighted keyword scoring, temporal window retrieval, knowledge graph lookup, and spreading activation. Verified 96.8% R@5 / 98.8% R@10 on LongMemEval (n=500) and 91.9% R@10 / 85.5% R@5 on LoCoMo (n=1,986); both result JSONs committed under `benchmarks/results/published/`.
- **Memory tiers + lifecycle.** `scratch` (24h auto-purge) → `daily` (2d) → `short-term` (14d) → `long-term` (90d) → `archive`, with promotion driven by recall frequency, importance, and feedback signals.
- **Memory origin tags.** Every chunk carries `user` / `extracted` / `imported` / `derived`. User-origin memories are excluded from auto-merging, near-duplicate deletion, and archival decay.
- **Cognitive layers.** Episodic / semantic / procedural classification with layer-specific decay rates.
- **Procedural rules.** Learned from corrections and instructions. Confidence asymmetry: reinforcement +0.1, contradiction -0.2.
- **Knowledge graph.** Entity-relationship triples with temporal validity (`validFrom` / `validTo`). 12 relationship types auto-extracted at ingest. Tools: `engram-kg-add`, `engram-kg-query`, `engram-kg-invalidate`, `engram-kg-timeline`.
- **Reconsolidation, adaptive forgetting, self-organizing memories, duplicate detection** during the consolidation pass.
- **Governance middleware.** Advisory contradiction detection, semantic drift monitoring, and memory poisoning checks via `engram-govern`.
- **Handoff protocol.** `engram-handoff-write`, `engram-handoff-read`, `engram-context-pressure` for cross-session continuity. Two bundled Claude Code hooks (`engram_precompact_hook.sh`, `engram_stop_hook.sh`) automate handoff writes before `/compact` and at session end.
- **Persona bridge.** Coordinates with [`@onenomad/przm-voice`](https://github.com/OneNomad-LLC/przm-voice) when both servers run: emotion-weighted memory importance, cognitive-load-gated search results, and a procedural-bridge file (`~/.claude/procedural-bridge.json`) that syncs learned rules between Memory and Voice.
- **20 MCP tools across six groups:** core memory, knowledge graph, diary, handoff, governance, import.
- **7 slash commands:** `/memory-source`, `/recall`, `/forget`, `/memory-health`, `/memory-api`, `/knowledge`, `/memory`.
- **Storage backends.** `file` (default — LanceDB + filesystem), `postgres` (multi-tenant via pgvector), and `cloud` (przm Cloud, opt-in via `przm-memory login`).
- **`przm-memory login` / `logout` CLI** for przm Cloud pairing. Credentials at `~/.pyre/credentials.json` (mode 0600).
- **Engines requirement:** `node >=22.0.0`.

### Security

- **Path traversal hardening** in `engram-handoff-read`: `STAMP_RE` is anchored and a defense-in-depth `isSafeHandoffIdentifier()` rejects identifiers containing `/`, `\`, `..`, or NULL bytes.
- **Windows browser-open RCE prevented:** the login flow opens URLs via `rundll32.exe url.dll,FileProtocolHandler` (no shell layer) and validates URLs through `isSafeBrowserUrl()` (http/https only, no control or shell-significant chars).
- **LIKE-pattern injection patched** in `storage-file`'s tag filters: `escLike()` escapes `\`, `%`, `_` with an explicit `ESCAPE '\'` clause. Both `esc()` and `escLike()` reject NULL bytes.
- **Storage routing isolation:** benchmark harnesses force `STORAGE_BACKEND=file` at module load to prevent silent auto-routing to przm Cloud when a credentials file exists on the host.
- **Data directories created with mode 0700** (owner-only) for `storage-file`, `diary`, `handoff`, `session-state`, and `procedural-bridge`. Memory data isn't world-readable on multi-user systems.

[Unreleased]: https://github.com/OneNomad-LLC/przm-memory/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OneNomad-LLC/przm-memory/releases/tag/v1.0.0
