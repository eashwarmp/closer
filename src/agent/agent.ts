import type Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "node:events";
import type { BrowserSession } from "../browser/session.js";
import type { BuyerChannel } from "./buyer.js";
import type { ModelClient } from "./model.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { BROWSER_ACTIONS, TOOL_DEFS, ToolExecutor, type ToolFault } from "./tools.js";

export type AgentEvent =
  | { type: "buyer"; text: string; interrupting: boolean }
  | { type: "say"; text: string }
  | { type: "llm"; ms: number; model: string; usage: Anthropic.Beta.BetaUsage | null; stopReason: string | null; aborted: boolean }
  | { type: "tool"; name: string; input: unknown; ok: boolean; ms: number; summary: string; injected: boolean; skipped: boolean }
  | { type: "approval"; question: string; reply: string | null }
  | { type: "turn_end" }
  | { type: "error"; message: string };

export type TimedEvent = AgentEvent & { t: number };

export interface AgentOptions {
  model: ModelClient;
  browser: BrowserSession;
  buyer: BuyerChannel;
  faults?: ToolFault[];
  /** Abort an in-flight model call when the buyer speaks, so the reply reflects what they just said. */
  preempt?: boolean;
  maxModelCallsPerTurn?: number;
  approvalTimeoutMs?: number;
  system?: string;
}

type Block = Anthropic.Beta.BetaContentBlockParam;

/**
 * Runs the demo conversation. The loop is: read buyer input, call the model, execute its tool calls,
 * feed results back. Buyer input can arrive at any point and is folded into the next model call;
 * browser steps the model queued before the interruption are skipped, not run.
 */
export class DemoAgent extends EventEmitter {
  readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
  private tools: ToolExecutor;
  private stopped = false;
  /** Between taking a request and finishing the turn. Buyer speech during this is an interruption. */
  private busy = false;
  private awaitingApproval = false;
  private abort: AbortController | null = null;
  private readonly start = Date.now();

  constructor(private opts: AgentOptions) {
    super();
    this.tools = new ToolExecutor(
      {
        browser: opts.browser,
        say: (text) => this.emitEvent({ type: "say", text }),
        askApproval: async (question) => {
          this.emitEvent({ type: "say", text: question });
          this.awaitingApproval = true;
          this.emitEvent({ type: "approval", question, reply: null });
          try {
            return await opts.buyer.next(opts.approvalTimeoutMs ?? 120_000);
          } finally {
            this.awaitingApproval = false;
          }
        },
      },
      opts.faults,
    );
    // Log speech when the buyer says it, not when the agent gets around to reading it, so latency is honest.
    opts.buyer.onPush((text) => {
      if (text !== null) this.emitEvent({ type: "buyer", text, interrupting: this.busy && !this.awaitingApproval });
    });
  }

  onEvent(listener: (e: TimedEvent) => void): this {
    return this.on("event", listener);
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.opts.buyer.close();
  }

