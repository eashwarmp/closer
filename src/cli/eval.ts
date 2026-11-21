// Run the scenario suite and write a report.
//   npm run eval
//   npm run eval -- --only interrupt-reassign,modal-delayed --headed
//   npm run eval -- --model groq:openai/gpt-oss-120b --tag oss-baseline --concurrency 3

import "./env.js";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, makeModel } from "../agent/factory.js";
import type { Effort } from "../agent/model.js";
import { PROMPT_VERSION } from "../agent/prompt.js";
import { startCrm } from "../crm/server.js";
import { renderMarkdown, summarize, type RunMeta } from "../eval/report.js";
import { runScenario, type ScenarioResult } from "../eval/runner.js";
import { SCENARIOS } from "../eval/scenarios.js";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: process.env.LIVEDEMO_MODEL ?? DEFAULT_MODEL },
    effort: { type: "string", default: "medium" },
    only: { type: "string" },
    tag: { type: "string" },
    out: { type: "string" },
    concurrency: { type: "string", default: "1" },
    repeat: { type: "string", default: "1" },
    video: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    worker: { type: "boolean", default: false },
  },
});

const only = args.only?.split(",").map((s) => s.trim()).filter(Boolean);
const unknown = only?.filter((id) => !SCENARIOS.some((s) => s.id === id.split("~")[0]));
if (unknown?.length) {
  console.error(`Unknown scenario(s): ${unknown.join(", ")}\nAvailable: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}
try {
  makeModel(args.model, args.effort as Effort); // fail fast on a bad model spec or missing key
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const repeat = Math.max(1, Number(args.repeat));
// A run id is the scenario id, plus ~N when repeating, so trials get separate trace folders.
const requested = only ?? SCENARIOS.flatMap((s) => Array.from({ length: repeat }, (_, k) => (repeat > 1 ? `${s.id}~${k + 1}` : s.id)));

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const tag = args.tag ?? args.model.replace(/[^\w.-]+/g, "_");
const outDir = path.resolve(args.out ?? path.join("runs", `${stamp}-${tag}`));
fs.mkdirSync(outDir, { recursive: true });

// Re-using an --out folder resumes it: scenarios with a finished result are skipped, and the report
// covers everything in the folder. Lets a quota-limited free tier build up a full run over several days.
const resultFile = (id: string) => path.join(outDir, "scenarios", id, "result.json");
const finished = (id: string) => fs.existsSync(resultFile(id)) && (JSON.parse(fs.readFileSync(resultFile(id), "utf8")) as ScenarioResult).outcome !== "crashed";
const runIds = args.worker ? requested : requested.filter((id) => !finished(id));
if (runIds.length < requested.length) console.log(`Resuming ${outDir}: ${requested.length - runIds.length} scenario(s) already done.`);

async function runIdsHere(ids: string[]): Promise<void> {
  const crm = await startCrm();
  try {
    for (const runId of ids) {
      const base = SCENARIOS.find((s) => s.id === runId.split("~")[0])!;
      if (!args.quiet) console.log(`\n▶ ${runId}: ${base.title}`);
      const r = await runScenario(
        { ...base, id: runId },
        {
          crmUrl: crm.url,
          makeModel: () => makeModel(args.model, args.effort as Effort),
          outDir,
          headless: !args.headed,
          video: args.video,
          log: args.quiet ? undefined : (line) => console.log(line),
        },
      );
      if (r.outcome === "crashed" && /429 per-day quota/.test(r.error ?? "")) {
        console.log(`⛔ ${runId}: ${r.error} Stopping; re-run with --out ${outDir} to resume.`);
        break;
      }
      console.log(`${r.outcome === "crashed" ? "⚠️  ERROR" : r.passed ? "✅ PASS" : "❌ FAIL"} ${runId} (${(r.durationMs / 1000).toFixed(0)}s, $${r.costUsd.toFixed(3)})${r.passed ? "" : r.error ? `  crashed: ${r.error}` : `  ${r.checks.filter((c) => !c.pass).map((c) => c.name).join("; ") || r.outcome}`}`);
    }
  } finally {
    await crm.close();
  }
}

if (args.worker) {
  await runIdsHere(runIds);
  process.exit(0);
}

// Each worker process gets its own CRM, so scenarios can run in parallel without sharing state.
const n = Math.min(Math.max(1, Number(args.concurrency)), runIds.length);
console.log(`Running ${runIds.length} scenario run(s) with ${args.model} (effort ${args.effort}), ${n} at a time → ${outDir}`);
if (n === 1) {
  await runIdsHere(runIds);
} else {
  const shards = Array.from({ length: n }, (_, i) => runIds.filter((_, j) => j % n === i));
  await Promise.all(
    shards.map(
      (ids) =>
        new Promise<void>((resolve) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", process.argv[1], "--worker", "--quiet", "--out", outDir, "--only", ids.join(","), "--model", args.model, "--effort", args.effort, ...(args.video ? ["--video"] : [])],
            { stdio: "inherit" },
          );
          child.on("exit", () => resolve());
        }),
    ),
  );
}

const scenarioDirs = fs.existsSync(path.join(outDir, "scenarios")) ? fs.readdirSync(path.join(outDir, "scenarios")).sort() : [];
const results: ScenarioResult[] = scenarioDirs.flatMap((id) =>
  fs.existsSync(resultFile(id)) ? [JSON.parse(fs.readFileSync(resultFile(id), "utf8")) as ScenarioResult] : [],
);
let gitSha: string | null = null;
try {
  gitSha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
} catch {}
const meta: RunMeta = { tag, model: args.model, effort: args.effort, promptVersion: PROMPT_VERSION, startedAt: new Date().toISOString(), gitSha };
const summary = summarize(meta, results);
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(summary, results));
console.log(`\n${summary.passed}/${summary.scenarios} passed${summary.errored ? `, ${summary.errored} errored (excluded)` : ""}. Report: ${path.join(outDir, "report.md")}`);
if (results.filter((r) => runIds.includes(r.id)).length < runIds.length) console.log(`⚠ ${runIds.length - results.length} run(s) produced no result; see worker output above.`);
