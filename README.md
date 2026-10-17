# runable-resume-bench

A tiny durable execution engine for long-running agent workflows, plus a
bench that proves its resume behavior by crashing it on purpose.

Built as a work sample for Runable's Software Engineer Intern (New Grad)
application. Runable's agent runs long tasks - building sites, producing
documents, browsing - in durable, resumable workflows. The hard part of that
is not running a workflow once; it is what happens when the process dies at
4% battery of step 3: does the resume skip finished work, and does the
already-deployed site get deployed *again*? This repo is a small, honest
answer to that question.

Original code. No Runable code, no API keys, no network calls, no cost.

## The idea

- Workflows are ordered steps. Each step's completion is appended to a
  JSONL **journal** with a hash of its input.
- Side effects (deploy a site, send a summary, save drafts) only run through
  `ctx.effect(name, fn)`. Their completion is journaled too.
- On resume, completed steps are **skipped** and completed effects are
  **replayed from the journal** - never re-executed. A changed input hash
  invalidates the memo, so stale results are never silently reused.
- A crash halfway through *writing* the journal leaves a torn final line;
  load detects it, truncates to the last complete record, and resumes.

## The bench

`src/bench.ts` runs three synthetic agent workflows (site builder, weekly ops
report, inbox triage - deterministic fake "model" steps, real control flow)
and crashes each one at **every** crash point: before every step, and
mid-step right after a side effect commits. After each crash it resumes with
a fresh runner and checks:

1. final output is identical to the no-crash baseline,
2. no completed step was re-executed,
3. no side effect ran twice in the `World` (a counting stand-in for external
   systems).

It writes `out/report.json` and a self-contained `out/report.html`.

## Run it

Requires Node.js >= 22.6 (uses built-in TypeScript type stripping - zero
dependencies, nothing to install).

```bash
npm run bench   # runs the crash-resume bench, writes out/report.{json,html}
npm test        # node:test suite: journal, runner, exactly-once, bench
```

## What this is and isn't

- **Is:** a working durable-execution core (~200 lines), a fault injector, a
  correctness bench over every crash point, and tests including adversarial
  ones (a workflow that bypasses `ctx.effect` is caught by the bench).
- **Isn't:** a production orchestrator. Single-process, sequential steps, no
  retries/backoff, no concurrency control, no external state stores. The
  numbers in the report measure *this* engine's resume correctness, not any
  external system's performance.

## Layout

```
src/journal.ts    append-only JSONL journal, torn-write recovery, input hashing
src/runner.ts     DurableRunner, ctx.effect exactly-once wrapper, crash injection
src/scenarios.ts  three synthetic agent workflows + a counting World
src/bench.ts      crash-point matrix, durability assertions, CLI
src/report.ts     self-contained HTML report renderer
test/bench.test.ts  node:test suite
```
