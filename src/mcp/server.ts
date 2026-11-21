// MCP server: lets any MCP client (Claude Desktop, Claude Code, your own agent) run a Pipewise demo
// in a real browser. The client's model does the reasoning; this server owns the browser, the demo
// app, and the safety rails (stale-ref checks, origin lock, approval before destructive clicks).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PRODUCT_FACTS } from "../agent/prompt.js";
import { ToolExecutor, type ToolOutcome } from "../agent/tools.js";
import { BrowserSession } from "../browser/session.js";
import { NO_CHAOS } from "../crm/chaos.js";
import { startCrm, type CrmServer } from "../crm/server.js";
import { TODAY } from "../crm/store.js";

export interface LiveDemoMcpOptions {
  /** Use a CRM that's already running. Otherwise one is started in-process. */
  crmUrl?: string;
  crmPort?: number;
  /** Show the browser window (default) so people can watch the demo. */
  headless?: boolean;
  /** Animated cursor and human-speed typing. Defaults to on when the window is visible. */
  humanize?: boolean;
  /** Where to log; must not be stdout on a stdio transport. */
  log?: (msg: string) => void;
}

export interface LiveDemoMcp {
  server: McpServer;
  close(): Promise<void>;
}

const ref = z.string().describe("Element ref from the latest page state, e.g. e12");

const FaultsSchema = {
  modal: z.enum(["off", "onLoad", "delayed"]).optional().describe('A "What\'s new" modal that blocks clicks, on load or 1.5 s after'),
  moveButtons: z.boolean().optional().describe("Submit buttons move and get random ids on every render"),
  renameLabels: z.boolean().optional().describe('Same features, different wording (e.g. "Owner" becomes "Account rep")'),
  slowApiMs: z.number().int().min(0).max(15000).optional().describe("Extra latency on every save"),
  failNextSaves: z.number().int().min(0).max(5).optional().describe("Fail the next N lead creations with a 500"),
};

