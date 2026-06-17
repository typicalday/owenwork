# Build Plan: `oweflow trace <wf>`

**Workflow:** wf_f15092aa509c7346ff0a0481  
**Run:** run_ca14004c3e36d908e299adaf  
**Brief:** /tmp/owf-pr2-brief.md  
**Verification:** `npm run check` (tsc --noEmit + full test suite)

---

## Goal

Add a `trace` command that produces a derived causal timeline (every run in
chronological order, what it consumed, what it conceptually produced) plus a
per-artifact biography (the artifact's current state + its full `reasons` event
thread). This is a pure read/derivation over existing `run` + `artifact` rows —
no schema changes, no new stored log.

---

## Surfaces verified in codebase (read-only check)

All of the following match the brief's description exactly:

| Surface | File | Status |
|---|---|---|
| `SCHEMA` const (run table, artifact table) | src/store.ts:61–126 | Confirmed. `run` has `id, workflow, loop, key, outcome, summary, session_id, fingerprint, created_at, updated_at`. Index `run_wf_loop ON run(workflow, loop, created_at)` exists. |
| `mapRun` mapper | src/store.ts:219–234 | Confirmed. Deserializes `RunRowRaw` → `RunRow`. Handles null `outcome`/`summary`/`session_id`/`fingerprint` as `undefined`. |
| `mapArtifact` mapper | src/store.ts:157–177 | Confirmed. |
| `getRun` / `latestRun` / `listArtifacts` | src/store.ts | Confirmed. `listArtifacts(workflow)` is `SELECT * FROM artifact WHERE workflow = ? ORDER BY path`. |
| `plainConsumes` / `mapConsume` / `reduceConsume` | src/model.ts:51–66 | Confirmed and exported. |
| `collectionStem` / `loopMode` | src/model.ts:62–66, 72–74 | Confirmed and exported. |
| `workflowStatus` | src/model.ts:447–481 | Confirmed. Pure function, uses `ArtifactMap`. |
| `ReasonEntry` | src/types.ts:52–60 | Confirmed. `{ at, action, kind, by, text, fromVersion? }`. |
| `Run` (called `RunData`) | src/types.ts:99–108 | Confirmed. |
| `WorkflowDef` | src/types.ts:163–172 | Confirmed. Has `loops: LoopDef[]` where each loop has `.produces: ProducePattern[]`. |
| `parseArgs` / `openCtx` / `dispatch` switch | src/cli.ts:62–356 | Confirmed. `need()` for positionals, `last()` for option values, `flag()` for booleans, `print()` for JSON output. |
| `USAGE` string | src/cli.ts:178–201 | Confirmed. Plain text block updated per command. |
| `status` / `show` cases pattern | src/cli.ts:253–278 | Confirmed. Pattern: `need(args, 1, 'workflow')` then store/engine call then `print(io, result)`. |
| `src/index.ts` re-exports | src/index.ts | Confirmed. Exports model functions + types by name. |

Additional relevant helpers in `src/model.ts` (private but available for reference):
- `singletonProduces(loop)` — returns `loop.produces.filter(p => p.kind === 'singleton')`
- `collectionProduces(loop)` — returns `loop.produces.filter(p => p.kind === 'collection')`
- `mapProduce(loop)` — returns `loop.produces.find(p => p.kind === 'map')`

These are not exported today. The `buildTrace` function will need to derive
`producedStems` from a loop — it can either inline the same logic or the builder
can expose the `singletonProduces`/`collectionProduces`/`mapProduce` helpers as
named exports alongside `buildTrace`. Prefer exporting them to avoid duplication.

---

## Files to touch

1. **`src/types.ts`** — add `WorkflowTrace`, `TimelineEvent`, `ArtifactBiography` types
2. **`src/store.ts`** — add `Store.listRuns(workflow): RunRow[]`
3. **`src/model.ts`** — add `buildTrace(def, artifacts, runs): WorkflowTrace`; export `singletonProduces`, `collectionProduces`, `mapProduce` as named exports (they are already module-level functions, just unexported)
4. **`src/cli.ts`** — add `trace` case to `dispatch` switch; update `USAGE` string
5. **`src/index.ts`** — re-export `buildTrace`, `WorkflowTrace`, `TimelineEvent`, `ArtifactBiography`, `singletonProduces`, `collectionProduces`, `mapProduce`
6. **`test/store.test.ts`** — add `listRuns` test
7. **`test/model.test.ts`** — add `buildTrace` unit test
8. **`test/cli.test.ts`** — add `trace` CLI test (JSON + `--format text`)

---

## Step 1: Types (`src/types.ts`)

Append the following interfaces after the existing exported types (after `InputDef`).
Do not modify any existing type.