  async run(): Promise<void> {
    const { buyer, model } = this.opts;
    let pending: Block[] = [];
    let calls = 0;

    while (!this.stopped) {
      const working = pending.some((b) => b.type === "tool_result");
      if (!working && buyer.pending === 0) {
        this.busy = false;
        const first = await buyer.next();
        if (first === null) break;
        pending.push(this.buyerBlock(first, false));
        calls = 0;
      }
      this.busy = true;
      for (const u of buyer.drain()) pending.push(this.buyerBlock(u, working));

      if (++calls > (this.opts.maxModelCallsPerTurn ?? 40)) {
        this.emitEvent({ type: "error", message: "Too many steps for one request; stopping this turn." });
        pending.push({ type: "text", text: "[System] Step limit reached. Stop and tell the buyer where things stand." });
        calls = 0;
      }

      const response = await this.callModel(pending);
      if (!response) {
        if (this.stopped) break;
        continue; // Preempted by the buyer: their words are drained into `pending` on the next pass.
      }
      this.messages.push({ role: "user", content: pending }, { role: "assistant", content: response.message.content });
      pending = [];

      if (response.message.stop_reason === "refusal") {
        this.emitEvent({ type: "error", message: `Model declined (${response.message.stop_details?.category ?? "unknown"})` });
      }
      const toolUses = response.message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        const text = response.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
        if (text) this.emitEvent({ type: "say", text });
        this.emitEvent({ type: "turn_end" });
        continue;
      }
      if (response.message.stop_reason === "max_tokens") {
        this.emitEvent({ type: "error", message: "Response hit max_tokens mid tool call." });
      }
      pending = await this.runTools(toolUses, response.spoken);
    }
  }

  private buyerBlock(text: string, interrupting: boolean): Block {
    return {
      type: "text",
      text: interrupting ? `[Buyer interrupts while you are working]: ${text}` : `[Buyer]: ${text}`,
    };
  }

  /** One model call. Returns null if the buyer interrupted it (preempt) or the agent stopped. */
  private async callModel(pending: Block[]): Promise<{ message: Anthropic.Beta.BetaMessage; spoken: Set<string> } | null> {
    const { model, buyer } = this.opts;
    const abort = (this.abort = new AbortController());
    const spoken = new Set<string>();
    const unsubscribe = this.opts.preempt === false ? () => {} : buyer.onPush(() => abort.abort());
    const t0 = Date.now();
    try {
      const message = await model.create(
        { system: this.opts.system ?? SYSTEM_PROMPT, tools: TOOL_DEFS, messages: [...this.messages, { role: "user", content: pending }] },
        abort.signal,
        {
          // Speak as soon as a say call has fully streamed, not after the whole turn.
          onBlock: (block) => {
            if (block.type === "tool_use" && block.name === "say" && typeof (block.input as { text?: unknown }).text === "string") {
              spoken.add(block.id);
              this.emitEvent({ type: "say", text: (block.input as { text: string }).text });
            }
          },
        },
      );
      this.emitEvent({ type: "llm", ms: Date.now() - t0, model: message.model, usage: message.usage, stopReason: message.stop_reason, aborted: false });
      return { message, spoken };
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      this.emitEvent({ type: "llm", ms: Date.now() - t0, model: model.model, usage: null, stopReason: null, aborted: true });
      if (spoken.size) {
        pending.push({ type: "text", text: "[System] You had already started speaking when the buyer cut in; they heard part of your last sentence." });
      }
      return null;
    } finally {
      unsubscribe();
      this.abort = null;
    }
  }

  private async runTools(toolUses: Anthropic.Beta.BetaToolUseBlock[], spoken: Set<string>): Promise<Block[]> {
    const results: Block[] = [];
    for (const use of toolUses) {
      const t0 = Date.now();
      // The buyer spoke mid-batch: don't keep clicking through a plan they may have just changed.
      if (this.opts.buyer.pending > 0 && BROWSER_ACTIONS.has(use.name)) {
        const summary = "Not run: the buyer interrupted before this step. Re-plan from their latest message.";
        results.push({ type: "tool_result", tool_use_id: use.id, content: summary });
        this.emitEvent({ type: "tool", name: use.name, input: use.input, ok: true, ms: 0, summary, injected: false, skipped: true });
        continue;
      }
      if (use.name === "say" && spoken.has(use.id)) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: "(said)" });
        continue;
      }
      const outcome = await this.tools.run(use.name, use.input);
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: !outcome.ok || undefined });
      if (use.name !== "say") {
        this.emitEvent({
          type: "tool",
          name: use.name,
          input: use.input,
          ok: outcome.ok,
          ms: Date.now() - t0,
          summary: outcome.summary,
          injected: !!outcome.injected,
          skipped: false,
        });
      }
    }
    return results;
  }

  private emitEvent(e: AgentEvent): void {
    this.emit("event", { ...e, t: Date.now() - this.start });
  }
}
