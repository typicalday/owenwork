# Declared Invariants — Build Plan

## 1. Goal

Add declared invariants to oweflow: a workflow definition may include an `invariants` array of structured safety predicates. The bounded model-checker (`oweflow check`, `modelCheck`) evaluates every invariant at every reachable BFS state and reports a concrete shortest counterexample path (a `CheckStep[]`) for any violated property. The CLI prints violations, folds them into the verdict, and exits non-zero on any violation regardless of the `bounded` flag. Zero new dependencies; `model.ts` stays pure.

---

## 2. Files to Touch

### 2.1 `src/types.ts` — add new types (additive)

**Location**: after the closing `}` of `CheckReport` (currently line 367).

**Add these three TypeScript declarations verbatim:**

```typescript
// ---- invariant types ---------------------------------------------------------

/**
 * A structured, total, recursive predicate over artifact state. Exactly one
 * discriminant key is present per object.
 *
 * Safety properties only — no liveness / temporal operators. The bounded BFS
 * soundly finds safety VIOLATIONS (a reachable witness) but cannot prove
 * liveness; the existing `completable` covers "a done state is reachable".
 */
export type InvariantPredicate =
  | { path: string; is: Acceptance | 'present' | 'absent' }  // atom: artifact state / presence
  | { state: 'done' }                                          // true iff workflow is done
  | { all: InvariantPredicate[] }                              // conjunction (AND)
  | { any: InvariantPredicate[] }                              // disjunction (OR)
  | { not: InvariantPredicate };                               // negation

/**
 * One declared safety invariant. Semantics: "in every reachable state,
 * `when` (default TRUE) implies `requires`". A state VIOLATES the invariant
 * iff eval(when ?? TRUE) && !eval(requires).
 */
export interface InvariantDef {
  name: string;
  description?: string;
  /** Activation guard. Omitted = always active (TRUE). */
  when?: InvariantPredicate;
  /** The property that must hold whenever `when` is true. */
  requires: InvariantPredicate;
}

/**
 * A counterexample: the invariant name + the shortest BFS path from the seed
 * state to a state that violates the invariant. The path is a real executable
 * witness — each step was produced by applyOutcome/settleInMemory, the same
 * transitions the conformance test pins to the live Engine.
 */
export interface InvariantViolation {
  /** The `InvariantDef.name` of the violated invariant. */
  invariant: string;
  /** Shortest BFS path of firings from the seed state to the violating state. */
  path: CheckStep[];
}
```

**Also add `invariants?` to `WorkflowDef`** (currently lines 164–172):

```typescript
export interface WorkflowDef {
  name: string;
  title?: string;
  description?: string;
  inputs: InputDef[];
  loops: LoopDef[];
  dir?: string;
  /** Declared safety invariants verified by `modelCheck`/`oweflow check`. */
  invariants?: InvariantDef[];
}
```

**Also add `invariantViolations` to `CheckReport`** (currently lines 344–367), after `deadLoops: string[];`:

```typescript
/**
 * Invariants that are violated in some reachable state. Always present ([]
 * when no invariants declared or none violated). Each entry is deduplicated by
 * invariant name — BFS guarantees the stored path is the shortest counterexample.
 */
invariantViolations: InvariantViolation[];
```

Mirror the always-present pattern of `deadlocks`/`stuck` — non-optional, initialized to `[]`.

---

### 2.2 `src/defs.ts` — parse + validate invariants (additive)

#### 2.2.1 Update `RawDef` (lines 59–65)

```typescript
interface RawDef {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputs?: unknown;
  loops?: unknown;
  invariants?: unknown;    // <-- add this
}
```

#### 2.2.2 Update the import (line 29)

Add `Acceptance`, `InvariantDef`, `InvariantPredicate`:

```typescript
import type { Acceptance, InputDef, InvariantDef, InvariantPredicate, JsonSchema, LoopDef, ProducePattern, WorkflowDef } from './types.ts';
```

#### 2.2.3 Add predicate coercion helpers (immediately before `buildDef`, ~line 143)

