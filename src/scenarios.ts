/**
 * scenarios.ts - synthetic agent workflows for the bench.
 *
 * These are original, self-contained demonstrations inspired by the kinds of
 * long-running work a general agent platform has to make durable: building a
 * site, producing an ops report, triaging an inbox. They use deterministic
 * fake "model" steps (pure template functions, no network, no API keys) so
 * the bench is reproducible by anyone who clones the repo.
 *
 * Side effects go through a `World` - a stand-in for external systems
 * (hosting, email, docs). The World counts every call, which is how the
 * bench detects duplicate side effects after a crash and resume.
 */

import type { Workflow } from './runner.ts';

export class World {
  /** effect name -> number of times the real side effect ran */
  readonly calls: Record<string, number> = {};
  readonly log: string[] = [];
  /** idempotency keys already processed per effect (models an idempotency-aware endpoint) */
  private readonly seenKeys: Record<string, Set<string>> = {};

  /** Non-idempotent endpoint: every call lands. */
  record(name: string, detail: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    this.log.push(`${name}: ${detail}`);
  }

  /** Idempotency-aware endpoint (like a deploy API with dedupe keys): a
   * repeated key is acknowledged without performing the side effect twice. */
  recordKeyed(name: string, key: string, detail: string): void {
    this.seenKeys[name] = this.seenKeys[name] ?? new Set<string>();
    if (this.seenKeys[name].has(key)) {
      this.log.push(`${name}: duplicate key ${key} deduped, no second effect`);
      return;
    }
    this.seenKeys[name].add(key);
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    this.log.push(`${name}: ${detail}`);
  }

  keysSeen(name: string): number {
    return this.seenKeys[name]?.size ?? 0;
  }
}

/** Deterministic stand-in for a model call: same input, same output, every time. */
function fakeModel(task: string, input: string): string {
  return `[${task}] ${input.length} chars in -> ${task.toUpperCase().replace(/\s+/g, '_')}_RESULT(${input.slice(0, 48)})`;
}

export function siteBuilderWorkflow(world: World): Workflow {
  return {
    id: 'site-builder',
    initialInput: { brief: 'Landing page for a bakery in Indiranagar', brand: 'Crumb Culture' },
    steps: [
      {
        id: 'research',
        run: (input) => fakeModel('market research', JSON.stringify(input)),
      },
      {
        id: 'draft-copy',
        run: (input) => fakeModel('copywriting', String(input)),
      },
      {
        id: 'build-pages',
        run: async (input, ctx) => {
          const html = fakeModel('page build', String(input));
          await ctx.effect('write-files', (key) => {
            world.recordKeyed('write-files', key, '3 pages written to workspace');
            return 3;
          }, { idempotent: true });
          return html;
        },
      },
      {
        id: 'deploy',
        run: async (input, ctx) => {
          const url = await ctx.effect('deploy-site', (key) => {
            world.recordKeyed('deploy-site', key, 'site live at sandbox preview URL');
            return 'https://preview.sandbox/crumb-culture';
          }, { idempotent: true });
          return { html: input, url };
        },
      },
    ],
  };
}

export function opsReportWorkflow(world: World): Workflow {
  return {
    id: 'ops-report',
    initialInput: { store: 'Koramangala #2', week: '2026-W42' },
    steps: [
      {
        id: 'collect-metrics',
        run: (input) => fakeModel('metrics collection', JSON.stringify(input)),
      },
      {
        id: 'analyze',
        run: (input) => fakeModel('variance analysis', String(input)),
      },
      {
        id: 'draft-doc',
        run: async (input, ctx) => {
          const doc = fakeModel('report drafting', String(input));
          await ctx.effect('create-doc', (key) => {
            world.recordKeyed('create-doc', key, 'weekly ops report doc created');
            return 'doc://ops-report/2026-W42';
          }, { idempotent: true });
          return doc;
        },
      },
      {
        id: 'notify',
        run: async (input, ctx) => {
          await ctx.effect('send-summary', (key) => {
            world.recordKeyed('send-summary', key, 'summary sent to owner');
            return true;
          }, { idempotent: true });
          return input;
        },
      },
    ],
  };
}

export function inboxTriageWorkflow(world: World): Workflow {
  return {
    id: 'inbox-triage',
    initialInput: { mailbox: 'support@bakery.example', threads: 12 },
    steps: [
      {
        id: 'fetch-threads',
        run: (input) => fakeModel('thread fetch', JSON.stringify(input)),
      },
      {
        id: 'classify',
        run: (input) => fakeModel('classification', String(input)),
      },
      {
        id: 'draft-replies',
        run: async (input, ctx) => {
          const drafts = fakeModel('reply drafting', String(input));
          await ctx.effect('save-drafts', (key) => {
            world.recordKeyed('save-drafts', key, '4 reply drafts saved');
            return 4;
          }, { idempotent: true });
          return drafts;
        },
      },
    ],
  };
}

export function allScenarios(world: World): Workflow[] {
  return [siteBuilderWorkflow(world), opsReportWorkflow(world), inboxTriageWorkflow(world)];
}
