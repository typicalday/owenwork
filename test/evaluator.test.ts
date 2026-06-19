/**
 * Tests for the allGreen firing trigger (§21): eligibility, bootstrap exclusion,
 * fall-out-of-done re-arm, no-thrash, and trigger-cause threading.
 *
 * Tests (a)-(e) from the build plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleFirings, maintainDecisions } from '../src/model.ts';
import { arts, def, input, loop } from './helpers.ts';

// ---- (a) back-compat: a loop with no on: fires exactly as inputsGreen --------

test('(a) back-compat: no on: → fires same as inputsGreen explicit', () => {
  // Setup: proposal(green) → planner(no on:) → plan(owed)
  const d = def('bc', [input('proposal')], [
    loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
  ]);
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
  ]);

  const firings = eligibleFirings(d, state);
  assert.equal(firings.length, 1);
  assert.equal(firings[0]!.loop, 'planner');
  // no cause on inputsGreen (implicit default)
  assert.equal(firings[0]!.cause, undefined);

  // Explicit on: ['inputsGreen'] should give identical result
  const dExplicit = def('bc-explicit', [input('proposal')], [
    loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'], on: ['inputsGreen'] }),
  ]);
  const firingsExplicit = eligibleFirings(dExplicit, state);
  assert.equal(firingsExplicit.length, 1);
  assert.equal(firingsExplicit[0]!.loop, 'planner');
  assert.equal(firingsExplicit[0]!.cause, undefined);
});

// ---- (b) allGreen eligibility lifecycle --------------------------------------

test('(b) allGreen eligibility lifecycle', () => {
  // Three-loop workflow: planner, builder, completion (on:['allGreen'])
  const d = def('lifecycle', [input('proposal')], [
    loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    loop({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    loop({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  // Step 1: plan owed, pr owed, outcome owed — completion NOT eligible
  const step1 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'pr', producer: 'builder', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const f1 = eligibleFirings(d, step1);
  const completionFirings1 = f1.filter((f) => f.loop === 'completion');
  assert.equal(completionFirings1.length, 0, 'completion must not be eligible when plan and pr are owed');

  // Step 2: plan green, pr owed — completion NOT eligible (builder debt remains)
  const step2 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const f2 = eligibleFirings(d, step2);
  const completionFirings2 = f2.filter((f) => f.loop === 'completion');
  assert.equal(completionFirings2.length, 0, 'completion must not be eligible when pr is still owed');

  // Step 3: plan green, pr green — completion IS eligible (bootstrap exclusion: outcome excluded)
  const step3 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const f3 = eligibleFirings(d, step3);
  const completionFirings3 = f3.filter((f) => f.loop === 'completion');
  assert.equal(completionFirings3.length, 1, 'completion must be eligible when all non-evaluator artifacts are green');
  assert.equal(completionFirings3[0]!.cause, 'allGreen');

  // Step 4: green outcome → the outcome artifact is now green (done)
  const step4 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);
  // Completion should NOT be re-eligible when outcome is already green
  const f4 = eligibleFirings(d, step4);
  const completionFirings4 = f4.filter((f) => f.loop === 'completion');
  assert.equal(completionFirings4.length, 0, 'completion must not be eligible when outcome is already green');
});

// ---- (c) bootstrap exclusion -------------------------------------------------

test('(c) bootstrap exclusion: single-loop evaluator workflow fires at T=0', () => {
  // Setup: single-loop workflow — only the completion evaluator, no other loops.
  // The only debt is outcome itself (the evaluator's own output), which is excluded.
  const d = def('single-eval', [], [
    loop({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);
  const state = arts([
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const firings = eligibleFirings(d, state);
  const completionFirings = firings.filter((f) => f.loop === 'completion');
  assert.equal(
    completionFirings.length,
    1,
    'bootstrap exclusion: the evaluator must be eligible even when its own output is the only debt',
  );
  assert.equal(completionFirings[0]!.cause, 'allGreen');
});

// ---- (d) fall-out-of-done re-arm + no-thrash ---------------------------------

test('(d) fall-out-of-done re-arm + no-thrash', () => {
  const d = def('rearm', [input('proposal')], [
    loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    loop({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  // State A: plan green, outcome green → done
  const stateA = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);
  // maintainDecisions on stable done state → no rearm ops
  const opsA = maintainDecisions(d, stateA);
  const rearmOpsA = opsA.filter((op) => op.kind === 'reject' && op.path === 'outcome');
  assert.equal(rearmOpsA.length, 0, 'no re-arm op when outcome is green and workflow is all-green');

  // Introduce a debt: set plan back to owed (upstream re-arm)
  const stateFellOut = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);

  // maintainDecisions → outcome gets a 'reject' op (re-arm)
  const opsFellOut = maintainDecisions(d, stateFellOut);
  const rearmOps = opsFellOut.filter((op) => op.kind === 'reject' && op.path === 'outcome');
  assert.equal(rearmOps.length, 1, 'outcome must be re-armed when workflow falls out of done');

  // State B after applying op: outcome is owed
  const stateB = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  // eligibleFirings: completion is NOT eligible yet (plan is a debt)
  const firingsB = eligibleFirings(d, stateB);
  const completionB = firingsB.filter((f) => f.loop === 'completion');
  assert.equal(completionB.length, 0, 'completion must not be eligible when plan is a debt');

  // Green plan again (resolve the debt)
  const stateC = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  // eligibleFirings: completion IS eligible (cause='allGreen')
  const firingsC = eligibleFirings(d, stateC);
  const completionC = firingsC.filter((f) => f.loop === 'completion');
  assert.equal(completionC.length, 1, 'completion must be eligible after plan greens again');
  assert.equal(completionC[0]!.cause, 'allGreen');

  // No-thrash: maintainDecisions on the stable all-green state (outcome green) → zero allGreen-rearm ops
  const stateStable = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 2 },
  ]);
  const opsStable = maintainDecisions(d, stateStable);
  const rearmOpsStable = opsStable.filter(
    (op) => op.kind === 'reject' && op.path === 'outcome' && op.reason.includes('allGreen-rearm'),
  );
  assert.equal(rearmOpsStable.length, 0, 'no thrash: no allGreen-rearm op when workflow is all-green and outcome is green');
});

// ---- (e) trigger-cause threading on the Firing level -------------------------

test('(e) trigger-cause is threaded onto the Firing', () => {
  const d = def('cause-check', [input('proposal')], [
    loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    loop({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  // All non-evaluator artifacts green; outcome is owed
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const firings = eligibleFirings(d, state);
  const completionFiring = firings.find((f) => f.loop === 'completion');
  assert.ok(completionFiring, 'expected a completion firing');
  assert.equal(completionFiring!.cause, 'allGreen', 'firing must carry cause=allGreen');
  // inputs must be empty (no consumed inputs for allGreen loop)
  assert.deepEqual(completionFiring!.inputs, []);
});
