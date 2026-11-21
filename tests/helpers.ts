import type Anthropic from "@anthropic-ai/sdk";
import type { ModelCallbacks, ModelClient, ModelRequest } from "../src/agent/model.js";

type Block = Anthropic.Beta.BetaContentBlock;

export interface PolicyCtx {
  call: number;
  /** All text the agent was just given: buyer lines and tool results. */
  input: string;
  /** The most recent page state in the conversation. */
  page: string;
}

/** A stand-in for the LLM: a function from what the agent just saw to its next tool calls. */
export class ScriptedModel implements ModelClient {
  readonly model = "scripted";
  calls = 0;

  constructor(
    private policy: (ctx: PolicyCtx) => Block[],
    private delayMs = 0,
  ) {}

  async create(req: ModelRequest, signal: AbortSignal, cb: ModelCallbacks = {}): Promise<Anthropic.Beta.BetaMessage> {
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }
    const texts = req.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content ?? []).flatMap(textOfBlock)));
    const last = req.messages[req.messages.length - 1];
    const input = (typeof last.content === "string" ? [last.content] : (last.content ?? []).flatMap(textOfBlock)).join("\n");
    const page = [...texts].reverse().find((t) => t.includes("Interactive elements:")) ?? "";
    const content = this.policy({ call: this.calls++, input, page });
    for (const b of content) cb.onBlock?.(b);
    return {
      id: `msg_${this.calls}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

function textOfBlock(b: Anthropic.Beta.BetaContentBlockParam): string[] {
  if (b.type === "text") return [b.text];
  if (b.type === "tool_result") return typeof b.content === "string" ? [b.content] : (b.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : []));
  return [];
}

let id = 0;
export const use = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `tu_${++id}`, name, input }) as Block;
export const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;

/** Find an element ref in a page state by its role/label line. */
export function refFor(page: string, label: RegExp): string {
  const line = page.split("\n").find((l) => /^\s*\[e\d+\]/.test(l) && label.test(l));
  if (!line) throw new Error(`No element matching ${label} in:\n${page}`);
  return line.match(/\[(e\d+)\]/)![1];
}
