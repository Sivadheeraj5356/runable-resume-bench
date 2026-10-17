import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, hashInput, stableStringify } from '../src/journal.ts';
import { CrashInjected, DurableRunner, UnknownOutcomeError, emptyStats, type Workflow } from '../src/runner.ts';
import { World, siteBuilderWorkflow, opsReportWorkflow, inboxTriageWorkflow } from '../src/scenarios.ts';
import { runBench, runTrial } from '../src/bench.ts';

function freshJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rb-test-')), 'journal.jsonl');
}

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ a: 1, b: [2, { c: 3, d: 4 }] }), stableStringify({ b: [2, { d: 4, c: 3 }], a: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('journal recovers from a torn final line (crash mid-write)', () => {
  const path = freshJournalPath();
  const { journal } = Journal.load(path);
  journal.append({ kind: 'step', workflowId: 'w', stepId: 'a', inputHash: 'h1', value: 'ok', at: new Date().toISOString(), durationMs: 1 });
  // Simulate process death halfway through writing the next record.
  writeFileSync(path, readFileSync(path, 'utf8') + '{"kind":"step","workflowId":"w","stepId":"b","inpu');
  const second = Journal.load(path);
  assert.equal(second.recoveredTornWrite, true);
  assert.equal(second.journal.records.length, 1);
  assert.equal(second.journal.records[0].stepId, 'a');
});

test('journal refuses a corrupt non-tail line', () => {
  const path = freshJournalPath();
  writeFileSync(path, '{"kind":"step","workflowId":"w","stepId":"a","inputHash":"h","value":1,"at":"t","durationMs":0}\nNOT-JSON\n{"kind":"step","workflowId":"w","stepId":"b","inputHash":"h","value":2,"at":"t","durationMs":0}\n');
  assert.throws(() => Journal.load(path), /corrupt at line 2/);
});

test('resume skips completed steps and never re-runs them', async () => {
  const path = freshJournalPath();
  let executions = 0;
  const wf: Workflow = {
    id: 'w',
    steps: [
      { id: 'one', run: () => { executions++; return 1; } },
      { id: 'two', run: (i) => { executions++; return (i as number) + 1; } },
      { id: 'three', run: (i) => { executions++; return (i as number) + 1; } },
    ],
  };
  const first = Journal.load(path).journal;
  await assert.rejects(new DurableRunner(first, { crashBeforeStep: 'three' }).run(wf), CrashInjected);
  assert.equal(executions, 2);

  const stats = emptyStats();
  const out = await new DurableRunner(Journal.load(path).journal).run(wf, stats);
  assert.equal(out, 3);
  assert.equal(executions, 3, 'only the unfinished step ran after resume');
  assert.deepEqual(stats.skipped, ['one', 'two']);
  assert.deepEqual(stats.executed, ['three']);
});

test('mid-step crash does not duplicate a committed side effect', async () => {
  const path = freshJournalPath();
  const world = new World();
  const wf = siteBuilderWorkflow(world);
  await assert.rejects(new DurableRunner(Journal.load(path).journal, { crashDuringStep: 'deploy' }).run(wf), CrashInjected);
  assert.equal(world.calls['deploy-site'], 1);

  const stats = emptyStats();
  await new DurableRunner(Journal.load(path).journal).run(wf, stats);
  assert.equal(world.calls['deploy-site'], 1, 'deploy ran exactly once across crash + resume');
  assert.ok(stats.effectsReplayed.includes('deploy/deploy-site'));
});

test('changed input hash invalidates the memo entry', async () => {
  const path = freshJournalPath();
  let executions = 0;
  const make = (brief: string): Workflow => ({
    id: 'w',
    initialInput: { brief },
    steps: [{ id: 'only', run: (i) => { executions++; return i; } }],
  });
  await new DurableRunner(Journal.load(path).journal).run(make('a'));
  await new DurableRunner(Journal.load(path).journal).run(make('a'));
  assert.equal(executions, 1, 'same input replays from journal');
  await new DurableRunner(Journal.load(path).journal).run(make('b'));
  assert.equal(executions, 2, 'changed input re-executes');
});

test('hashInput is stable for equal inputs', () => {
  assert.equal(hashInput({ x: [1, 2], y: 'z' }), hashInput({ y: 'z', x: [1, 2] }));
});

test('full bench: every scenario passes every crash point', async () => {
  const { trials, scenarios } = await runBench();
  assert.equal(scenarios.length, 3);
  assert.ok(trials.length >= 10, 'bench covers many crash points');
  const failed = trials.filter((t) => !t.passed);
  assert.deepEqual(failed.map((t) => `${t.scenario}@${t.crashPoint}: ${t.failures.join('; ')}`), []);
});

test('runTrial detects a duplicated side effect when the engine is bypassed', async () => {
  // A broken workflow: the effect runs outside ctx.effect (so it is not
  // journaled), then a journaled effect arms the mid-step crash. On resume
  // the step re-runs and the unsafe effect duplicates - the bench must catch it.
  const broken = (world: World): Workflow => ({
    id: 'broken',
    steps: [
      {
        id: 'x',
        run: async (_i, ctx) => {
          world.record('unsafe-effect', 'ran outside ctx.effect');
          await ctx.effect('safe', () => 'fine');
          return 'done';
        },
      },
    ],
  });
  const base = { output: stableStringify('done'), worldCalls: { 'unsafe-effect': 1 } };
  const trial = await runTrial('broken', broken, 'during:x', { crashDuringStep: 'x' }, base);
  assert.equal(trial.passed, false);
  assert.ok(trial.failures.some((f) => f.includes('unsafe-effect')), `expected unsafe-effect failure, got: ${trial.failures.join('; ')}`);
});

test('scenarios are deterministic across fresh worlds', async () => {
  for (const factory of [siteBuilderWorkflow, opsReportWorkflow, inboxTriageWorkflow]) {
    const a = await new DurableRunner(Journal.load(freshJournalPath()).journal).run(factory(new World()));
    const b = await new DurableRunner(Journal.load(freshJournalPath()).journal).run(factory(new World()));
    assert.equal(stableStringify(a), stableStringify(b));
  }
});

test('commit gap: idempotent effect stays exactly-once via the journaled key', async () => {
  const path = freshJournalPath();
  const world = new World();
  const wf = siteBuilderWorkflow(world);
  // Crash after deploy-site EXECUTED but before its completion was journaled.
  await assert.rejects(
    new DurableRunner(Journal.load(path).journal, { crashAfterEffectExecute: 'deploy' }).run(wf),
    CrashInjected,
  );
  assert.equal(world.calls['deploy-site'], 1, 'effect executed once before the crash');

  const stats = emptyStats();
  const out = await new DurableRunner(Journal.load(path).journal).run(wf, stats);
  assert.equal(world.calls['deploy-site'], 1, 'idempotent retry deduped by key: still exactly once');
  assert.ok(stats.effectsRetriedWithKey.includes('deploy/deploy-site'), 'resume retried with the same key');
  assert.ok(stableStringify(out).includes('crumb-culture'));
});

test('commit gap: non-idempotent effect halts with UnknownOutcomeError, no silent duplicate', async () => {
  const path = freshJournalPath();
  const world = new World();
  const wf: Workflow = {
    id: 'risky',
    steps: [
      {
        id: 'charge',
        run: async (_i, ctx) => {
          // Non-idempotent endpoint (plain counter) and no idempotent declaration.
          await ctx.effect('charge-card', () => { world.record('charge-card', 'charged'); return 'receipt'; });
          return 'done';
        },
      },
    ],
  };
  await assert.rejects(
    new DurableRunner(Journal.load(path).journal, { crashAfterEffectExecute: 'charge' }).run(wf),
    CrashInjected,
  );
  assert.equal(world.calls['charge-card'], 1);
  // Resume must refuse to guess: unknown outcome, no re-execution.
  await assert.rejects(new DurableRunner(Journal.load(path).journal).run(wf), UnknownOutcomeError);
  assert.equal(world.calls['charge-card'], 1, 'no silent duplicate after halt');
});

test('commit gap: idempotency key is identical across crash and resume', async () => {
  const path = freshJournalPath();
  const seenKeys: string[] = [];
  const wf: Workflow = {
    id: 'keys',
    steps: [
      {
        id: 's',
        run: async (_i, ctx) => {
          await ctx.effect('eff', (key) => { seenKeys.push(key); return 1; }, { idempotent: true });
          return 'ok';
        },
      },
    ],
  };
  await assert.rejects(new DurableRunner(Journal.load(path).journal, { crashAfterEffectExecute: 's' }).run(wf), CrashInjected);
  await new DurableRunner(Journal.load(path).journal).run(wf);
  assert.equal(seenKeys.length, 2, 'effect fn invoked once per process');
  assert.equal(seenKeys[0], seenKeys[1], 'same deterministic key on both attempts');
});

test('intent record without completion never replays a value', async () => {
  const path = freshJournalPath();
  const { journal } = Journal.load(path);
  journal.append({ kind: 'effect-intent', workflowId: 'w', stepId: 's', name: 'e', inputHash: 'h', key: 'k', value: null, at: new Date().toISOString(), durationMs: 0 });
  // An intent alone must not be treated as a completed effect.
  const found = journal.lookup('effect', 'w', 's', 'e', 'h');
  assert.equal(found, undefined);
});