```typescript
// Allowed `is` literals for path atoms
const ALLOWED_IS = new Set<string>([
  'owed', 'green', 'rejected', 'retracted', 'skipped', 'present', 'absent',
]);

/** Parse a raw object into an InvariantPredicate, throwing DefError on shape errors. */
function parseInvariantPredicate(v: unknown, ctx: string): InvariantPredicate {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DefError(`${ctx} must be a predicate object`);
  }
  const obj = v as Record<string, unknown>;
  const discriminants = (['path', 'state', 'all', 'any', 'not'] as const).filter((k) => k in obj);
  if (discriminants.length === 0) {
    throw new DefError(`${ctx} must have exactly one of: path, state, all, any, not (got none)`);
  }
  if (discriminants.length > 1) {
    throw new DefError(`${ctx} must have exactly one of: path, state, all, any, not (got: ${discriminants.join(', ')})`);
  }
  const key = discriminants[0]!;
  if (key === 'path') {
    const path = asString(obj['path'], `${ctx}.path`);
    const is = asString(obj['is'], `${ctx}.is`);
    if (!ALLOWED_IS.has(is)) {
      throw new DefError(`${ctx}.is must be one of: ${[...ALLOWED_IS].join(', ')} (got '${is}')`);
    }
    return { path, is: is as Acceptance | 'present' | 'absent' };
  }
  if (key === 'state') {
    if (obj['state'] !== 'done') throw new DefError(`${ctx}.state must be 'done'`);
    return { state: 'done' };
  }
  if (key === 'all') {
    if (!Array.isArray(obj['all'])) throw new DefError(`${ctx}.all must be an array`);
    return { all: (obj['all'] as unknown[]).map((item, i) => parseInvariantPredicate(item, `${ctx}.all[${i}]`)) };
  }
  if (key === 'any') {
    if (!Array.isArray(obj['any'])) throw new DefError(`${ctx}.any must be an array`);
    return { any: (obj['any'] as unknown[]).map((item, i) => parseInvariantPredicate(item, `${ctx}.any[${i}]`)) };
  }
  // key === 'not'
  return { not: parseInvariantPredicate(obj['not'], `${ctx}.not`) };
}

/** Parse a raw invariants array into InvariantDef[], throwing DefError on shape errors. */
function parseInvariants(v: unknown, ctx: string): InvariantDef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DefError(`${ctx} must be a list`);
  return v.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new DefError(`${ctx}[${i}] must be a mapping`);
    }
    const raw = item as Record<string, unknown>;
    const name = asString(raw['name'], `${ctx}[${i}].name`);
    if (!('requires' in raw)) {
      throw new DefError(`${ctx}[${i}] ('${name}') must have a 'requires' predicate`);
    }
    const inv: InvariantDef = {
      name,
      requires: parseInvariantPredicate(raw['requires'], `invariant '${name}'.requires`),
    };
    if (raw['description'] !== undefined) {
      inv.description = asString(raw['description'], `invariant '${name}'.description`);
    }
    if (raw['when'] !== undefined) {
      inv.when = parseInvariantPredicate(raw['when'], `invariant '${name}'.when`);
    }
    return inv;
  });
}
```

#### 2.2.4 Inject invariant parsing into `buildDef` (after the `description` line, before `return def`, ~line 172)

```typescript
  const invariants = parseInvariants(r.invariants, 'invariants');
  if (invariants.length > 0) def.invariants = invariants;
```

Keeps `def.invariants` absent (not `[]`) when none declared — matches the optional-field convention.

#### 2.2.5 Add semantic validation in `validateDef` (after `detectCycles` push, before `return errors`, ~line 302)

`producerOf: Map<string, string>` is fully built by ~line 269 and contains every input name (→ `'human'`) and every singleton/collection stem (→ loop name).

```typescript
  // Semantic invariant validation: unknown stem references and duplicate names.
  if (def.invariants && def.invariants.length > 0) {
    const invariantNames = new Set<string>();
    for (const inv of def.invariants) {
      if (invariantNames.has(inv.name)) {
        errors.push(`invariant name '${inv.name}' is declared more than once`);
      }
      invariantNames.add(inv.name);
      const stems = collectPredicateStems(inv.requires);
      if (inv.when) stems.push(...collectPredicateStems(inv.when));
      for (const stem of stems) {
        if (!producerOf.has(stem)) {
          errors.push(`invariant '${inv.name}' references unknown stem '${stem}' (not an input or produced artifact)`);
        }
      }
    }
  }
```