```typescript
// ---- trace types (§17 derived view: temporal causal timeline) ----------------

/**
 * One chronological event in the workflow's execution history: a single run
 * from claim to close. The causal links (consumedInputs, producedStems) are
 * derived from the run's fingerprint and the workflow definition respectively.
 *
 * NOTE on causality: `producedStems` is structural (from the def) — we know
 * which stems this loop is responsible for, but there is no stored FK linking
 * a specific run to the artifact version it produced. `consumedInputs` is from
 * the run's fingerprint (what versions of inputs were live at claim time) —
 * this IS a stored fact. The causal edge "run R produced version N of stem S"
 * is an inference, not a guarantee; see WorkflowTrace.inferenceNote.
 */
export interface TimelineEvent {
  seq: number;               // 1-based sequence number, stable across renders
  at: number;                // run.createdAt (ms since epoch)
  endedAt: number;           // run.updatedAt (ms since epoch, last mutation)
  loop: string;              // loop name
  key: string;               // binding key ("" for plain/reduce, element path for map)
  outcome: string | undefined; // 'ok' | 'no_work' | 'failed' | 'skipped' | undefined (open)
  summary: string | undefined;
  sessionId: string | undefined;
  /**
   * The versions of consumed inputs at claim time (run.fingerprint).
   * Absent if the run was claimed without a fingerprint (should not happen in
   * normal operation, but open/zero-output runs may lack one).
   */
  consumedInputs: Fingerprint | undefined;
  /**
   * The stems this loop is declared to produce (from the def), not from a
   * stored link. For map loops this is the map pattern stem (e.g.
   * "gather.source[$i].formatcheck"); for collection producers it is the
   * collection stem (e.g. "gather.source"); for singletons it is the stem name.
   * This is structural, not temporal — it tells you what the loop *could*
   * produce, not which version it produced in this specific run.
   */
  producedStems: string[];
}

/** The lifecycle biography of one artifact: its current state + full event thread. */
export interface ArtifactBiography {
  path: string;
  producer: string;          // loop name
  terminal: boolean;
  acceptance: Acceptance;
  version: number;
  judgmentRejects: number;
  schemaRejects: number;
  /**
   * The artifact's append-only reason thread, already in chronological order
   * (each entry was appended at action time; the array is authoritative).
   * Contains every reject/retract/skip/reopen/retry/born-rejected/schema-reject
   * that touched this artifact, across all versions.
   */
  events: ReasonEntry[];
}

/** The full derived trace for one workflow instance. */
export interface WorkflowTrace {
  workflow: string;
  /**
   * Chronological firing log, ordered by run.createdAt then rowid-stable
   * insertion order (no two rows with the same createdAt should exist in
   * practice, but the sort is stable: the secondary tiebreak is the run id,
   * which is a random string — this gives a deterministic ordering even in
   * test environments where nowMs() does not advance between insertions).
   */
  timeline: TimelineEvent[];
  /** One biography per artifact, ordered by path. */
  artifacts: ArtifactBiography[];
  summary: {
    totalRuns: number;
    byOutcome: Record<string, number>; // 'ok'|'no_work'|'failed'|'skipped'|'open' → count
    totalRejects: number;              // sum of all reasons with action 'reject'|'born-rejected'|'schema-reject' across all artifacts
    totalRetries: number;              // sum of all reasons with action 'retry' across all artifacts
    stalledArtifacts: string[];        // paths of artifacts that are currently stalled (acceptance=rejected AND judgmentRejects≥producer.maxAttempts OR schemaRejects≥producer.maxSchemaFailures)
    done: boolean;                     // reuses workflowStatus(def, arts).done
  };
  /**
   * Honest representation of the inference gap: a green run does not append a
   * ReasonEntry and there is no stored produced_by_run FK. The causal edge
   * "run R produced version N of artifact A" is inferred by matching:
   *   - the loop that produced A (from A.producer = run.loop)
   *   - ordered by run.createdAt — the Nth 'ok' run of loop L is the likely
   *     producer of version N of that loop's output
   * This is a heuristic and not guaranteed to be correct in the presence of
   * concurrent processes or clock skew. Do not rely on it for correctness
   * decisions; it is provided only for human readability.
   */
  inferenceNote: string;
}
```

---

## Step 2: Store method (`src/store.ts`)

Add after the existing `recentFailedRuns` method (line ~536), before the closing
brace of the `Store` class:

```typescript
  /**
   * All runs for a workflow instance, ordered by created_at then rowid for a
   * stable insertion-order tiebreak (consistent with recentFailedRuns and the
   * run_wf_loop index). The rowid tiebreak matters in test environments where
   * nowMs() may not advance between successive insertions.
   */
  listRuns(workflow: string): RunRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM run WHERE workflow = ? ORDER BY created_at, rowid',
      )
      .all(workflow) as RunRowRaw[];
    return rows.map(mapRun);
  }
```

