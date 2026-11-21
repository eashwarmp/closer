import fs from "node:fs";
import path from "node:path";
import { DemoAgent, type TimedEvent } from "../agent/agent.js";
import { BuyerChannel } from "../agent/buyer.js";
import { costUsd, type ModelClient } from "../agent/model.js";
import { BROWSER_ACTIONS } from "../agent/tools.js";
import { BrowserSession } from "../browser/session.js";
import type { CrmState } from "../crm/store.js";
import type { GradeCtx, Scenario } from "./scenarios.js";

export interface ScenarioResult {
  id: string;
  title: string;
  category: string;
  passed: boolean;
  checks: { name: string; pass: boolean }[];
  outcome: "finished" | "timeout" | "crashed";
  error?: string;
  durationMs: number;
  model: string;
  modelCalls: number;
  preemptedCalls: number;
  browserActions: number;
  failedActions: number;
  injectedFailures: number;
  skippedActions: number;
  interruptions: { fired: number; late: number };
  /** Buyer finished speaking -> agent starts speaking, per buyer utterance. */
  speechLatencyMs: number[];
  /** Buyer finished speaking -> first browser action. */
  actionLatencyMs: number[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  transcript: string[];
  video?: string;
}

export interface RunOptions {
  crmUrl: string;
  makeModel: () => ModelClient;
  outDir: string;
  headless?: boolean;
  video?: boolean;
  log?: (line: string) => void;
}

const START_PATH = "/leads";

export async function runScenario(sc: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const log = opts.log ?? (() => {});
  const scDir = path.join(opts.outDir, "scenarios", sc.id);
  fs.mkdirSync(scDir, { recursive: true });
  await post(`${opts.crmUrl}/__reset`, sc.chaos ?? {});

  const browser = await BrowserSession.launch({
    baseUrl: `${opts.crmUrl}${START_PATH}`,
    headless: opts.headless ?? true,
    recordVideoDir: opts.video ? scDir : undefined,
  });
  const urls: string[] = [START_PATH];
  browser.page.on("framenavigated", (f) => {
    if (f === browser.page.mainFrame()) {
      const u = new URL(f.url());
      urls.push(u.pathname + u.search);
    }
  });

  const buyer = new BuyerChannel();
  const model = opts.makeModel();
  const agent = new DemoAgent({ model, browser, buyer, faults: sc.faults, approvalTimeoutMs: 30_000 });
  const events: TimedEvent[] = [];
  const trace = fs.createWriteStream(path.join(scDir, "trace.jsonl"));
  const pendingInterrupts = [...(sc.interruptions ?? [])].map((i) => ({ ...i, fired: false }));
  const followups = [...(sc.followups ?? [])];
  let fired = 0;
  let late = 0;
  let finish: (outcome: ScenarioResult["outcome"]) => void = () => {};
  const done = new Promise<ScenarioResult["outcome"]>((r) => (finish = r));

  // The simulated buyer: interrupts when a trigger matches, answers approval questions, replies
  // with scripted follow-ups when the agent waits, and hangs up when it has nothing left to say.
  agent.onEvent((e) => {
    events.push(e);
    trace.write(JSON.stringify(e) + "\n");
    log(fmt(e));
    if (e.type === "approval") {
      setTimeout(() => buyer.push(sc.approvalReply ?? "No, let's not do that."), 300);
      return;
    }
    if (e.type === "turn_end") {
      const next = pendingInterrupts.find((i) => !i.fired);
      if (next) {
        next.fired = true;
        fired++;
        late++;
        buyer.push(next.say);
      } else if (followups.length) {
        buyer.push(followups.shift()!);
      } else {
        finish("finished");
      }
      return;
    }
    const due = pendingInterrupts.find((i) => !i.fired);
    if (due && due.when(e, { fired, urls })) {
      due.fired = true;
      fired++;
      const delay = due.delayMs ?? 250;
      if (delay > 0) setTimeout(() => buyer.push(due.say), delay);
      else buyer.push(due.say); // lands before the agent's next queued step
    }
  });

  const t0 = Date.now();
  buyer.push(sc.opening);
  const timeout = setTimeout(() => finish("timeout"), sc.timeoutMs ?? 240_000);
  let error: string | undefined;
  const running = agent.run().catch((err: unknown) => {
    error = err instanceof Error ? err.message : String(err);
    finish("crashed");
  });
  const outcome = await done;
  clearTimeout(timeout);
  agent.stop();
  await running;
  const durationMs = Date.now() - t0;

  const finalUrl = new URL(browser.url).pathname + new URL(browser.url).search;
  const state = (await (await fetch(`${opts.crmUrl}/api/state`)).json()) as CrmState;
  const video = (await browser.close()) ?? undefined;
  trace.end();

  const said = events.flatMap((e) => (e.type === "say" ? [e.text] : []));
  const ctx: GradeCtx = { state, said, events, urls, finalUrl };
  const checks = sc.checks.map((c) => {
    let pass = false;
    try {
      pass = c.test(ctx);
    } catch {
      pass = false;
    }
    return { name: c.name, pass };
  });
  const result: ScenarioResult = {
    id: sc.id,
    title: sc.title,
    category: sc.category,
    passed: outcome === "finished" && checks.every((c) => c.pass),
    checks,
    outcome,
    error,
    durationMs,
    model: model.model,
    ...summarize(events),
    interruptions: { fired, late },
    transcript: events.flatMap((e) => (e.type === "buyer" ? [`BUYER: ${e.text}`] : e.type === "say" ? [`AGENT: ${e.text}`] : [])),
    video: video ? path.relative(opts.outDir, video) : undefined,
  };
  fs.writeFileSync(path.join(scDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

function summarize(events: TimedEvent[]) {
  const tools = events.filter((e): e is Extract<TimedEvent, { type: "tool" }> => e.type === "tool");
  const actions = tools.filter((e) => BROWSER_ACTIONS.has(e.name) && !e.skipped);
  const llm = events.filter((e): e is Extract<TimedEvent, { type: "llm" }> => e.type === "llm");
  const speechLatencyMs: number[] = [];
  const actionLatencyMs: number[] = [];
  events.forEach((e, i) => {
    if (e.type !== "buyer") return;
    const rest = events.slice(i + 1);
    const nextBuyer = rest.findIndex((x) => x.type === "buyer");
    const window = nextBuyer < 0 ? rest : rest.slice(0, nextBuyer);
    const say = window.find((x) => x.type === "say");
    const act = window.find((x) => x.type === "tool" && BROWSER_ACTIONS.has(x.name) && !x.skipped);
    if (say) speechLatencyMs.push(say.t - e.t);
    // Approval replies don't need a browser action to follow, so only count requests.
    if (act && !e.interrupting && !/^(yes|no|hmm)/i.test(e.text)) actionLatencyMs.push(act.t - e.t);
  });
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  for (const c of llm) {
    if (!c.usage) continue;
    tokens.input += c.usage.input_tokens;
    tokens.output += c.usage.output_tokens;
    tokens.cacheRead += c.usage.cache_read_input_tokens ?? 0;
    tokens.cacheWrite += c.usage.cache_creation_input_tokens ?? 0;
    cost += costUsd(c.model, c.usage);
  }
  return {
    modelCalls: llm.length,
    preemptedCalls: llm.filter((c) => c.aborted).length,
    browserActions: actions.length,
    failedActions: actions.filter((a) => !a.ok).length,
    injectedFailures: actions.filter((a) => a.injected).length,
    skippedActions: tools.filter((t) => t.skipped).length,
    speechLatencyMs,
    actionLatencyMs,
    tokens,
    costUsd: cost,
  };
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
}

export function fmt(e: TimedEvent): string {
  const ts = `${(e.t / 1000).toFixed(1).padStart(6)}s`;
  switch (e.type) {
    case "buyer":
      return `${ts}  BUYER${e.interrupting ? " (interrupting)" : ""}: ${e.text}`;
    case "say":
      return `${ts}  AGENT: ${e.text}`;
    case "tool":
      return `${ts}    ${e.skipped ? "⤼" : e.ok ? "✓" : "✗"} ${e.name} ${JSON.stringify(e.input)} ${e.injected ? "[injected] " : ""}(${e.ms}ms) ${e.ok && !e.skipped ? "" : e.summary}`;
    case "llm":
      return `${ts}    · model ${e.aborted ? "call preempted" : `${e.ms}ms, ${e.usage?.output_tokens ?? 0} out tokens`}`;
    case "approval":
      return `${ts}    ? approval requested`;
    case "turn_end":
      return `${ts}    — agent waiting for buyer`;
    case "error":
      return `${ts}    ! ${e.message}`;
  }
}
