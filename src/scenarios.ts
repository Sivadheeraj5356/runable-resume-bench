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

  record(name: string, detail: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    this.log.push(`${name}: ${detail}`);
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
          await ctx.effect('write-files', () => {
            world.record('write-files', '3 pages written to workspace');
            return 3;
          });
          return html;
        },
      },
      {
        id: 'deploy',
        run: async (input, ctx) => {
          const url = await ctx.effect('deploy-site', () => {
            world.record('deploy-site', 'site live at sandbox preview URL');
            return 'https://preview.sandbox/crumb-culture';
          });
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
          await ctx.effect('create-doc', () => {
            world.record('create-doc', 'weekly ops report doc created');
            return 'doc://ops-report/2026-W42';
          });
          return doc;
        },
      },
      {
        id: 'notify',
        run: async (input, ctx) => {
          await ctx.effect('send-summary', () => {
            world.record('send-summary', 'summary sent to owner');
            return true;
          });
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
          await ctx.effect('save-drafts', () => {
            world.record('save-drafts', '4 reply drafts saved');
            return 4;
          });
          return drafts;
        },
      },
    ],
  };
}

export function allScenarios(world: World): Workflow[] {
  return [siteBuilderWorkflow(world), opsReportWorkflow(world), inboxTriageWorkflow(world)];
}
