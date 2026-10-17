/**
 * runner.ts - a tiny durable execution engine for step-based agent workflows.
 *
 * A workflow is an ordered list of steps. Each step receives the previous
 * step's output and may perform side effects through `ctx.effect(name, fn)`.
 *
 * Durability contract:
 *  - A completed step is never re-executed on resume (memoized in the journal,
 *    keyed by step id + input hash).
 *  - A completed side effect is never re-executed, even if the process crashed
 *    after the effect but before the step's own completion record landed.
 *    This is the exactly-once property the bench measures.
 *  - A changed input hash invalidates the memo entry, so stale results are
 *    never silently replayed.
 *
 * Crash simulation: `FaultPlan` arms a one-shot crash (before a step starts,
 * or mid-step after its first effect). The runner throws `CrashInjected`,
 * mimicking process death. Re-running `run()` with the same journal resumes.
 */

import { Journal, hashInput } from './journal.ts';

export class CrashInjected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrashInjected';
  }
}

export interface StepCtx {
  readonly workflowId: string;
  readonly stepId: string;
  /** Run a side effect exactly once. Replays the recorded value on resume. */
  effect<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

export interface Step {
  id: string;
  run: (input: unknown, ctx: StepCtx) => unknown | Promise<unknown>;
}

export interface Workflow {
  id: string;
  steps: Step[];
  initialInput?: unknown;
}

export interface FaultPlan {
  /** Crash right before this step would execute. */
  crashBeforeStep?: string;
  /** Crash inside this step, after its first side effect completes. */
  crashDuringStep?: string;
}

export interface RunStats {
  executed: string[];
  skipped: string[];
  effectsExecuted: string[];
  effectsReplayed: string[];
}

export function emptyStats(): RunStats {
  return { executed: [], skipped: [], effectsExecuted: [], effectsReplayed: [] };
}

export class DurableRunner {
  private readonly journal: Journal;
  private readonly faults: FaultPlan;
  private armed: boolean;

  constructor(journal: Journal, faults: FaultPlan = {}) {
    this.journal = journal;
    this.faults = faults;
    this.armed = true; // one crash per process, like the real thing
  }

  async run(workflow: Workflow, stats: RunStats = emptyStats()): Promise<unknown> {
    let input: unknown = workflow.initialInput ?? null;
    for (const step of workflow.steps) {
      const inputHash = hashInput({ workflow: workflow.id, step: step.id, input });

      if (this.armed && this.faults.crashBeforeStep === step.id) {
        this.armed = false;
        throw new CrashInjected(`process crashed before step "${step.id}"`);
      }

      const done = this.journal.lookup('step', workflow.id, step.id, undefined, inputHash);
      if (done) {
        stats.skipped.push(step.id);
        input = done.value;
        continue;
      }

      let firstEffectSeen = false;
      const ctx: StepCtx = {
        workflowId: workflow.id,
        stepId: step.id,
        effect: async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
          const effectHash = hashInput({ workflow: workflow.id, step: step.id, effect: name, input });
          const recorded = this.journal.lookup('effect', workflow.id, step.id, name, effectHash);
          if (recorded) {
            stats.effectsReplayed.push(`${step.id}/${name}`);
            return recorded.value as T;
          }
          const start = Date.now();
          const value = await fn();
          this.journal.append({
            kind: 'effect',
            workflowId: workflow.id,
            stepId: step.id,
            name,
            inputHash: effectHash,
            value: value ?? null,
            at: new Date().toISOString(),
            durationMs: Date.now() - start,
          });
          stats.effectsExecuted.push(`${step.id}/${name}`);
          if (this.armed && this.faults.crashDuringStep === step.id && !firstEffectSeen) {
            this.armed = false;
            throw new CrashInjected(`process crashed during step "${step.id}" after effect "${name}" committed`);
          }
          firstEffectSeen = true;
          return value;
        },
      };

      const start = Date.now();
      const value = (await step.run(input, ctx)) ?? null;
      this.journal.append({
        kind: 'step',
        workflowId: workflow.id,
        stepId: step.id,
        inputHash,
        value,
        at: new Date().toISOString(),
        durationMs: Date.now() - start,
      });
      stats.executed.push(step.id);
      input = value;
    }
    return input;
  }
}