Pattern notes:
- Uses the existing `prepare().all()` pattern (same as `listArtifacts`, `listWorkflows`).
- Uses the existing `RunRowRaw` interface and `mapRun` mapper — no new types needed.
- The existing index `run_wf_loop ON run(workflow, loop, created_at)` covers `WHERE workflow = ?` with a partial index scan; no new index needed.

---

## Step 3: Pure trace builder (`src/model.ts`)

### 3a. Export three private helpers

Change `function singletonProduces`, `function collectionProduces`, and
`function mapProduce` from unexported to exported by adding `export` keyword:

```typescript
export function singletonProduces(loop: LoopDef): ProducePattern[] { ... }
export function collectionProduces(loop: LoopDef): ProducePattern[] { ... }
export function mapProduce(loop: LoopDef): ProducePattern | undefined { ... }
```

These are already module-level functions at lines 68–79. Only the `export`
keyword is added; signatures and bodies are unchanged.

### 3b. Add imports in `src/model.ts`

Add to the existing import from `'./types.ts'`:
```typescript
import type {
  ...
  RunData,         // already in RunData (used for RunRow shape ref — actually import RunRow shape via RunData)
  WorkflowTrace,
  TimelineEvent,
  ArtifactBiography,
} from './types.ts';
```

Note: `RunRow` is from `store.ts` (extends `RunData` with `id`, `createdAt`,
`updatedAt`). The `buildTrace` function must accept `RunRow[]` (from store) and
`ArtifactRow[]` (from store). Import these types:

```typescript
import type { ArtifactRow, RunRow } from './store.ts';
```

Actually, `buildTrace` should accept the minimal types needed to keep model.ts
from having a circular dependency on store.ts. Better approach: define the
function signature in terms of structural types, or accept the store rows by
duck-typing. The cleanest solution that avoids circular imports:

**Use inline structural types for the parameters:**

```typescript
export function buildTrace(
  def: WorkflowDef,
  artifacts: ReadonlyArray<ArtifactData & { id: string; updatedAt: number }>,
  runs: ReadonlyArray<RunData & { id: string; createdAt: number; updatedAt: number }>,
): WorkflowTrace
```

This matches `ArtifactRow` and `RunRow` structurally without importing from
`store.ts`, avoiding any risk of circular dependency. The builder can be called
with `ArtifactRow[]` and `RunRow[]` directly since they satisfy these structural
types.

### 3c. `buildTrace` implementation

Append at the end of `src/model.ts`, after the `SETTLED_STATES` re-export:

