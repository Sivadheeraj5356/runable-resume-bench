/**
 * runner.ts - a tiny durable execution engine for step-based agent workflows.
 *
 * A workflow is an ordered list of steps. Each step receives the previous
 * step's output and may perform side effects through `ctx.effect(name, fn)`.
 *
 * Durability contract:
 *  - A completed step is never re-executed on resume (memoized in the journal,
 *    keyed by step id + input hash).
 *  - A completed side effect is never re-executed.
 *  - THE COMMIT GAP: a process can die after an effect executed in the world
 *    but before its completion was journaled. Journaling alone cannot close
 *    this gap, so every effect first writes an INTENT record carrying a
 *    deterministic idempotency key, then executes, then writes completion.
 *    On resume with an intent but no completion the outcome is unknown:
 *      - effect declared `idempotent: true` -> re-executed with the SAME key;
 *        safety comes from the endpoint deduping on that key, not from the journal.
 *      - otherwise -> the runner halts with UnknownOutcomeError instead of
 *        silently duplicating. No engine can give exactly-once over a
 *        non-idempotent external system; that needs the endpoint's cooperation.
 *  - A changed input hash invalidates the memo entry, so stale results are
 *    never silently replayed.
 *
 * Scope: single-process, sequential steps, no retries/backoff, no
 * concurrency control. Crash simulation: `FaultPlan` arms a one-shot crash.
 */

import { Journal, hashInput } from './journal.ts';

export class CrashInjected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrashInjected';
  }
}

export class UnknownOutcomeError extends Error {
  readonly stepId: string;
  readonly effectName: string;
  readonly idempotencyKey: string;
  constructor(stepId: string, effectName: string, idempotencyKey: string) {
    super(
      `effect "${stepId}/${effectName}" (idempotency key ${idempotencyKey}) executed before a crash, ` +
        `but its completion was never journaled and it is not declared idempotent. ` +
        `External outcome unknown; halting instead of risking a duplicate side effect.`,
    );
    this.name = 'UnknownOutcomeError';
    this.stepId = stepId;
    this.effectName = effectName;
    this.idempotencyKey = idempotencyKey;
  }
}

export interface EffectOptions {
  /**
   * Declare that re-executing this effect with the same idempotency key is
   * safe because the receiving endpoint dedupes on that key. Without this
   * declaration, a crash in the commit gap halts with UnknownOutcomeError.
   */
  idempotent?: boolean;
}

export interface StepCtx {
  readonly workflowId: string;
  readonly stepId: string;
  /** Run a side effect under journal + idempotency-key protection. */
  effect<T>(name: string, fn: (idempotencyKey: string) => T | Promise<T>, opts?: EffectOptions): Promise<T>;
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
  /** Crash inside this step, after its first effect's completion is journaled. */
  crashDuringStep?: string;
  /** Crash inside this step, after its first effect EXECUTED but before its
   *  completion is journaled - the commit gap. */
  crashAfterEffectExecute?: string;
}

export interface RunStats {
  executed: string[];
  skipped: string[];
  effectsExecuted: string[];
  effectsReplayed: string[];
  effectsRetriedWithKey: string[];
}

export function emptyStats(): RunStats {
  return { executed: [], skipped: [], effectsExecuted: [], effectsReplayed: [], effectsRetriedWithKey: [] };
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
        effect: async <T>(name: string, fn: (idempotencyKey: string) => T | Promise<T>, opts?: EffectOptions): Promise<T> => {
          const effectHash = hashInput({ workflow: workflow.id, step: step.id, effect: name, input });
          // Deterministic idempotency key: identical across the crash and the resume.
          const key = hashInput({ kind: 'idempotency-key', workflow: workflow.id, step: step.id, effect: name, input });

          const recorded = this.journal.lookup('effect', workflow.id, step.id, name, effectHash);
          if (recorded) {
            stats.effectsReplayed.push(`${step.id}/${name}`);
            return recorded.value as T;
          }

          const intent = this.journal.lookup('effect-intent', workflow.id, step.id, name, effectHash);
          if (intent) {
            // Commit gap: the effect may already have executed in the world.
            if (!opts?.idempotent) throw new UnknownOutcomeError(step.id, name, key);
            const start = Date.now();
            const value = (await fn(key)) ?? null;
            this.journal.append({
              kind: 'effect', workflowId: workflow.id, stepId: step.id, name, inputHash: effectHash, key,
              value, at: new Date().toISOString(), durationMs: Date.now() - start,
            });
            stats.effectsRetriedWithKey.push(`${step.id}/${name}`);
            return value as T;
          }

          this.journal.append({
            kind: 'effect-intent', workflowId: workflow.id, stepId: step.id, name, inputHash: effectHash, key,
            value: null, at: new Date().toISOString(), durationMs: 0,
          });
          const start = Date.now();
          const value = (await fn(key)) ?? null;
          if (this.armed && this.faults.crashAfterEffectExecute === step.id && !firstEffectSeen) {
            this.armed = false;
            throw new CrashInjected(`process crashed during step "${step.id}" after effect "${name}" executed but before its completion was journaled`);
          }
          this.journal.append({
            kind: 'effect', workflowId: workflow.id, stepId: step.id, name, inputHash: effectHash, key,
            value, at: new Date().toISOString(), durationMs: Date.now() - start,
          });
          stats.effectsExecuted.push(`${step.id}/${name}`);
          if (this.armed && this.faults.crashDuringStep === step.id && !firstEffectSeen) {
            this.armed = false;
            throw new CrashInjected(`process crashed during step "${step.id}" after effect "${name}" committed`);
          }
          firstEffectSeen = true;
          return value as T;
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
