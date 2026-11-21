// End-to-end through the real CRM, a real headless Chromium, the agent loop, and the eval grader,
// with a scripted policy standing in for the LLM. These pin down the harness: if a scripted agent
// that behaves well passes and one that behaves badly fails, the eval is measuring the right thing.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DemoAgent, type TimedEvent } from "../src/agent/agent.js";
import { BuyerChannel } from "../src/agent/buyer.js";
import type { BrowserSession } from "../src/browser/session.js";
import { startCrm, type CrmServer } from "../src/crm/server.js";
import { runScenario } from "../src/eval/runner.js";
import { SCENARIOS, type Scenario } from "../src/eval/scenarios.js";
import { refFor, ScriptedModel, text, use, type PolicyCtx } from "./helpers.js";

let crm: CrmServer;
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "livedemo-test-"));
before(async () => {
  crm = await startCrm();
});
after(async () => {
  await crm.close();
});

const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
const run = (sc: Scenario, policy: (ctx: PolicyCtx) => ReturnType<ConstructorParameters<typeof ScriptedModel>[0]>) =>
  runScenario(sc, { crmUrl: crm.url, makeModel: () => new ScriptedModel(policy), outDir });

/** Creates Dana's lead. On a timeout it either verifies (careful) or starts over (naive). */
function createDana(onTimeout: "verify" | "retry") {
  let phase = 0;
  return (ctx: PolicyCtx) => {
    if (/Timed out/.test(ctx.input)) {
      if (onTimeout === "retry") phase = 0;
      else return [use("navigate", { path: "/leads?q=Dana" })];
    }
    if (/Dana Whitfield/.test(ctx.page) && /URL: \/leads\?q=Dana/.test(ctx.page)) return [text("That went through, Dana's lead is there.")];
    switch (phase++) {
      case 0:
        return [use("say", { text: "Sure, let me open the new lead form." }), use("navigate", { path: "/leads/new" })];
      case 1:
        return [
          use("type_text", { ref: refFor(ctx.page, /"Full name"/), text: "Dana Whitfield" }),
          use("type_text", { ref: refFor(ctx.page, /"Company"/), text: "Copperleaf Solar" }),
          use("type_text", { ref: refFor(ctx.page, /"Email"/), text: "dana@copperleafsolar.com" }),
          use("type_text", { ref: refFor(ctx.page, /"City"/), text: "Tucson" }),
        ];
      case 2:
        return [use("click", { ref: refFor(ctx.page, /button "Create lead"/) })];
      default:
        return [text("Done. Dana's lead is created.")];
    }
  };
}

test("happy path: creates the lead and passes every check", async () => {
  const r = await run(scenario("create-lead"), createDana("verify"));
  assert.equal(r.outcome, "finished");
  assert.deepEqual(r.checks.filter((c) => !c.pass), []);
  assert.equal(r.passed, true);
  assert.equal(r.failedActions, 0);
  assert.ok(r.speechLatencyMs.length > 0, "measured time to first speech");
});

test("timeout after effect: verifying passes, blindly retrying creates a duplicate and fails", async () => {
  const careful = await run(scenario("timeout-after-effect"), createDana("verify"));
  assert.equal(careful.injectedFailures, 1);
  assert.equal(careful.passed, true, JSON.stringify(careful.checks));

  const naive = await run(scenario("timeout-after-effect"), createDana("retry"));
  assert.equal(naive.passed, false);
  assert.match(naive.checks.find((c) => !c.pass)!.name, /exactly one/);
});

test("interruption: queued browser steps are skipped and the agent re-plans", async () => {
  const sc = scenario("interrupt-cancel");
  const immediate: Scenario = { ...sc, interruptions: sc.interruptions!.map((i) => ({ ...i, delayMs: 0 })) };
  let phase = 0;
  const r = await run(immediate, (ctx) => {
    if (/Buyer interrupts/.test(ctx.input)) return [use("say", { text: "No problem, here's the list." }), use("navigate", { path: "/leads" })];
    if (/URL: \/leads\n/.test(ctx.page) && phase > 1) return [text("This is every lead in the pipeline.")];
    switch (phase++) {
      case 0:
        return [use("navigate", { path: "/leads/new" })];
      case 1:
        return [
          use("type_text", { ref: refFor(ctx.page, /"Full name"/), text: "Theo Brandt" }),
          use("type_text", { ref: refFor(ctx.page, /"Company"/), text: "Larkspur Bakeries" }),
          use("click", { ref: refFor(ctx.page, /button "Create lead"/) }),
        ];
      default:
        return [text("Done.")];
    }
  });
  assert.equal(r.skippedActions, 2, "the company field and the save click never ran");
  assert.equal(r.interruptions.late, 0, "interruption landed mid-task");
  assert.equal(r.passed, true, JSON.stringify(r.checks));
});

test("approval gate: a consequential click without approval is blocked; a 'no' keeps the record", async () => {
  let phase = 0;
  const r = await run(scenario("delete-denied"), (ctx) => {
    switch (phase++) {
      case 0:
        return [use("navigate", { path: "/leads/9" })];
      case 1:
        return [use("click", { ref: refFor(ctx.page, /"Delete lead"/) })];
      case 2:
        return [use("click", { ref: refFor(ctx.page, /button "Delete".*consequential/) })];
      case 3:
        assert.match(ctx.input, /Blocked/);
        return [use("request_approval", { question: "This permanently deletes Grace Kim's lead. Should I go ahead?" })];
      default:
        assert.match(ctx.input, /NOT granted/);
        return [text("Okay, I'll leave it.")];
    }
  });
  assert.equal(r.passed, true, JSON.stringify(r.checks));
  assert.equal(r.failedActions, 1);
});

test("preemption: buyer speech during a model call aborts it and both lines reach the next call", async () => {
  const seen: string[] = [];
  const model = new ScriptedModel((ctx) => {
    seen.push(ctx.input);
    return [text("Got it.")];
  }, 300);
  const buyer = new BuyerChannel();
  const agent = new DemoAgent({ model, browser: {} as BrowserSession, buyer });
  const events: TimedEvent[] = [];
  agent.onEvent((e) => {
    events.push(e);
    if (e.type === "turn_end") agent.stop();
  });
  buyer.push("Show me the dashboard.");
  setTimeout(() => buyer.push("Actually, show me leads instead."), 100);
  await agent.run();
  assert.equal(events.filter((e) => e.type === "llm" && e.aborted).length, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /dashboard[\s\S]*leads instead/);
});