```typescript
// ---- trace builder (§17 derived temporal view) --------------------------------

/**
 * Build a causal timeline and per-artifact biographies for one workflow
 * instance. Pure — no DB, no clock, no IO. Same purity contract as
 * workflowStatus.
 *
 * Causality gap: a successful run does not append a ReasonEntry and there is
 * no stored FK from an artifact version back to its producing run. The
 * produced→consumed edges are therefore inferred (see WorkflowTrace.inferenceNote),
 * not stored facts. We represent this honestly: producedStems is derived from
 * the def (structural, not temporal) and consumedInputs is from the run
 * fingerprint (a stored fact at claim time).
 */
export function buildTrace(
  def: WorkflowDef,
  artifacts: ReadonlyArray<ArtifactData & { updatedAt?: number }>,
  runs: ReadonlyArray<RunData & { id: string; createdAt: number; updatedAt: number }>,
): WorkflowTrace {
  // --- step 1: build an ArtifactMap for workflowStatus reuse ---
  const artMap: ArtifactMap = new Map(artifacts.map((a) => [a.path, a]));

  // --- step 2: build the loop → producedStems map from the def ---
  // For map loops: the raw produce pattern string (e.g. "gather.source[$i].formatcheck")
  // For collection producers: the collection stem (e.g. "gather.source")
  // For singletons: the stem name (e.g. "plan", "pr")
  const loopProducedStems = new Map<string, string[]>();
  for (const loop of def.loops) {
    const stems: string[] = [];
    for (const p of singletonProduces(loop)) stems.push(p.stem);
    for (const p of collectionProduces(loop)) stems.push(p.stem);
    const mp = mapProduce(loop);
    if (mp) stems.push(mp.raw); // use the raw pattern (e.g. "gather.source[$i].check")
    loopProducedStems.set(loop.name, stems);
  }

  // --- step 3: build the timeline ---
  // Runs are already ordered by (created_at, rowid) from store.listRuns.
  // We re-sort here defensively in case caller passes unsorted input.
  const sortedRuns = [...runs].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id tiebreak (lexicographic, stable)
  });

  const timeline: TimelineEvent[] = sortedRuns.map((run, idx) => ({
    seq: idx + 1,
    at: run.createdAt,
    endedAt: run.updatedAt,
    loop: run.loop,
    key: run.key ?? '',
    outcome: run.outcome,
    summary: run.summary,
    sessionId: run.sessionId,
    consumedInputs: run.fingerprint,
    producedStems: loopProducedStems.get(run.loop) ?? [],
  }));

  // --- step 4: build artifact biographies ---
  // Count actions across all artifact reason threads for the summary.
  let totalRejects = 0;
  let totalRetries = 0;
  const stalledArtifacts: string[] = [];

  const biographies: ArtifactBiography[] = [...artifacts]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((art) => {
      for (const e of art.reasons) {
        if (e.action === 'reject' || e.action === 'born-rejected' || e.action === 'schema-reject') {
          totalRejects++;
        }
        if (e.action === 'retry') totalRetries++;
      }

      // Check stall: need the producer loop's caps
      const producerLoop = def.loops.find((l) => l.name === art.producer);
      if (producerLoop) {
        const stallJ = isStalled(art, producerLoop.maxAttempts);
        const stallS = isSchemaStalled(art, producerLoop.maxSchemaFailures);
        if (stallJ || stallS) stalledArtifacts.push(art.path);
      }

      return {
        path: art.path,
        producer: art.producer,
        terminal: art.terminal ?? false,
        acceptance: art.acceptance,
        version: art.version,
        judgmentRejects: art.judgmentRejects,
        schemaRejects: art.schemaRejects,
        events: art.reasons, // already chronological (append-only thread)
      };
    });

  // --- step 5: summary ---
  const byOutcome: Record<string, number> = {};
  for (const run of sortedRuns) {
    const k = run.outcome ?? 'open';
    byOutcome[k] = (byOutcome[k] ?? 0) + 1;
  }

  const status = workflowStatus(def, artMap);

  return {
    workflow: artifacts[0]?.workflow ?? '',
    timeline,
    artifacts: biographies,
    summary: {
      totalRuns: sortedRuns.length,
      byOutcome,
      totalRejects,
      totalRetries,
      stalledArtifacts,
      done: status.done,
    },
    inferenceNote:
      'producedStems is derived from the workflow definition (structural) and ' +
      'identifies which stems a loop is responsible for, not which version it ' +
      'produced in a specific run. consumedInputs is the run fingerprint (a ' +
      'stored fact at claim time). The causal edge run→artifact-version is an ' +
      'inference: the Nth ok run of loop L corresponds to version N of its ' +
      "output stems. This is a heuristic — no stored FK exists (by design, " +
      "to avoid schema changes).",
  };
}
```

**Edge cases handled:**

1. **Empty history (no runs):** `sortedRuns` is `[]`, `timeline` is `[]`, `byOutcome` is `{}`, `totalRuns` is 0. `workflowStatus` still works on the artifact map. All valid.

2. **A run with no fingerprint:** `run.fingerprint` is `undefined` → `consumedInputs: undefined`. This is honest: an open run (outcome still null) or a run that was inserted without a fingerprint will show `undefined`. Do not fabricate a fingerprint.

3. **Reduce/map keys:** The run's `key` field is preserved verbatim — for a map firing it is the element path (e.g. `"gather.source[2]"`), for plain/reduce it is `""`. The `producedStems` for a map loop includes the raw pattern string (e.g. `"gather.source[$i].formatcheck"`) which makes it clear which pattern was fired, even if the concrete element path is in `key`.

4. **Stalled artifacts:** Checked via the existing `isStalled` and `isSchemaStalled` predicates with the producer loop's caps. Artifacts whose producer loop is not found in the def (input artifacts with producer `"human"`) are not checked for stall (they have no caps).