Private helper (place near the other module-private helpers):

```typescript
/** Collect every stem referenced by `path` atoms in a predicate tree. */
function collectPredicateStems(pred: InvariantPredicate): string[] {
  if ('path' in pred) return [pred.path];
  if ('state' in pred) return [];
  if ('all' in pred) return pred.all.flatMap(collectPredicateStems);
  if ('any' in pred) return pred.any.flatMap(collectPredicateStems);
  return collectPredicateStems(pred.not); // 'not'
}
```

Error-message style follows existing `validateDef` conventions (lowercase, single-quoted names).

---

### 2.3 `src/model.ts` — evaluator + BFS integration (additive; stays pure)

#### 2.3.1 Update the type import block

Add `InvariantPredicate` (and `InvariantViolation`/`InvariantDef` if referenced):

```typescript
  InvariantPredicate,
```

#### 2.3.2 Add `ALWAYS_TRUE` sentinel and `evalInvariantPredicate` (after `workflowStatus`, ~line 492, before `buildTrace`)

```typescript
// ---- invariant evaluation ---------------------------------------------------

/** A trivially-true predicate sentinel for `when` defaulting ({all:[]} = empty AND = true). */
const ALWAYS_TRUE: InvariantPredicate = { all: [] };

/**
 * Pure evaluation of a structured invariant predicate against artifact state.
 * Total — never throws on well-formed (validated) predicates.
 */
export function evalInvariantPredicate(
  pred: InvariantPredicate,
  arts: ReadonlyMap<string, ArtifactData>,
  status: WorkflowStatus,
): boolean {
  if ('path' in pred) {
    const { path, is } = pred;
    if (is === 'present') return arts.has(path);
    if (is === 'absent') return !arts.has(path);
    return arts.get(path)?.acceptance === is;
  }
  if ('state' in pred) return status.done;
  if ('all' in pred) return pred.all.every((p) => evalInvariantPredicate(p, arts, status));
  if ('any' in pred) return pred.any.some((p) => evalInvariantPredicate(p, arts, status));
  return !evalInvariantPredicate(pred.not, arts, status); // 'not'
}
```

#### 2.3.3 Initialize `invariantViolations` in the `modelCheck` report literal (~line 1336)

Add `invariantViolations: [],` after `stuck: [],`. Add a dedupe set after the report literal:

```typescript
  /** Invariant names already recorded (BFS → first hit is the shortest path). */
  const reportedInvariants = new Set<string>();
```

#### 2.3.4 Invariant evaluation at the BFS state-visit point

Insert AFTER `const status = workflowStatus(def, node.arts);` (~line 1357) and BEFORE the `if (status.done)` block:

```typescript
    // ---- invariant checking -------------------------------------------------
    // A state violates an invariant iff eval(when ?? ALWAYS_TRUE) && !eval(requires).
    // Checked BEFORE the `done` continue so terminal properties ("when done,
    // merge must be green") are verified.
    //
    // Soundness under bounds: a reported counterexample path was produced by real
    // applyOutcome/settleInMemory transitions (the same transitions the conformance
    // test pins to the live Engine). Bounds only cause MISSES, never fabrications —
    // which is why invariant violations exit non-zero even when bounded (unlike
    // deadlocks/stuck, which the maxCollectionSize cap can spuriously manufacture).
    if (def.invariants) {
      for (const inv of def.invariants) {
        if (reportedInvariants.has(inv.name)) continue;
        const whenHolds = evalInvariantPredicate(inv.when ?? ALWAYS_TRUE, node.arts, status);
        if (whenHolds && !evalInvariantPredicate(inv.requires, node.arts, status)) {
          report.invariantViolations.push({ invariant: inv.name, path: node.path });
          reportedInvariants.add(inv.name);
        }
      }
    }
    // -------------------------------------------------------------------------
```

