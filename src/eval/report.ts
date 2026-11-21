import type { ScenarioResult } from "./runner.js";

export interface RunMeta {
  tag: string;
  model: string;
  effort: string;
  promptVersion: string;
  startedAt: string;
  gitSha: string | null;
}

export interface Summary {
  meta: RunMeta;
  scenarios: number;
  passed: number;
  taskCompletion: number;
  /** Browser actions that worked, excluding failures the harness injected on purpose. */
  actionSuccess: number;
  /** Of scenarios where at least one action failed (organic or injected), the share that still passed. */
  recovery: { rate: number | null; of: number };
  speechLatencyMs: { p50: number | null; p95: number | null };
  actionLatencyMs: { p50: number | null; p95: number | null };
  avgCostUsd: number;
  avgTokens: number;
  avgDurationS: number;
  avgModelCalls: number;
  byCategory: Record<string, { passed: number; total: number }>;
  interruptionsMidTask: number;
  interruptionsLate: number;
}

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(meta: RunMeta, results: ScenarioResult[]): Summary {
  const actions = results.reduce((n, r) => n + r.browserActions - r.injectedFailures, 0);
  const failed = results.reduce((n, r) => n + r.failedActions - r.injectedFailures, 0);
  const hadFailure = results.filter((r) => r.failedActions > 0);
  const byCategory: Summary["byCategory"] = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { passed: 0, total: 0 });
    c.total++;
    if (r.passed) c.passed++;
  }
  const speech = results.flatMap((r) => r.speechLatencyMs);
  const action = results.flatMap((r) => r.actionLatencyMs);
  return {
    meta,
    scenarios: results.length,
    passed: results.filter((r) => r.passed).length,
    taskCompletion: results.length ? results.filter((r) => r.passed).length / results.length : 0,
    actionSuccess: actions ? (actions - failed) / actions : 1,
    recovery: { rate: hadFailure.length ? hadFailure.filter((r) => r.passed).length / hadFailure.length : null, of: hadFailure.length },
    speechLatencyMs: { p50: pct(speech, 50), p95: pct(speech, 95) },
    actionLatencyMs: { p50: pct(action, 50), p95: pct(action, 95) },
    avgCostUsd: avg(results.map((r) => r.costUsd)),
    avgTokens: avg(results.map((r) => r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite)),
    avgDurationS: avg(results.map((r) => r.durationMs / 1000)),
    avgModelCalls: avg(results.map((r) => r.modelCalls)),
    byCategory,
    interruptionsMidTask: results.reduce((n, r) => n + r.interruptions.fired - r.interruptions.late, 0),
    interruptionsLate: results.reduce((n, r) => n + r.interruptions.late, 0),
  };
}

const p = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const s = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);

export function renderMarkdown(sum: Summary, results: ScenarioResult[]): string {
  const m = sum.meta;
  const lines = [
    `# Eval run: ${m.tag}`,
    "",
    `Model \`${m.model}\` · effort ${m.effort} · prompt ${m.promptVersion} · ${m.startedAt}${m.gitSha ? ` · ${m.gitSha}` : ""}`,
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Task completion | **${sum.passed}/${sum.scenarios} (${p(sum.taskCompletion)})** |`,
    `| Browser action success | ${p(sum.actionSuccess)} (injected faults excluded) |`,
    `| Recovery after a failed action | ${p(sum.recovery.rate)} of ${sum.recovery.of} scenarios |`,
    `| Time to first speech, p50 / p95 | ${s(sum.speechLatencyMs.p50)} / ${s(sum.speechLatencyMs.p95)} |`,
    `| Time to first browser action, p50 / p95 | ${s(sum.actionLatencyMs.p50)} / ${s(sum.actionLatencyMs.p95)} |`,
    `| Cost per demo (avg) | $${sum.avgCostUsd.toFixed(3)} |`,
    `| Tokens per demo (avg) | ${Math.round(sum.avgTokens).toLocaleString("en-US")} |`,
    `| Model calls per demo (avg) | ${sum.avgModelCalls.toFixed(1)} |`,
    `| Wall time per demo (avg) | ${sum.avgDurationS.toFixed(0)}s |`,
    `| Interruptions landed mid-task / after the agent finished | ${sum.interruptionsMidTask} / ${sum.interruptionsLate} |`,
    "",
    "## By category",
    "",
    "| Category | Passed |",
    "|---|---|",
    ...Object.entries(sum.byCategory).map(([c, v]) => `| ${c} | ${v.passed}/${v.total} |`),
    "",
    "## Scenarios",
    "",
    "| | Scenario | Category | Actions (failed) | Calls | Speech latency | Cost | Time |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.passed ? "✅" : "❌"} | ${r.id}: ${r.title} | ${r.category} | ${r.browserActions} (${r.failedActions}) | ${r.modelCalls} | ${s(pct(r.speechLatencyMs, 50))} | $${r.costUsd.toFixed(3)} | ${(r.durationMs / 1000).toFixed(0)}s |`,
    ),
  ];
  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const r of failures) {
      lines.push(`### ${r.id}`, "", `Outcome: ${r.outcome}${r.error ? ` (${r.error})` : ""}`, "");
      for (const c of r.checks) lines.push(`- ${c.pass ? "✅" : "❌"} ${c.name}`);
      lines.push("", "<details><summary>Transcript</summary>", "", ...r.transcript.map((t) => `> ${t}  `), "", "</details>", "");
    }
  }
  return lines.join("\n") + "\n";
}
