import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ActionError, type BrowserSession } from "../browser/session.js";

const ref = { type: "string", description: "Element ref from the latest page state, e.g. e12" } as const;

function tool(name: string, description: string, properties: Record<string, object> = {}, required = Object.keys(properties)): Anthropic.Beta.BetaTool {
  return { name, description, strict: true, input_schema: { type: "object", properties, required, additionalProperties: false } };
}

export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = [
  tool("say", "Speak to the buyer. Keep it to one or two short spoken sentences.", { text: { type: "string" } }),
  tool("observe", "Read the current page: URL, open dialogs, notifications, and interactive elements with refs."),
  tool("click", "Click an element. Returns the page state afterwards.", { ref }),
  tool("type_text", "Replace the contents of a text, email, number, or date field (dates as YYYY-MM-DD). Returns the page state afterwards.", {
    ref,
    text: { type: "string" },
  }),
  tool("select_option", "Choose an option in a dropdown by its visible label. Returns the page state afterwards.", {
    ref,
    option: { type: "string" },
  }),
  tool("press_key", "Press a keyboard key, e.g. Enter or Escape.", { key: { type: "string" } }),
  tool("navigate", "Go to a path inside the demo app, e.g. /leads or /leads/3/activity.", { path: { type: "string" } }),
  tool(
    "wait",
    "Wait for the page, optionally until some text appears. Use when something is loading or saving.",
    { seconds: { type: "number", description: "Up to 10" }, for_text: { type: "string" } },
    ["seconds"],
  ),
  tool("screenshot", "See the screen as an image. Use only when the page state text isn't enough."),
  tool(
    "request_approval",
    "Ask the buyer to approve a consequential action (like deleting a record) and wait for their answer. The question is spoken aloud.",
    { question: { type: "string" } },
  ),
];

const Inputs = {
  say: z.object({ text: z.string().min(1) }),
  observe: z.object({}),
  click: z.object({ ref: z.string() }),
  type_text: z.object({ ref: z.string(), text: z.string() }),
  select_option: z.object({ ref: z.string(), option: z.string() }),
  press_key: z.object({ key: z.string() }),
  navigate: z.object({ path: z.string() }),
  wait: z.object({ seconds: z.number(), for_text: z.string().optional() }),
  screenshot: z.object({}),
  request_approval: z.object({ question: z.string().min(1) }),
};
export type ToolName = keyof typeof Inputs;

export const BROWSER_ACTIONS: ReadonlySet<string> = new Set(["click", "type_text", "select_option", "press_key", "navigate"]);

/**
 * A fault the eval harness injects into a tool call, to test recovery. "timeout_after_effect" is the
 * nasty one: the action really happened, but the agent is told it timed out.
 */
export interface ToolFault {
  tool: ToolName;
  /** Only fire when the target element's text matches (click/type/select). */
  elementText?: RegExp;
  kind: "timeout_after_effect" | "timeout_before_effect";
  times?: number;
}

export interface ToolOutcome {
  ok: boolean;
  content: Anthropic.Beta.BetaToolResultBlockParam["content"];
  /** Short text for logs and traces. */
  summary: string;
  injected?: boolean;
}

export interface ToolHost {
  browser: BrowserSession;
  /** Speak to the buyer. */
  say(text: string): void;
  /** Speak the question, then wait for the buyer's reply (null if they never answer). */
  askApproval(question: string): Promise<string | null>;
}

const TOOL_TIMEOUT_MS = 20_000;
const APPROVAL = /^\s*(y|yes|yeah|yep|sure|ok|okay|go ahead|do it|please do|confirm(ed)?|approved?|absolutely|delete it)\b/i;

export class ToolExecutor {
  private approvalTokens = 0;
  private faults: (ToolFault & { left: number })[];

  constructor(
    private host: ToolHost,
    faults: ToolFault[] = [],
  ) {
    this.faults = faults.map((f) => ({ ...f, left: f.times ?? 1 }));
  }

  async run(name: string, rawInput: unknown): Promise<ToolOutcome> {
    if (!(name in Inputs)) return fail(`Unknown tool ${name}.`);
    const parsed = Inputs[name as ToolName].safeParse(rawInput);
    if (!parsed.success) return fail(`Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const input = parsed.data as Record<string, string & number>;
    try {
      return await withTimeout(this.dispatch(name as ToolName, input), TOOL_TIMEOUT_MS, name);
    } catch (err) {
      if (err instanceof ActionError) {
        const msg = err.message.includes("URL: ") ? err.message : `${err.message}\n\nCurrent page:\n${await this.host.browser.observe().catch(() => "(unavailable)")}`;
        return fail(msg);
      }
      if (err instanceof ToolTimeout) return fail(err.message);
      throw err;
    }
  }

  private async dispatch(name: ToolName, input: Record<string, string & number>): Promise<ToolOutcome> {
    const b = this.host.browser;
    switch (name) {
      case "say":
        this.host.say(input.text);
        return ok("(said)");
      case "observe":
        return ok(await b.observe());
      case "screenshot":
        return {
          ok: true,
          summary: "screenshot",
          content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await b.screenshot() } }],
        };
      case "request_approval": {
        const reply = await this.host.askApproval(input.question);
        if (reply === null) return ok("The buyer did not answer. Approval NOT granted.");
        const granted = APPROVAL.test(reply);
        if (granted) this.approvalTokens = 1;
        return ok(`Buyer replied: "${reply}". ${granted ? "Approval granted for one consequential action." : "Approval NOT granted. Do not proceed."}`);
      }
      case "click": {
        const target = await b.describeRef(input.ref);
        if (target?.consequential) {
          if (this.approvalTokens < 1) {
            throw new ActionError(
              `Blocked: "${target.text}" is a consequential action (${target.consequential}). Call request_approval and get a clear yes from the buyer first.`,
            );
          }
          this.approvalTokens = 0;
        }
        return this.browserAction(name, target?.text, () => b.click(input.ref));
      }
      case "type_text":
        return this.browserAction(name, await this.labelOf(input.ref), () => b.fill(input.ref, input.text));
      case "select_option":
        return this.browserAction(name, await this.labelOf(input.ref), () => b.select(input.ref, input.option));
      case "press_key":
        return this.browserAction(name, undefined, () => b.press(input.key));
      case "navigate":
        return this.browserAction(name, undefined, () => b.navigate(input.path));
      case "wait":
        return ok(await b.wait(input.seconds, input.for_text || undefined));
    }
  }

  private async labelOf(ref: string): Promise<string | undefined> {
    return (await this.host.browser.describeRef(ref))?.text;
  }

  private async browserAction(name: ToolName, elementText: string | undefined, act: () => Promise<string>): Promise<ToolOutcome> {
    const fault = this.faults.find((f) => f.left > 0 && f.tool === name && (!f.elementText || (elementText && f.elementText.test(elementText))));
    if (fault) {
      fault.left--;
      if (fault.kind === "timeout_after_effect") await act().catch(() => {});
      return { ...fail(`Timed out after ${TOOL_TIMEOUT_MS / 1000}s waiting for the browser to respond. The action may or may not have gone through.`), injected: true };
    }
    return ok(await act());
  }
}

class ToolTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ToolTimeout(`${name} timed out after ${ms / 1000}s. Check the page state before retrying.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function ok(text: string): ToolOutcome {
  return { ok: true, content: text, summary: text.split("\n")[0].slice(0, 120) };
}

function fail(text: string): ToolOutcome {
  return { ok: false, content: text, summary: text.split("\n")[0].slice(0, 160) };
}
