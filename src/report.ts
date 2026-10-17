/**
 * report.ts - renders the bench results as a self-contained HTML page.
 * No external assets, so the file opens from disk anywhere.
 */

import type { TrialResult, ScenarioSummary } from './bench.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderReport(trials: TrialResult[], scenarios: ScenarioSummary[]): string {
  const passed = trials.filter((t) => t.passed).length;
  const replayed = trials.reduce((n, t) => n + t.effectsReplayed, 0);
  const skipped = trials.reduce((n, t) => n + t.stepsSkippedOnResume, 0);
  const generatedAt = new Date().toISOString();

  const scenarioRows = scenarios
    .map(
      (s) => `<tr>
        <td>${esc(s.scenario)}</td>
        <td>${s.steps}</td>
        <td>${s.crashPoints}</td>
        <td class="${s.trialsPassed === s.trialsTotal ? 'pass' : 'fail'}">${s.trialsPassed}/${s.trialsTotal}</td>
      </tr>`,
    )
    .join('\n');

  const trialRows = trials
    .map(
      (t) => `<tr>
        <td>${esc(t.scenario)}</td>
        <td><code>${esc(t.crashPoint)}</code></td>
        <td class="${t.passed ? 'pass' : 'fail'}">${t.passed ? 'PASS' : 'FAIL'}</td>
        <td>${t.stepsSkippedOnResume}</td>
        <td>${t.stepsExecutedAfterResume}</td>
        <td>${t.effectsReplayed}</td>
        <td>${t.journalBytes}</td>
        <td>${t.failures.length ? esc(t.failures.join('; ')) : '-'}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>resume-bench report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif; margin: 0; background: #f6f7f9; color: #17202a; }
  main { max-width: 980px; margin: 0 auto; padding: 40px 24px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: #5b6572; font-size: 14px; margin-bottom: 28px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .card { background: #fff; border: 1px solid #e3e7ec; border-radius: 10px; padding: 16px 18px; }
  .card .num { font-size: 26px; font-weight: 650; }
  .card .label { font-size: 12.5px; color: #5b6572; margin-top: 2px; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e7ec; border-radius: 10px; overflow: hidden; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #edf0f3; vertical-align: top; }
  th { background: #fbfcfd; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5b6572; }
  tr:last-child td { border-bottom: none; }
  .pass { color: #147a3d; font-weight: 600; }
  .fail { color: #b3261e; font-weight: 600; }
  code { background: #eef1f4; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  footer { margin-top: 28px; font-size: 12.5px; color: #7a8490; }
</style>
</head>
<body>
<main>
  <h1>resume-bench</h1>
  <div class="sub">Crash-resume correctness for a tiny durable agent-workflow engine. Generated ${esc(generatedAt)}.</div>
  <div class="cards">
    <div class="card"><div class="num">${passed}/${trials.length}</div><div class="label">crash trials passed</div></div>
    <div class="card"><div class="num">${skipped}</div><div class="label">completed steps skipped on resume</div></div>
    <div class="card"><div class="num">${replayed}</div><div class="label">side effects replayed, not re-run</div></div>
    <div class="card"><div class="num">${scenarios.length}</div><div class="label">agent workflows benched</div></div>
  </div>

  <h2>Scenarios</h2>
  <table>
    <thead><tr><th>Scenario</th><th>Steps</th><th>Crash points</th><th>Passed</th></tr></thead>
    <tbody>${scenarioRows}</tbody>
  </table>

  <h2>Every crash point</h2>
  <table>
    <thead><tr><th>Scenario</th><th>Crash point</th><th>Result</th><th>Skipped</th><th>Re-run</th><th>Effects replayed</th><th>Journal bytes</th><th>Failures</th></tr></thead>
    <tbody>${trialRows}</tbody>
  </table>

  <footer>Deterministic, offline, no API keys. Each trial crashes a workflow process at the named point, resumes from the append-only journal with a fresh runner, and checks output identity plus side-effect counts. Exactly-once holds for effects declared idempotent (endpoint dedupes on the journaled key); commit-gap crashes on non-idempotent effects halt with an explicit unknown-outcome error - no general exactly-once guarantee. Single-process, sequential, no retries or concurrency.</footer>
</main>
</body>
</html>`;
}