5. **`artifact.updatedAt` limitation:** The brief notes that `updatedAt` is the *latest* touch, not a per-version timestamp. We use it as `endedAt` on the *run* row (which is accurate — the run's `updatedAt` is when the run record was last mutated). We do NOT use `artifact.updatedAt` as a per-version event timestamp. The biography only uses `ReasonEntry.at` for event timestamps, which are accurate.

6. **`workflow` field on the trace:** Taken from `artifacts[0]?.workflow`. If there are no artifacts (freshly-created instance with no materialized outputs yet), this will be `''`. The caller should not rely on this being set in that edge case, but it is more ergonomic than requiring `workflow` as a separate argument.

7. **No "reached version N" marker:** The brief says "optionally fold in a synthesized 'reached version N' marker per known green if you can do it from version alone without inventing timestamps." Since `artifact.updatedAt` is the *latest* touch only, we cannot accurately timestamp older versions. We do NOT inject synthetic events into the `events[]` array. The biography accurately reflects only the stored `reasons` thread. Honesty over convenience.

---

## Step 4: CLI command (`src/cli.ts`)

### 4a. Update `USAGE` string

Add `trace` to the Commands block:

```
  trace <wf> [--format text]             causal timeline + artifact biographies
```

Insert it after the `show <wf>` line (alphabetically, or logically after `show`
since both are read-only/debugging views).

### 4b. Add `trace` case to `dispatch` switch

Add after the `show` case (around line ~278), before the `list` case:

```typescript
case 'trace': {
  const wf = need(args, 1, 'workflow');
  const format = last(args, 'format') ?? 'json';
  const artifacts = store.listArtifacts(wf);
  const runs = store.listRuns(wf);

  // Resolve the def — the same path the `status` and `tick` cases use:
  // engine.status() internally resolves via the defResolver passed to Engine,
  // but for trace we need the def object directly. We can get it from ctx.defs
  // (loaded by openCtx) or by going through engine internals.
  // Safest: use ctx.defs.get(wfRow.def) — need the workflow row first.
  const wfRow = store.getWorkflow(wf);
  if (!wfRow) throw new CliError(`workflow not found: ${wf}`);
  const def = ctx.defs.get(wfRow.def);
  if (!def) throw new CliError(`unknown workflow definition '${wfRow.def}' (looked in ${ctx.defsDir})`);

  const trace = buildTrace(def, artifacts, runs);

  if (format === 'text') {
    // --- compact human-readable rendering ---
    io.out('=== Timeline ===');
    for (const ev of trace.timeline) {
      const ts = new Date(ev.at).toISOString();
      const keyPart = ev.key ? `[${ev.key}]` : '';
      const consumed = ev.consumedInputs
        ? JSON.stringify(ev.consumedInputs)
        : '(no fingerprint)';
      const produced = ev.producedStems.join(', ') || '(none)';
      io.out(`#${ev.seq} ${ts} ${ev.loop}${keyPart} ${ev.outcome ?? 'open'} — consumed ${consumed} produced [${produced}]`);
      if (ev.summary) io.out(`    summary: ${ev.summary}`);
    }
    io.out('');
    io.out('=== Artifacts ===');
    for (const art of trace.artifacts) {
      io.out(`${art.path}  (${art.acceptance}, v${art.version}, producer: ${art.producer})`);
      if (art.events.length === 0) {
        io.out('  (no lifecycle events)');
      } else {
        for (const ev of art.events) {
          const ts = new Date(ev.at).toISOString();
          io.out(`  ${ts}  ${ev.action}  by:${ev.by}  "${ev.text}"`);
        }
      }
    }
    io.out('');
    io.out(`=== Summary: ${trace.summary.totalRuns} runs, done=${trace.summary.done} ===`);
  } else {
    // default: JSON
    print(io, trace);
  }
  return;
}
```

**Import `buildTrace`** at the top of `cli.ts`:

```typescript
import { buildTrace } from './model.ts';
```

Add alongside the existing `Engine` import.

**Notes on the def resolution pattern:**
- `openCtx` already loads all defs from `defsDir` into `ctx.defs: Map<string, WorkflowDef>`.
- We need `wfRow.def` (the definition name, e.g. `"delivery"`) to look up the def.
- This is the same pattern that `statusEntry` uses indirectly via `engine.status(w.id)`.
- If the def is missing (e.g. the defs directory was moved), we throw a `CliError` with the same message as `openCtx`'s engine would throw.

---

## Step 5: Re-exports (`src/index.ts`)

Add to the existing model exports block:

```typescript
export {
  buildTrace,
  eligibleFirings,
  isSchemaStalled,
  isStalled,
  maintainDecisions,
  mapProduce,
  collectionProduces,
  singletonProduces,
  workflowStatus,
} from './model.ts';
export type {
  ArtifactBiography,
  ArtifactMap,
  Blocker,
  CascadeOp,
  Firing,
  TimelineEvent,
  WorkflowStatus,
  WorkflowTrace,
} from './model.ts';
```

Wait — `WorkflowTrace`, `TimelineEvent`, `ArtifactBiography` are defined in
`src/types.ts`, not `src/model.ts`. The type exports must come from the right
source:

```typescript
// in the types.ts re-export block:
export type {
  ...,
  ArtifactBiography,
  TimelineEvent,
  WorkflowTrace,
} from './types.ts';