---

### 2.4 `src/cli.ts` — output + exit code (additive)

#### 2.4.1 USAGE string (~line 187) — append `, declared invariants` to the check description.

#### 2.4.2 Re-validate the def in the `check` command (IMPORTANT — surfaces unknown-stem errors)

`check` resolves the def via `loadDefsRaw` (→ `buildDef`, which does NOT run `validateDef`), so semantic invariant errors would otherwise be silent. After `const def = defs.get(defName)` (and the unknown-name guard), add:

```typescript
    // loadDefsRaw uses buildDef (no semantic validation); run validateDef here so
    // invariant stem-reference / duplicate-name errors surface to the author.
    const defErrors = validateDef(def);
    if (defErrors.length > 0) {
      throw new CliError(`workflow '${def.name}' has validation errors:\n  - ${defErrors.join('\n  - ')}`);
    }
```

Import `validateDef` in cli.ts if not already imported.

#### 2.4.3 Text-format verdict (~line 268)

```typescript
      const clean = report.deadlocks.length === 0 && report.stuck.length === 0
        && report.invariantViolations.length === 0;
      const status = clean && report.completable ? 'OK' : clean ? 'INCOMPLETE' : 'DEFECTS FOUND';
```

#### 2.4.4 Invariant-violations block (after the `stuck` block, ~line 292)

```typescript
      if (report.invariantViolations.length > 0) {
        io.out('');
        io.out(`Invariant violations (${report.invariantViolations.length}):`);
        for (const v of report.invariantViolations) {
          io.out(`  invariant: ${v.invariant}`);
          io.out(`  path: ${v.path.map((s) => `${s.loop}/${s.outcome}`).join(' -> ') || '(initial state)'}`);
        }
      }
```

Match the `s.loop/s.outcome` path rendering used by the deadlocks/stuck blocks.

#### 2.4.5 Exit-code logic (~line 304) — soundness asymmetry; keep the comment

```typescript
    // Exit codes:
    // - invariant violations → ALWAYS nonzero, regardless of bounded. A reported
    //   counterexample path was produced by real applyOutcome/settleInMemory
    //   transitions (pinned to the live Engine by the conformance test). The path
    //   is a genuine executable witness; bounds only cause MISSES, never
    //   fabrications. Contrast deadlocks/stuck, where the maxCollectionSize cap can
    //   manufacture a spurious "no moves" state — hence those require !bounded.
    //   Do NOT remove this asymmetry; it encodes a real soundness distinction.
    // - definite deadlock/stuck only when EXHAUSTIVE (!bounded) → nonzero
    // - truncated with no invariant violations → 0
    const hasDefiniteDefect =
      report.invariantViolations.length > 0 ||
      (!report.bounded && (report.deadlocks.length > 0 || report.stuck.length > 0));
    if (hasDefiniteDefect) {
      throw new CliError(
        `definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
        `${report.deadlocks.length} deadlock(s), ${report.stuck.length} stuck state(s))`,
      );
    }
