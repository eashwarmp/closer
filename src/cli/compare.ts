// Compare eval runs side by side: npm run compare [runs/<a> runs/<b> ...]  (default: every run in ./runs)
import fs from "node:fs";
import path from "node:path";
import type { Summary } from "../eval/report.js";

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.existsSync("runs")
    ? fs.readdirSync("runs").sort().map((d) => path.join("runs", d))
    : [];
const runs = dirs.flatMap((d) => {
  const f = path.join(d, "summary.json");
  return fs.existsSync(f) ? [JSON.parse(fs.readFileSync(f, "utf8")) as Summary] : [];
});
if (!runs.length) {
  console.log("No runs with a summary.json found. Run `npm run eval` first.");
  process.exit(0);
}
const p = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const s = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
console.log("| Run | Model | Prompt | Pass | Action success | Recovery | Speech p50/p95 | $/demo | Tokens/demo |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  console.log(
    `| ${r.meta.tag} | ${r.meta.model} (${r.meta.effort}) | ${r.meta.promptVersion} | ${r.passed}/${r.scenarios} | ${p(r.actionSuccess)} | ${p(r.recovery.rate)} | ${s(r.speechLatencyMs.p50)}/${s(r.speechLatencyMs.p95)} | $${r.avgCostUsd.toFixed(3)} | ${Math.round(r.avgTokens).toLocaleString("en-US")} |`,
  );
}