// in the model.ts re-export block:
export {
  buildTrace,
  ...,
  collectionProduces,
  mapProduce,
  singletonProduces,
} from './model.ts';
```

---

## Step 6: Tests

### 6a. `Store.listRuns` test (add to `test/store.test.ts`)

```typescript
test('listRuns returns all runs for a workflow ordered by created_at, rowid', () => {
  const s = mem();
  const wf = randId('wf');
  const wf2 = randId('wf');

  // Insert runs with explicit timestamps to verify ordering
  const r1 = randId('run');
  const r2 = randId('run');
  const r3 = randId('run');
  s.insertRun(r1, { workflow: wf, loop: 'planner', key: '' }, 1000);
  s.insertRun(r2, { workflow: wf, loop: 'builder', key: '' }, 2000);
  s.insertRun(r3, { workflow: wf2, loop: 'other', key: '' }, 500); // different wf — must not appear

  // Close r1 with ok outcome so round-trip is verified
  s.updateRun(r1, { outcome: 'ok', fingerprint: { proposal: 1 } });

  const runs = s.listRuns(wf);
  assert.equal(runs.length, 2, 'only runs for wf, not wf2');
  assert.equal(runs[0]!.id, r1, 'ordered by created_at: r1 first');
  assert.equal(runs[1]!.id, r2, 'r2 second');
  assert.equal(runs[0]!.loop, 'planner');
  assert.equal(runs[0]!.outcome, 'ok');
  assert.deepEqual(runs[0]!.fingerprint, { proposal: 1 });
  assert.equal(runs[1]!.outcome, undefined, 'open run has undefined outcome');

  s.close();
});
```

Note: `insertRun` accepts an optional `at` parameter (line 463 in store.ts:
`insertRun(id, data, at = nowMs())`). Use this to inject deterministic
timestamps.

### 6b. `buildTrace` unit test (add to `test/model.test.ts`)

Drive real history through the Engine so the trace is validated against data the
engine actually writes. Use the `delivery` workflow definition (already defined
at the top of model.test.ts as a helper) and a `Store(':memory:')`.

```typescript
import { buildTrace } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { randId } from '../src/util.ts';

test('buildTrace: timeline order, consumedInputs, producedStems, and biography events', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery); // reuse the delivery def from the top of this file

  const wf = engine.createInstance('delivery', {
    provide: { proposal: { text: 'test proposal' } },
  });

  // 1. Planner fires successfully
  const tick1 = engine.tick(wf);
  assert.equal(tick1.orders.length, 1);
  const plannerOrder = tick1.orders[0]!;
  assert.equal(plannerOrder.loop, 'planner');
  engine.green(wf, plannerOrder.run, 'plan', { plan: 'v1' });
  engine.close(wf, plannerOrder.run, 'ok');

  // 2. Builder fires, gets rejected once (creating a ReasonEntry), then fires again
  const tick2 = engine.tick(wf);
  const builderOrder1 = tick2.orders.find((o) => o.loop === 'builder')!;
  assert.ok(builderOrder1, 'builder has an order');
  engine.green(wf, builderOrder1.run, 'pr', { pr: '#1' });
  engine.close(wf, builderOrder1.run, 'ok');

  // Reject the pr artifact (simulating reviewer verdict)
  engine.reject(wf, 'pr', 'reviewer', 'needs changes');

  // Builder fires again (retry)
  const tick3 = engine.tick(wf);
  const builderOrder2 = tick3.orders.find((o) => o.loop === 'builder')!;
  assert.ok(builderOrder2, 'builder has a second order after reject');
  engine.green(wf, builderOrder2.run, 'pr', { pr: '#2' });
  engine.close(wf, builderOrder2.run, 'ok');

  // 3. Build the trace
  const artifacts = store.listArtifacts(wf);
  const runs = store.listRuns(wf);
  const trace = buildTrace(delivery, artifacts, runs);

  // --- timeline assertions ---
  assert.ok(trace.timeline.length >= 3, 'at least 3 firings: planner, builder x2');
  // Seq numbers are 1-based and monotone
  for (let i = 0; i < trace.timeline.length; i++) {
    assert.equal(trace.timeline[i]!.seq, i + 1);
  }
  // Ordered by createdAt
  for (let i = 1; i < trace.timeline.length; i++) {
    assert.ok(trace.timeline[i]!.at >= trace.timeline[i - 1]!.at, 'timeline is chronological');
  }
  // The planner event has consumedInputs with proposal version
  const plannerEv = trace.timeline.find((e) => e.loop === 'planner')!;
  assert.ok(plannerEv, 'planner event exists');
  assert.ok(plannerEv.consumedInputs !== undefined, 'planner has a fingerprint');
  assert.ok('proposal' in (plannerEv.consumedInputs!), 'planner consumed proposal');
  // The planner's producedStems comes from the def
  assert.deepEqual(plannerEv.producedStems, ['plan'], 'planner produces plan');

  // Builder's producedStems
  const builderEvs = trace.timeline.filter((e) => e.loop === 'builder');
  assert.ok(builderEvs.length >= 2, 'two builder firings');
  for (const ev of builderEvs) {
    assert.deepEqual(ev.producedStems, ['pr'], 'builder produces pr');
  }

  // --- artifact biography assertions ---
  const prBio = trace.artifacts.find((a) => a.path === 'pr')!;
  assert.ok(prBio, 'pr biography exists');
  // pr was rejected once then retried — should have at least a 'reject' event
  const rejectEvents = prBio.events.filter((e) => e.action === 'reject');
  assert.ok(rejectEvents.length >= 1, 'pr has at least one reject event');
  // The reject event comes before subsequent events (append-only order)
  const firstRejectIdx = prBio.events.findIndex((e) => e.action === 'reject');
  const afterReject = prBio.events.slice(firstRejectIdx + 1);
  // There may be structural rejects (forward cascade) as well
  assert.ok(prBio.events.length >= 1, 'pr biography has events');

  // --- summary assertions ---
  assert.ok(trace.summary.totalRuns >= 3);
  assert.ok(trace.summary.totalRejects >= 1, 'at least one reject counted');
  assert.equal(typeof trace.summary.done, 'boolean');

  // --- inferenceNote is present and non-empty ---
  assert.ok(typeof trace.inferenceNote === 'string' && trace.inferenceNote.length > 0);

  store.close();
});
```

Note: The `Engine` import needs to be added at the top of `model.test.ts` for
this test. Alternatively, place this test in a new file `test/trace.test.ts` to
keep concerns separated — that is the cleaner choice since it also needs
`Store` and `Engine` imports not currently in `model.test.ts`. Prefer
`test/trace.test.ts`.

### 6c. CLI trace test (add to `test/cli.test.ts`)

Use the existing `makeCli()` helper:

```typescript
test('trace outputs valid JSON with timeline and artifacts fields', () => {
  const { run } = makeCli();
  const J = (v: unknown) => JSON.stringify(v);

  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // Run the planner so there is at least one run in the history
  const plannerOrder = run('tick', wf).json().orders[0];
  assert.ok(plannerOrder);
  run('green', wf, plannerOrder.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, plannerOrder.run);

  const r = run('trace', wf);
  assert.equal(r.code, 0, r.err);
  const trace = r.json();
  assert.ok(Array.isArray(trace.timeline), 'has timeline array');
  assert.ok(Array.isArray(trace.artifacts), 'has artifacts array');
  assert.ok(trace.timeline.length >= 1, 'timeline has at least one event');
  assert.equal(trace.timeline[0].loop, 'planner');
  assert.equal(trace.timeline[0].seq, 1);
  assert.ok(typeof trace.summary.done === 'boolean');
});

