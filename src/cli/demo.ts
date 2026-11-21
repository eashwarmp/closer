// Live demo: a visible browser, you type as the buyer. Type while the agent is working to interrupt it.
//   npm run demo
//   npm run demo -- --voice                 (agent speaks through macOS `say`; typing cuts it off)
//   npm run demo -- --model ollama:qwen3:4b

import "./env.js";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { DemoAgent } from "../agent/agent.js";
import { BuyerChannel } from "../agent/buyer.js";
import { DEFAULT_MODEL, makeModel } from "../agent/factory.js";
import type { Effort } from "../agent/model.js";
import { BrowserSession } from "../browser/session.js";
import { startCrm } from "../crm/server.js";
import { fmt } from "../eval/runner.js";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: process.env.LIVEDEMO_MODEL ?? DEFAULT_MODEL },
    effort: { type: "string", default: "medium" },
    port: { type: "string", default: "4100" },
    voice: { type: "boolean", default: false },
  },
});

let model: ReturnType<typeof makeModel>;
try {
  model = makeModel(args.model, args.effort as Effort);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const crm = await startCrm(Number(args.port));
const browser = await BrowserSession.launch({ baseUrl: `${crm.url}/`, headless: false, humanize: true });
const buyer = new BuyerChannel();
const agent = new DemoAgent({ model, browser, buyer });

// Speech queue for --voice. A new buyer line stops whatever the agent is saying (barge-in).
const speech: string[] = [];
let speaking: ChildProcess | null = null;
const speakNext = () => {
  if (speaking || !speech.length) return;
  speaking = spawn("say", ["-r", "205", speech.shift()!], { stdio: "ignore" });
  speaking.on("exit", () => {
    speaking = null;
    speakNext();
  });
};
const bargeIn = () => {
  speech.length = 0;
  speaking?.kill();
};

agent.onEvent((e) => {
  if (e.type === "buyer") return; // already on screen as typed
  console.log(fmt(e));
  if (e.type === "say" && args.voice) {
    speech.push(e.text);
    speakNext();
  }
});

console.log(`Pipewise CRM at ${crm.url} · model ${model.model}
Talk to the agent as the buyer. Try: "Show me how to create a lead, assign it to Marcus, and set up a follow-up call for Friday."
Commands: /chaos {"modal":"delayed"} · /reset · /quit\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  if (text === "/quit") return shutdown();
  if (text === "/reset" || text.startsWith("/chaos")) {
    const body = text === "/reset" ? "{}" : text.slice(6).trim() || "{}";
    const res = await fetch(`${crm.url}${text === "/reset" ? "/__reset" : "/__chaos"}`, { method: "POST", body });
    console.log(`  ${text.split(" ")[0]} → ${res.status}`);
    await browser.page.reload();
  } else if (text) {
    bargeIn();
    buyer.push(text);
  }
  rl.prompt();
});
rl.on("close", shutdown);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  bargeIn();
  agent.stop();
  await browser.close().catch(() => {});
  await crm.close();
  process.exit(0);
}

agent.run().catch((err: unknown) => {
  console.error(`\nAgent stopped: ${err instanceof Error ? err.message : String(err)}`);
  void shutdown();
});