```

The `definite defects found` substring MUST be preserved (existing CLI test asserts `/definite defects found/`).

---

### 2.5 `src/index.ts` — re-exports (additive)

- model.ts block: add `evalInvariantPredicate`.
- types.ts block: add `InvariantDef`, `InvariantPredicate`, `InvariantViolation`.

---

## 3. Tests to Add

### 3.1 `test/defs.test.ts` — parsing/validation
1. Valid invariant round-trips → `def.invariants[0]` carries name/requires/when; `description` undefined.
2. Missing `requires` → `DefError` `/requires/`.
3. Invalid `is` literal → `DefError` `/must be one of/`.
4. Predicate with two discriminants (`path` + `all`) → `DefError` `/exactly one of/`.
5. Predicate with no discriminants (`{}`) → `DefError` `/exactly one of.*got none/`.
6. `all` not an array → `DefError` `/must be an array/`.
7. `any` not an array → `DefError` (same).
8. Unknown stem → `parseDef` throws `DefError` `/unknown stem 'nonexistent'/`.
9. Duplicate invariant names → `parseDef` throws `DefError` `/declared more than once/`.
10. `invariants: []` is valid; `def.invariants` absent/empty.
11. Nested `not`/`all` round-trips (deep-equal).

### 3.2 `test/check.test.ts` — `evalInvariantPredicate` unit
12. atom `is:'green'` true/false.
13. atoms `owed`/`rejected`/`retracted`/`skipped`.
14. `is:'present'` true (in map) / false (absent).
15. `is:'absent'` inverse.
16. `{state:'done'}` against done vs not-done `workflowStatus`.
17. `{all:[]}` vacuously true.
18. `{any:[]}` vacuously false.
19. `{all:[...]}` AND semantics.
20. `{any:[...]}` OR semantics.
21. `{not:...}`.
22. absent path with `is:'green'` → false (no throw).

### 3.3 `test/check.test.ts` — `modelCheck` integration
23. Invariant that holds everywhere → `invariantViolations` empty.
24. Invariant violated (e.g. `requires:{path:'out',is:'green'}` on a def where `out` starts owed) → exactly one violation, `.invariant` name matches, `.path` is an array.
25. **Real-witness re-drive (trustworthiness):** take `report.invariantViolations[0]`, re-drive its `path` from a manually-seeded initial map (mirror the conformance-test seeding pattern in check.test.ts) using `eligibleFirings` + `applyOutcome` (take successor[0]) + final `settleInMemory`; then assert `eval(when ?? {all:[]})` is true AND `eval(requires)` is FALSE in the reached state — proving the counterexample is real, not cosmetic.
26. `{state:'done'}` invariant that holds (delivery: `when:{state:'done'},requires:{path:'merge',is:'green'}`).
27. `{state:'done'}` invariant violated (a 1-loop def where done is reachable with the output `skipped`).
28. **Bounded-still-reports:** a depth-0 violation with tiny bounds (`maxStates:3,maxDepth:1`) → `report.bounded===true` AND `invariantViolations.length>=1`.

### 3.4 `test/check.test.ts` — CLI
29. YAML def with a violated invariant → `r.code===1`, output `/DEFECTS FOUND/`, `/Invariant violations/`, the invariant name.
30. Same with tight `--max-states 2` → `r.code===1` (violation under bounds), `/SEARCH INCOMPLETE/` banner present.
31. `--format json` → parsed report has `invariantViolations` array with the violation.
32. Def whose invariants all hold → `r.code===0`, no `Invariant violations` in output.
33. Invariant referencing unknown stem → `r.code===1`, `r.err` `/unknown stem 'nonexistent'/` (surfaced by the new `validateDef` call in §2.4.2; the def must otherwise be structurally valid so `buildDef` loads it).

---

## 4. Edge Cases

- `def.invariants` omitted → `parseInvariants` returns `[]`; field unset; `modelCheck` guard short-circuits; `invariantViolations` stays `[]`.
- `when` omitted → `ALWAYS_TRUE` ({all:[]}) → always active.
- `requires` references an input stem → valid (inputs are in `producerOf` as `'human'`).
- Predicate references a stem absent from the map → `arts.get(p)?.acceptance===is` is `false`; `present`→false; `absent`→true; never throws.
- `{state:'done'}` at the seed → `false` for any valid def (loops always produce initial debts after `settleInMemory`).
- Collection bare-stem path (e.g. `gather.source`) → no artifact at that exact path → atoms evaluate false; element-indexed paths (`gather.source[0]`) are rejected by `validateDef` as unknown stems (v1 limitation — bare stems only).
- Multiple violating states → only the first BFS-visited one recorded per invariant name (shortest path).
- All invariants violated at depth 0 → `path` is `[]` → rendered `(initial state)`.

---

## 5. Verify

From the worktree root: `npm run check` (tsc --noEmit + full suite). All 252 existing tests pass unchanged; new tests add to the count. `lintDef(delivery)` still `{errors:[],warnings:[]}` (no invariants key). The existing bounded-search-exits-0 test still passes (its tiny def declares no invariants). Zero new dependencies; `model.ts` stays pure. The real-witness re-drive test (§3.3 #25) is the guard that the counterexample is executable.