test('trace --format text is non-empty and contains a loop name and outcome', () => {
  const { run } = makeCli();
  const J = (v: unknown) => JSON.stringify(v);

  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const plannerOrder = run('tick', wf).json().orders[0];
  run('green', wf, plannerOrder.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, plannerOrder.run);

  const r = run('trace', wf, '--format', 'text');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.length > 0, 'text output is non-empty');
  assert.match(r.out, /planner/, 'output contains loop name "planner"');
  assert.match(r.out, /ok/, 'output contains outcome "ok"');
  assert.match(r.out, /Timeline/, 'output contains Timeline header');
  assert.match(r.out, /Artifacts/, 'output contains Artifacts header');
});

test('trace on a workflow with no runs still succeeds with empty timeline', () => {
  const { run } = makeCli();
  const J = (v: unknown) => JSON.stringify(v);

  // Create but never tick — no runs at all
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const r = run('trace', wf);
  assert.equal(r.code, 0);
  const trace = r.json();
  assert.deepEqual(trace.timeline, [], 'no runs means empty timeline');
  assert.ok(Array.isArray(trace.artifacts), 'artifacts still present');
  assert.equal(trace.summary.totalRuns, 0);
});

test('trace exits 1 when workflow is missing', () => {
  const { run } = makeCli();
  const r = run('trace');
  assert.equal(r.code, 1);
  assert.match(r.err, /missing required argument: workflow/);
});
```

---

## Step 7: Preferred test file structure

Rather than adding Engine/Store imports to `model.test.ts`, create a new file
`test/trace.test.ts` for the `buildTrace` unit test. This keeps model.test.ts
as a pure-model test and co-locates the integration-style trace test with its
own imports. The test runner glob `test/*.test.ts` already picks it up.

`test/trace.test.ts` imports:
- `{ test }` from `'node:test'`
- `assert` from `'node:assert/strict'`
- `{ Store }` from `'../src/store.ts'`
- `{ Engine }` from `'../src/engine.ts'`
- `{ buildTrace }` from `'../src/model.ts'`
- `{ def, input, loop }` from `'./helpers.ts'` (reuse the delivery fixture builder)

The `delivery` def for trace tests should match the one in `model.test.ts`
exactly (or be re-declared identically in `trace.test.ts`) to keep the file
self-contained.

---

## Execution order for the builder

1. **`src/types.ts`**: Add three interfaces (`WorkflowTrace`, `TimelineEvent`, `ArtifactBiography`). No existing code changes.

2. **`src/store.ts`**: Add `listRuns` method. Add `import type { WorkflowTrace }` is NOT needed here (store is pure data access). Just add the method.

3. **`src/model.ts`**:
   a. Add `export` keyword to `singletonProduces`, `collectionProduces`, `mapProduce`
   b. Add imports: `WorkflowTrace`, `TimelineEvent`, `ArtifactBiography` from `'./types.ts'`; `RunData` is already imported — no, wait: `RunData` is NOT currently imported in model.ts. We will NOT import `RunData` by name; instead we use structural inline types for the `runs` parameter.
   c. Append `buildTrace` function at the end, before the final closing brace of the module.

4. **`src/cli.ts`**:
   a. Add `import { buildTrace } from './model.ts';` near the top Engine import
   b. Update USAGE string
   c. Add `trace` case in switch

5. **`src/index.ts`**:
   a. Add `buildTrace`, `collectionProduces`, `mapProduce`, `singletonProduces` to the model exports
   b. Add `ArtifactBiography`, `TimelineEvent`, `WorkflowTrace` to the types exports

6. **`test/trace.test.ts`**: Create new file with `buildTrace` unit test driven through Engine.

7. **`test/store.test.ts`**: Add `listRuns` test.

8. **`test/cli.test.ts`**: Add four `trace` CLI tests.

---

## Verify

```
npm run check
```

This runs `tsc --noEmit` (full type check) then the full test suite
(`node --test test/*.test.ts`). The new `test/trace.test.ts` file is picked up
automatically by the glob. Zero new dependencies required.

---

## Key design decisions (summary)

### 1. Honesty of the run→artifact causality gap

The most critical design decision. A successful run does not append a
`ReasonEntry` and there is no stored FK from an artifact version to its
producing run. We represent this honestly:

- `TimelineEvent.consumedInputs` = `run.fingerprint` — this IS a stored fact (the versions of inputs at claim time).
- `TimelineEvent.producedStems` = derived from the def for that loop — this is STRUCTURAL (what the loop is responsible for), NOT which version it produced in this specific run.
- `WorkflowTrace.inferenceNote` explicitly documents the gap and the heuristic in plain text.
- We do NOT inject synthetic "produced version N" events into the `ArtifactBiography.events[]` array because we cannot accurately timestamp them (`artifact.updatedAt` is the latest touch only).

### 2. `producedStems` uses raw pattern strings for map loops

For a map loop like `formatcheck` that produces `gather.source[$i].formatcheck`,
we put the raw pattern string in `producedStems`. This is more informative than
the stem alone and makes it clear to the reader that the loop fires once per
collection element, while still not claiming to know which element this specific
run actually processed (that's in `key`).

### 3. Structural types instead of store imports in model.ts

`buildTrace` accepts parameters typed as structural inline types
(`ArtifactData & { updatedAt?: number }` and
`RunData & { id: string; createdAt: number; updatedAt: number }`) rather than
importing `ArtifactRow`/`RunRow` from `store.ts`. This avoids a potential
circular dependency and keeps model.ts import-clean (it imports from types.ts
and paths.ts, not from store.ts). At call sites, `ArtifactRow[]` and `RunRow[]`
satisfy these structural types because they extend `ArtifactData`/`RunData`.

### 4. New test file `test/trace.test.ts`

Rather than adding Store/Engine imports to the pure-model `model.test.ts`, we
create a dedicated `test/trace.test.ts`. This keeps concerns separated: model.ts
tests remain pure-function tests, and the trace test can exercise the full
Engine→Store→buildTrace pipeline.

### 5. `--format text` rendering

The text format outputs three sections separated by blank lines:
`=== Timeline ===`, `=== Artifacts ===`, and a one-line summary. Each timeline
event is one line: `#<seq> <ISO> <loop>[<key>] <outcome> — consumed {...} produced [...]`.
Each artifact biography shows its current state and then each event on an
indented line. This is scannable in a terminal, compatible with `grep`, and
sufficient for the "story of how the instance got here" use case.

### 6. `trace` case has access to `ctx`

The `dispatch` function's `trace` case uses `ctx` (returned by `openCtx`), which
includes `ctx.defs`, `ctx.store`, `ctx.defsDir`. The workflow row is fetched
from `store.getWorkflow(wf)` to get `wfRow.def` (the definition name), which is
then looked up in `ctx.defs`. This is the same pattern `statusEntry` uses
implicitly.