export function createLiveDemoMcp(opts: LiveDemoMcpOptions = {}): LiveDemoMcp {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[livedemo] ${m}\n`));
  const headless = opts.headless ?? false;
  let crm: CrmServer | null = null;
  let crmUrl = opts.crmUrl ?? null;
  let browser: BrowserSession | null = null;
  let executor: ToolExecutor | null = null;
  let starting: Promise<void> | null = null;

  const server = new McpServer(
    { name: "livedemo", title: "LiveDemo: Pipewise CRM browser", version: "0.1.0" },
    {
      instructions: `This server drives a real browser showing Pipewise, a demo CRM with synthetic data. Use it to give a live product demo or to practise one.
Every action returns the page state afterwards: read it to confirm what happened before you say it worked, and use element refs only from the most recent state.
Deleting data needs the person's explicit approval: call request_approval before the final Delete confirmation. Use the run_demo prompt for a full solutions-engineer persona.`,
    },
  );

  async function ensureCrm(): Promise<string> {
    if (crmUrl) return crmUrl;
    crm = await startCrm(opts.crmPort ?? 4100).catch(() => startCrm(0)); // fall back to any free port
    crmUrl = crm.url;
    log(`Pipewise CRM running at ${crmUrl}`);
    return crmUrl;
  }

  /** Starts the CRM and browser on first use, and relaunches the browser if someone closed it. */
  async function ready(): Promise<ToolExecutor> {
    if (browser?.isOpen && executor) return executor;
    starting ??= (async () => {
      const base = await ensureCrm();
      await browser?.close().catch(() => {});
      browser = await BrowserSession.launch({ baseUrl: `${base}/`, headless, humanize: opts.humanize ?? !headless });
      executor = new ToolExecutor({ browser, say: () => {}, askApproval });
      log(`browser ${headless ? "started (headless)" : "window opened"}`);
    })().finally(() => {
      starting = null;
    });
    await starting;
    return executor!;
  }

  /** Asks the human in the client's UI (MCP elicitation). Null if the client can't ask. */
  async function askApproval(question: string): Promise<string | null> {
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    const res = await server.server.elicitInput({
      message: question,
      requestedSchema: {
        type: "object",
        properties: { approve: { type: "boolean", title: "Approve", description: "Allow this action in the demo app" } },
        required: ["approve"],
      },
    });
    return res.action === "accept" && res.content?.approve === true ? "yes" : "no";
  }

  function toResult(o: ToolOutcome): CallToolResult {
    const content: CallToolResult["content"] =
      typeof o.content === "string"
        ? [{ type: "text", text: o.content }]
        : (o.content ?? []).flatMap((c): CallToolResult["content"] =>
            c.type === "text"
              ? [{ type: "text" as const, text: c.text }]
              : c.type === "image" && c.source.type === "base64"
                ? [{ type: "image" as const, data: c.source.data, mimeType: c.source.media_type }]
                : [],
          );
    return { content, isError: !o.ok || undefined };
  }

  const run = (name: string) => async (input: Record<string, unknown>) => toResult(await (await ready()).run(name, input));
  const browserTool = (name: string, title: string, description: string, inputSchema: z.ZodRawShape, annotations: { readOnlyHint?: boolean; idempotentHint?: boolean } = {}) =>
    server.registerTool(name, { title, description, inputSchema, annotations: { openWorldHint: false, destructiveHint: false, ...annotations } }, run(name));

  browserTool("observe", "Read the page", "Read the current page: URL, open dialogs, notifications, and interactive elements with refs. Opens the browser if needed.", {}, {
    readOnlyHint: true,
  });
  browserTool("screenshot", "Take a screenshot", "See the screen as an image. Use when the page-state text isn't enough.", {}, { readOnlyHint: true });
  browserTool("click", "Click", "Click an element by ref. Returns the page state afterwards. Destructive confirmations are blocked until request_approval succeeds.", { ref });
  browserTool("type_text", "Type into a field", "Replace the contents of a text, email, number, or date field (dates as YYYY-MM-DD). Returns the page state afterwards.", {
    ref,
    text: z.string(),
  });
  browserTool("select_option", "Choose from a dropdown", "Choose an option in a dropdown by its visible label. Returns the page state afterwards.", {
    ref,
    option: z.string(),
  });
  browserTool("press_key", "Press a key", "Press a keyboard key, e.g. Enter or Escape.", { key: z.string() });
  browserTool("navigate", "Go to a page", "Go to a path inside Pipewise, e.g. /, /leads, /leads/new, /leads/3/activity. Other sites are blocked.", { path: z.string() }, {
    idempotentHint: true,
  });
  browserTool("wait", "Wait", "Wait up to 10 seconds, optionally until some text appears. Use when something shows Saving… or is loading.", {
    seconds: z.number().min(0).max(10),
    for_text: z.string().optional(),
  }, { readOnlyHint: true });

  server.registerTool(
    "request_approval",
    {
      title: "Ask the person to approve",
      description:
        "Ask the person watching to approve a consequential action (like deleting a record). Shows them a yes/no prompt and waits. One approval allows one consequential click.",
      inputSchema: { question: z.string().describe("What you're about to do, in plain words, e.g. 'Delete Grace Kim's lead? This can't be undone.'") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ question }) => {
      const ex = await ready();
      if (!server.server.getClientCapabilities()?.elicitation) {
        return {
          content: [
            {
              type: "text",
              text: "This MCP client can't show the person an approval prompt. Ask them in the conversation, and if they clearly say yes, call record_user_approval with their exact words.",
            },
          ],
        };
      }
      return toResult(await ex.run("request_approval", { question }));
    },
  );

  server.registerTool(
    "record_user_approval",
    {
      title: "Record the person's approval",
      description:
        "Fallback for clients without approval prompts: record that the person approved one consequential action, quoting exactly what they said. Only call this after they clearly said yes.",
      inputSchema: { user_said: z.string().describe("The person's words, verbatim") },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ user_said }) => {
      const granted = (await ready()).grantApproval(user_said);
      return {
        content: [{ type: "text", text: granted ? "Approval recorded for one consequential action." : `"${user_said}" isn't a clear yes. Approval NOT recorded.` }],
        isError: !granted || undefined,
      };
    },
  );

  server.registerTool(
    "reset_demo",
    {
      title: "Reset the demo",
      description:
        "Restore Pipewise's demo data and optionally switch on faults to rehearse recovery: a blocking modal, moved buttons, reworded labels, slow or failing saves. Reloads the page.",
      inputSchema: FaultsSchema,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ failNextSaves, ...faults }) => {
      await ready();
      const chaos = { ...NO_CHAOS, ...faults, failNext: failNextSaves ? { createLead: failNextSaves } : {} };
      const res = await fetch(`${crmUrl}/__reset`, { method: "POST", body: JSON.stringify(chaos) });
      if (!res.ok) return { content: [{ type: "text", text: `Reset failed (${res.status}).` }], isError: true };
      const active = Object.entries(chaos).filter(([, v]) => v && v !== "off" && !(typeof v === "object" && !Object.keys(v).length));
      const observed = await (await ready()).run("navigate", { path: "/" });
      return {
        content: [
          { type: "text", text: `Demo data reset.${active.length ? ` Faults on: ${active.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}.` : " No faults."}` },
          ...toResult(observed).content,
        ],
      };
    },
  );

  server.registerResource(
    "crm-state",
    "pipewise://state",
    { title: "Pipewise data", description: "Every lead, owner, follow-up, and activity in the demo CRM, as JSON.", mimeType: "application/json" },
    async (uri) => {
      const base = await ensureCrm();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: await (await fetch(`${base}/api/state`)).text() }] };
    },
  );

  server.registerPrompt(
    "run_demo",
    {
      title: "Run a Pipewise demo",
      description: "Become a solutions engineer giving a live Pipewise demo in the browser.",
      argsSchema: { buyer: z.string().optional().describe("Who you're demoing to, e.g. 'VP Sales at a 40-rep logistics company'") },
    },
    ({ buyer }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You're a solutions engineer giving a live demo of Pipewise CRM${buyer ? ` to ${buyer}` : ""}, using the livedemo browser tools. I'm the buyer, watching your screen.

Today is ${TODAY}. Start by observing the page, greet me in a sentence, and ask what I'd like to see.

- Keep replies short and conversational. Say what you're about to show, do it, then tell me what I'm looking at.
- Each action returns the page state. Confirm things worked before saying they did. If a dialog blocks a click, close it. If a save fails or times out, check whether it went through before retrying; never create duplicates.
- If I change my mind mid-task, keep what's still valid and fix only what conflicts. Don't start over.
- If a request matches more than one record, or names someone who doesn't exist, ask me.
- Before deleting anything, call request_approval.
- Answer pricing, integration, and policy questions only from these facts; otherwise say you'll follow up:
${PRODUCT_FACTS}`,
          },
        },
      ],
    }),
  );

  return {
    server,
    async close() {
      await browser?.close().catch(() => {});
      await crm?.close();
      await server.close();
    },
  };
}
