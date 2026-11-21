import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createLiveDemoMcp } from "../src/mcp/server.js";

const textOf = (r: unknown) =>
  ((r as CallToolResult).content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
const refIn = (page: string, label: RegExp) => {
  const line = page.split("\n").find((l) => /^\s*\[e\d+\]/.test(l) && label.test(l));
  assert.ok(line, `no element matching ${label} in:\n${page}`);
  return line.match(/\[(e\d+)\]/)![1];
};

/** An in-process client, optionally able to show approval prompts and answering them with `approve`. */
async function connect(approve?: () => boolean) {
  const mcp = createLiveDemoMcp({ headless: true, crmPort: 0, log: () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities: approve ? { elicitation: {} } : {} });
  if (approve) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: approve() } }));
  await mcp.server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, close: () => mcp.close() };
}

test("stdio launcher: lists tools, prompt, and resource; drives a full create-lead flow", async () => {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["bin/livedemo-mcp.mjs"], env: { ...process.env, LIVEDEMO_HEADLESS: "1", LIVEDEMO_CRM_PORT: "0" } as Record<string, string>, stderr: "ignore" }),
  );
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["click", "navigate", "observe", "press_key", "record_user_approval", "request_approval", "reset_demo", "screenshot", "select_option", "type_text", "wait"]);
    assert.equal((await client.listPrompts()).prompts[0].name, "run_demo");

    const call = async (name: string, args: Record<string, unknown> = {}) => textOf(await client.callTool({ name, arguments: args }));
    let page = await call("navigate", { path: "/leads/new" });
    await call("type_text", { ref: refIn(page, /"Full name"/), text: "Dana Whitfield" });
    await call("type_text", { ref: refIn(page, /"Company"/), text: "Copperleaf Solar" });
    await call("type_text", { ref: refIn(page, /"Email"/), text: "dana@copperleafsolar.com" });
    page = await call("click", { ref: refIn(page, /button "Create lead"/) });
    assert.match(page, /URL: \/leads\/\d+/);
    assert.match(page, /Lead created/);

    const state = await client.readResource({ uri: "pipewise://state" });
    assert.match(String((state.contents[0] as { text: string }).text), /Dana Whitfield/);

    const shot = (await client.callTool({ name: "screenshot", arguments: {} })) as CallToolResult;
    assert.equal(shot.content[0].type, "image");
  } finally {
    await client.close();
  }
});

test("approval via elicitation: blocked without it, a 'no' keeps the record, a 'yes' allows one delete", async () => {
  let answer = false;
  const { call, close } = await connect(() => answer);
  try {
    await call("reset_demo");
    let page = textOf(await call("navigate", { path: "/leads/9" }));
    page = textOf(await call("click", { ref: refIn(page, /"Delete lead"/) }));
    const confirm = refIn(page, /button "Delete".*consequential/);

    const blocked = await call("click", { ref: confirm });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /Blocked/);

    assert.match(textOf(await call("request_approval", { question: "Delete Grace Kim's lead?" })), /NOT granted/);
    assert.equal((await call("click", { ref: confirm })).isError, true);

    answer = true;
    assert.match(textOf(await call("request_approval", { question: "Delete Grace Kim's lead?" })), /Approval granted/);
    assert.match(textOf(await call("click", { ref: confirm })), /URL: \/leads\b[\s\S]*Lead deleted/);
  } finally {
    await close();
  }
});

test("approval fallback: clients without prompts get told to ask, and only a clear yes is recorded", async () => {
  const { call, close } = await connect();
  try {
    await call("reset_demo", { modal: "onLoad" });
    assert.match(textOf(await call("request_approval", { question: "Delete it?" })), /record_user_approval/);
    const vague = await call("record_user_approval", { user_said: "hmm, maybe later" });
    assert.equal(vague.isError, true);
    assert.match(textOf(await call("record_user_approval", { user_said: "Yes, go ahead" })), /Approval recorded/);
    assert.match(textOf(await call("observe")), /DIALOG OPEN: "What's new in Pipewise"/, "reset_demo turned the fault on");
  } finally {
    await close();
  }
});
