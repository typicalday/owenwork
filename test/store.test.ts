import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, artifactId, taskId } from '../src/store.ts';
import { randId } from '../src/util.ts';
import type { ArtifactData } from '../src/types.ts';

function mem(): Store {
  return new Store(':memory:');
}

function artifact(workflow: string, path: string, over: Partial<ArtifactData> = {}): ArtifactData {
  return {
    workflow,
    path,
    producer: 'maker',
    acceptance: 'owed',
    version: 0,
    reasons: [],
    judgmentRejects: 0,
    schemaRejects: 0,
    ...over,
  };
}

test('deterministic ids are stable and distinct', () => {
  assert.equal(artifactId('wf1', 'plan'), artifactId('wf1', 'plan'));
  assert.notEqual(artifactId('wf1', 'plan'), artifactId('wf2', 'plan'));
  assert.notEqual(taskId('wf1', 'build', ''), taskId('wf1', 'build', 'x'));
});

test('workflow CRUD + params round-trip', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery', title: 'Ship it', params: { repo: 'acme/app' } });
  const got = s.getWorkflow(id);
  assert.equal(got?.def, 'delivery');
  assert.equal(got?.title, 'Ship it');
  assert.deepEqual(got?.params, { repo: 'acme/app' });
  assert.equal(s.listWorkflows().length, 1);
  s.close();
});

test('artifact upsert replaces and preserves JSON fields', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(
    artifact(wf, 'gather.source[0]', {
      acceptance: 'green',
      version: 1,
      value: { url: 'http://x', n: 3 },
      fingerprint: { plan: 2 },
      reasons: [{ at: 1, action: 'reject', kind: 'judgment', by: 'judge', text: 'nope' }],
      judgmentRejects: 1,
    }),
  );
  const got = s.getArtifact(wf, 'gather.source[0]');
  assert.equal(got?.acceptance, 'green');
  assert.equal(got?.version, 1);
  assert.deepEqual(got?.value, { url: 'http://x', n: 3 });
  assert.deepEqual(got?.fingerprint, { plan: 2 });
  assert.equal(got?.reasons.length, 1);
  assert.equal(got?.reasons[0]?.text, 'nope');
  assert.equal(got?.judgmentRejects, 1);

  // upsert fully replaces
  s.putArtifact(artifact(wf, 'gather.source[0]', { acceptance: 'owed', version: 1 }));
  const re = s.getArtifact(wf, 'gather.source[0]');
  assert.equal(re?.acceptance, 'owed');
  assert.equal(re?.value, undefined);
  assert.equal(re?.fingerprint, undefined);
  assert.equal(re?.reasons.length, 0);
  s.close();
});

test('deleteArtifact removes a single artifact, scoped by workflow + path', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'plan', { acceptance: 'green', version: 1 }));
  s.putArtifact(artifact(wf, 'pr'));
  assert.ok(s.getArtifact(wf, 'plan'));

  s.deleteArtifact(wf, 'plan');
  assert.equal(s.getArtifact(wf, 'plan'), undefined, 'plan is gone');
  assert.ok(s.getArtifact(wf, 'pr'), 'sibling artifact untouched');

  // deleting a non-existent artifact is a harmless no-op
  s.deleteArtifact(wf, 'ghost');
  assert.equal(s.listArtifacts(wf).length, 1);
  s.close();
});

test('terminal + sealOf flags survive a round-trip', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'merge', { acceptance: 'green', terminal: true }));
  s.putArtifact(artifact(wf, 'gather.source.sealed', { sealOf: 'gather.source' }));
  assert.equal(s.getArtifact(wf, 'merge')?.terminal, true);
  assert.equal(s.getArtifact(wf, 'gather.source.sealed')?.sealOf, 'gather.source');
  s.close();
});

test('listArtifacts is scoped to a workflow', () => {
  const s = mem();
  const a = randId('wf');
  const b = randId('wf');
  s.putArtifact(artifact(a, 'plan'));
  s.putArtifact(artifact(a, 'pr'));
  s.putArtifact(artifact(b, 'plan'));
  assert.equal(s.listArtifacts(a).length, 2);
  assert.equal(s.listArtifacts(b).length, 1);
  s.close();
});

test('task upsert toggles lease fields', () => {
  const s = mem();
  const wf = randId('wf');
  s.putTask({ workflow: wf, loop: 'build', key: '', status: 'idle', attempts: 0 });
  let t = s.getTask(wf, 'build', '');
  assert.equal(t?.status, 'idle');
  assert.equal(t?.run, undefined);

  s.putTask({ workflow: wf, loop: 'build', key: '', status: 'claimed', run: 'run_1', claimedAt: 123, attempts: 1 });
  t = s.getTask(wf, 'build', '');
  assert.equal(t?.status, 'claimed');
  assert.equal(t?.run, 'run_1');
  assert.equal(t?.claimedAt, 123);
  assert.equal(t?.attempts, 1);
  assert.equal(s.listClaimedTasks().length, 1);
  s.close();
});

test('run insert/update + budget counters', () => {
  const s = mem();
  const wf = randId('wf');
  const r1 = randId('run');
  s.insertRun(r1, { workflow: wf, loop: 'build' });
  s.updateRun(r1, { outcome: 'ok', summary: 'done', sessionId: 'sess-9' });
  const got = s.getRun(r1);
  assert.equal(got?.outcome, 'ok');
  assert.equal(got?.summary, 'done');
  assert.equal(got?.sessionId, 'sess-9');

  s.insertRun(randId('run'), { workflow: wf, loop: 'build' });
  assert.equal(s.countRuns(wf, 'build', 0), 2);
  assert.equal(s.countRuns(wf, 'other', 0), 0);
  assert.equal(s.latestRun(wf, 'build')?.workflow, wf);
  s.close();
});

test('tx rolls back atomically on throw', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'plan'));
  assert.throws(() =>
    s.tx(() => {
      s.putArtifact(artifact(wf, 'plan', { acceptance: 'green', version: 1 }));
      s.putArtifact(artifact(wf, 'pr', { acceptance: 'green', version: 1 }));
      throw new Error('boom');
    }),
  );
  // both writes rolled back
  assert.equal(s.getArtifact(wf, 'plan')?.acceptance, 'owed');
  assert.equal(s.getArtifact(wf, 'pr'), undefined);
  s.close();
});

test('tx commits all-or-nothing on success', () => {
  const s = mem();
  const wf = randId('wf');
  const n = s.tx(() => {
    s.putArtifact(artifact(wf, 'a', { acceptance: 'green', version: 1 }));
    s.putArtifact(artifact(wf, 'b', { acceptance: 'green', version: 1 }));
    return 2;
  });
  assert.equal(n, 2);
  assert.equal(s.listArtifacts(wf).length, 2);
  s.close();
});

test('deleteWorkflow cascades to artifacts/tasks/runs', () => {
  const s = mem();
  const wf = randId('wf');
  s.insertWorkflow(wf, { def: 'd' });
  s.putArtifact(artifact(wf, 'plan'));
  s.putTask({ workflow: wf, loop: 'build', key: '', status: 'idle', attempts: 0 });
  s.insertRun(randId('run'), { workflow: wf, loop: 'build' });
  s.deleteWorkflow(wf);
  assert.equal(s.getWorkflow(wf), undefined);
  assert.equal(s.listArtifacts(wf).length, 0);
  assert.equal(s.listTasks(wf).length, 0);
  assert.equal(s.countRuns(wf, 'build', 0), 0);
  s.close();
});

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
