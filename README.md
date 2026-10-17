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
  `ctx.effect(name, fn)`. Before executing, the engine journals an INTENT
  record with a deterministic idempotency key; after executing, it journals
  the completion. The key is derived from the step input, so it is identical
  across the crash and the resume.
- On resume, completed steps are **skipped** and completed effects are
  **replayed from the journal** - never re-executed. A changed input hash
  invalidates the memo, so stale results are never silently reused.
- A crash halfway through *writing* the journal leaves a torn final line;
  load detects it, truncates to the last complete record, and resumes.

## The commit gap (the honest boundary)

Journaling alone cannot make an external side effect exactly-once: the
process can die *after* the effect executed in the world but *before* its
completion was journaled. This engine's answer:

- Effect declared `idempotent: true`: on resume the effect is re-executed
  with the **same idempotency key**, and safety comes from the endpoint
  deduping on that key (the bench's `World` models such an endpoint). This
  is how real deploy/payment APIs work.
- Otherwise: resume **halts with `UnknownOutcomeError`** naming the step,
  effect, and key - it refuses to silently duplicate. No engine can
  guarantee exactly-once over a non-idempotent external system; that takes
  the endpoint's cooperation.

The bench crashes every effect-bearing step at this exact gap
(`commit-gap:*` trials) and verifies both behaviors.

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
- **Isn't:** a production orchestrator, and not a general exactly-once
  guarantee. Single-process, sequential steps, no retries/backoff, no
  concurrency control, no external state stores. Exactly-once is shown only
  for journaled, idempotency-key-aware effects; anything else halts
  explicitly. The numbers in the report measure *this* engine's resume
  correctness on synthetic workflows, not any external system's performance.

## Layout

```
src/journal.ts    append-only JSONL journal, torn-write recovery, input hashing
src/runner.ts     DurableRunner, ctx.effect exactly-once wrapper, crash injection
src/scenarios.ts  three synthetic agent workflows + a counting World
src/bench.ts      crash-point matrix, durability assertions, CLI
src/report.ts     self-contained HTML report renderer
test/bench.test.ts  node:test suite
```
