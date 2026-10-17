/**
 * bench.ts - the resume-correctness bench.
 *
 * For every scenario, and for every crash point in that scenario (before each
 * step, and mid-step after a committing side effect), the bench:
 *
 *   1. runs the workflow against a fresh journal and World,
 *   2. injects a one-shot crash,
 *   3. resumes from the journal with a brand-new runner (fresh process),
 *   4. checks the durability contract:
 *      - final output is identical to the no-crash baseline
 *      - no completed step was re-executed
 *      - no side effect ran twice in the World
 *
 * Results are printed as a table and written to out/report.json and
 * out/report.html. Everything is local, deterministic, and free to run.
 *
 * Usage: node --experimental-strip-types src/bench.ts [--out dir]
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, stableStringify } from './journal.ts';
import { CrashInjected, DurableRunner, emptyStats, type FaultPlan, type RunStats, type Workflow } from './runner.ts';
import { World, allScenarios } from './scenarios.ts';
import { renderReport } from './report.ts';

export interface TrialResult {
  scenario: string;
  crashPoint: string;
  passed: boolean;
  failures: string[];
  stepsExecutedAfterResume: number;
  stepsSkippedOnResume: number;
  effectsExecuted: number;
  effectsReplayed: number;
  journalBytes: number;
  durationMs: number;
}

export interface ScenarioSummary {
  scenario: string;
  steps: number;
  crashPoints: number;
  trialsPassed: number;
  trialsTotal: number;
}

function crashPointsFor(workflow: Workflow): { label: string; plan: FaultPlan }[] {
  const points: { label: string; plan: FaultPlan }[] = [];
  for (const step of workflow.steps) {
    points.push({ label: `before:${step.id}`, plan: { crashBeforeStep: step.id } });
  }
  // Crashes inside a step only make sense for steps that commit an effect.
  // `during` crashes after the effect's completion is journaled; `commit-gap`
  // crashes after the effect EXECUTED but before its completion was journaled -
  // the decisive boundary, tested for every effect-bearing step.
  const effectSteps: Record<string, string[]> = {
    'site-builder': ['build-pages', 'deploy'],
    'ops-report': ['draft-doc', 'notify'],
    'inbox-triage': ['draft-replies'],
  };
  for (const s of effectSteps[workflow.id] ?? []) {
    points.push({ label: `commit-gap:${s}`, plan: { crashAfterEffectExecute: s } });
  }
  const last = (effectSteps[workflow.id] ?? []).at(-1);
  if (last) points.push({ label: `during:${last}`, plan: { crashDuringStep: last } });
  return points;
}

async function baseline(workflowFactory: (w: World) => Workflow): Promise<{ output: string; worldCalls: Record<string, number> }> {
  const world = new World();
  const dir = mkdtempSync(join(tmpdir(), 'rb-base-'));
  const { journal } = Journal.load(join(dir, 'journal.jsonl'));
  const output = await new DurableRunner(journal).run(workflowFactory(world));
  return { output: stableStringify(output), worldCalls: { ...world.calls } };
}

export async function runTrial(
  scenarioName: string,
  workflowFactory: (w: World) => Workflow,
  crashLabel: string,
  plan: FaultPlan,
  base: { output: string; worldCalls: Record<string, number> },
): Promise<TrialResult> {
  const started = Date.now();
  const world = new World();
  const dir = mkdtempSync(join(tmpdir(), 'rb-trial-'));
  const journalPath = join(dir, 'journal.jsonl');
  const workflow = workflowFactory(world);
  const failures: string[] = [];

  // First process: armed with a one-shot crash.
  const first = Journal.load(journalPath);
  if (first.recoveredTornWrite) failures.push('unexpected torn write before crash');
  try {
    await new DurableRunner(first.journal, plan).run(workflow);
    failures.push('crash was not injected (workflow ran to completion)');
  } catch (err) {
    if (!(err instanceof CrashInjected)) failures.push(`unexpected error: ${String(err)}`);
  }

  // Second process: fresh runner, same journal - the resume.
  const second = Journal.load(journalPath);
  const stats: RunStats = emptyStats();
  const output = await new DurableRunner(second.journal).run(workflow, stats);

  if (stableStringify(output) !== base.output) failures.push('final output differs from no-crash baseline');
  for (const [name, count] of Object.entries(world.calls)) {
    const expected = base.worldCalls[name] ?? 1;
    if (count !== expected) failures.push(`side effect "${name}" ran ${count}x (expected ${expected}x)`);
  }
  for (const s of stats.skipped) {
    if (stats.executed.includes(s)) failures.push(`step "${s}" was both skipped and re-executed`);
  }

  return {
    scenario: scenarioName,
    crashPoint: crashLabel,
    passed: failures.length === 0,
    failures,
    stepsExecutedAfterResume: stats.executed.length,
    stepsSkippedOnResume: stats.skipped.length,
    effectsExecuted: stats.effectsExecuted.length,
    effectsReplayed: stats.effectsReplayed.length,
    journalBytes: second.journal.sizeBytes,
    durationMs: Date.now() - started,
  };
}

export async function runBench(): Promise<{ trials: TrialResult[]; scenarios: ScenarioSummary[] }> {
  const factories: [string, (w: World) => Workflow][] = [
    ['site-builder', siteBuilderWorkflowImport],
    ['ops-report', opsReportWorkflowImport],
    ['inbox-triage', inboxTriageWorkflowImport],
  ];
  const trials: TrialResult[] = [];
  const scenarios: ScenarioSummary[] = [];
  for (const [name, factory] of factories) {
    const base = await baseline(factory);
    const points = crashPointsFor(factory(new World()));
    let passed = 0;
    for (const p of points) {
      const trial = await runTrial(name, factory, p.label, p.plan, base);
      trials.push(trial);
      if (trial.passed) passed++;
    }
    scenarios.push({ scenario: name, steps: factory(new World()).steps.length, crashPoints: points.length, trialsPassed: passed, trialsTotal: points.length });
  }
  return { trials, scenarios };
}

// Local bindings so the factories array reads cleanly.
import { siteBuilderWorkflow as siteBuilderWorkflowImport, opsReportWorkflow as opsReportWorkflowImport, inboxTriageWorkflow as inboxTriageWorkflowImport } from './scenarios.ts';

async function main(): Promise<void> {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : 'report';
  mkdirSync(outDir, { recursive: true });

  const { trials, scenarios } = await runBench();
  const passed = trials.filter((t) => t.passed).length;

  console.log('\nresume-bench results');
  console.log('====================');
  for (const s of scenarios) {
    console.log(`${s.scenario.padEnd(16)} ${s.trialsPassed}/${s.trialsTotal} crash points passed (${s.steps} steps)`);
  }
  console.log('--------------------');
  console.log(`trials: ${passed}/${trials.length} passed`);
  const replayed = trials.reduce((n, t) => n + t.effectsReplayed, 0);
  const duplicated = trials.filter((t) => t.failures.some((f) => f.includes('side effect'))).length;
  console.log(`effects replayed instead of re-run after resume: ${replayed}`);
  console.log(`trials with a duplicated side effect: ${duplicated}`);

  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), trials, scenarios }, null, 2));
  writeFileSync(join(outDir, 'report.html'), renderReport(trials, scenarios));
  console.log(`\nreports written to ${outDir}/report.json and ${outDir}/report.html`);

  if (passed !== trials.length) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) await main();
