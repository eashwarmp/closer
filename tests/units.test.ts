import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fromOpenAI, toOpenAI } from "../src/agent/openai-compat.js";
import { TOOL_DEFS } from "../src/agent/tools.js";
import { BrowserSession } from "../src/browser/session.js";
import { startCrm, type CrmServer } from "../src/crm/server.js";

let crm: CrmServer;
before(async () => {
  crm = await startCrm();
});
after(async () => {
  await crm.close();
});

test("a modal that pops up mid-form makes clicks fail with a message that names the overlay", async () => {
  await fetch(`${crm.url}/__reset`, { method: "POST", body: JSON.stringify({ modal: "delayed" }) });
  const b = await BrowserSession.launch({ baseUrl: `${crm.url}/leads/new` });
  try {
    const before = await b.observe();
    assert.doesNotMatch(before, /DIALOG OPEN/, "modal is not there yet");
    const ref = before.match(/\[(e\d+)\] button "Create lead"/)![1];
    await b.page.waitForTimeout(1700);
    await assert.rejects(b.click(ref), /covering it.*dialog or overlay/s);
    assert.match(await b.observe(), /DIALOG OPEN: "What's new in Pipewise"/);
  } finally {
    await b.close();
  }
});

test("moved buttons get new ids on every render", async () => {
  await fetch(`${crm.url}/__reset`, { method: "POST", body: JSON.stringify({ moveButtons: true }) });
  const html = async () => (await fetch(`${crm.url}/leads/new`)).text();
  const id = (h: string) => h.match(/<button type="submit" id="([^"]+)"/)![1];
  assert.notEqual(id(await html()), id(await html()));
});

test("open-model adapter: tool calls and results round-trip through the OpenAI chat format", () => {
  const msgs = toOpenAI({
    system: "sys",
    tools: TOOL_DEFS,
    messages: [
      { role: "user", content: [{ type: "text", text: "[Buyer]: hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "observe", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "URL: /", is_error: true }, { type: "text", text: "[Buyer interrupts]: wait" }] },
    ],
  });
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["system", "user", "assistant", "tool", "user"],
  );
  assert.equal((msgs[3] as { content: string }).content, "ERROR: URL: /");

  const back = fromOpenAI({
    model: "qwen3",
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: '{"ref":"e3"}' } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  });
  assert.equal(back.stop_reason, "tool_use");
  assert.deepEqual(back.content[0], { type: "tool_use", id: "c1", name: "click", input: { ref: "e3" } });
});
