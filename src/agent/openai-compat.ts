import type Anthropic from "@anthropic-ai/sdk";
import type { ModelCallbacks, ModelClient, ModelRequest } from "./model.js";

// Adapter for any OpenAI-compatible chat endpoint (Ollama, Groq, Cerebras, OpenRouter, LM Studio,
// vLLM), so open models can run the same agent and the same evals. The agent keeps one message
// format (Anthropic's); this translates on the way out and back.

type OaiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider-specific data that must be echoed back, e.g. Gemini's thought signatures. */
  extra_content?: unknown;
}
interface OaiResponse {
  model: string;
  choices: { message: { content: string | null; tool_calls?: OaiToolCall[] }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export interface OpenAICompatOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Sent as reasoning_effort; providers without reasoning controls ignore it. */
  effort?: "low" | "medium" | "high";
}

export class OpenAICompatModel implements ModelClient {
  readonly model: string;
  /** extra_content per tool call id, replayed on later requests (Gemini 3 rejects tool calls without it). */
  private extras = new Map<string, unknown>();

  constructor(private opts: OpenAICompatOptions) {
    this.model = opts.model;
  }

  async create(req: ModelRequest, signal: AbortSignal, cb: ModelCallbacks = {}): Promise<Anthropic.Beta.BetaMessage> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages: toOpenAI(req, this.extras),
      tools: req.tools.flatMap((t) =>
        "input_schema" in t ? [{ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }] : [],
      ),
      tool_choice: "auto",
      ...(this.opts.effort ? { reasoning_effort: this.opts.effort } : {}),
    });
    let res: Response;
    // Free tiers return 429/503 under load; retry with backoff like the Anthropic SDK does.
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body,
      });
      if (res.ok || attempt >= MAX_RETRIES || !(res.status === 429 || res.status >= 500)) break;
      // A per-day quota won't clear in seconds; fail now instead of backing off.
      const errText = await res.clone().text();
      if (res.status === 429 && /per ?day/i.test(errText)) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt, signal);
    }
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 && /per ?day/i.test(errText)) {
        const wait = errText.match(/retry in ((?:\d+h)?(?:\d+m)?)/i)?.[1];
        throw new Error(`429 per-day quota exhausted for ${this.opts.model}${wait ? `; resets in about ${wait}` : ""}.`);
      }
      throw new Error(`${this.opts.baseUrl} returned ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as OaiResponse;
    for (const call of data.choices[0]?.message.tool_calls ?? []) if (call.extra_content) this.extras.set(call.id, call.extra_content);
    const message = fromOpenAI(data);
    for (const block of message.content) cb.onBlock?.(block);
    return message;
  }
}

const MAX_RETRIES = 5;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

function textOf(content: Anthropic.Beta.BetaToolResultBlockParam["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type} omitted]`)).join("\n");
}

export function toOpenAI(req: ModelRequest, extras: Map<string, unknown> = new Map()): OaiMessage[] {
  const out: OaiMessage[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : (m.content ?? []);
    if (m.role === "assistant") {
      const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const calls = blocks.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) }, ...(extras.has(b.id) ? { extra_content: extras.get(b.id) } : {}) }]
          : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must directly follow the assistant turn that called them; text goes after.
    for (const b of blocks) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERROR: " : "") + textOf(b.content) });
    const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

export function fromOpenAI(r: OaiResponse): Anthropic.Beta.BetaMessage {
  const choice = r.choices[0];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  if (choice.message.content?.trim()) content.push({ type: "text", text: choice.message.content, citations: null } as Anthropic.Beta.BetaTextBlock);
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = { __unparseable: call.function.arguments };
    }
    content.push({ type: "tool_use", id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: call.function.name, input } as Anthropic.Beta.BetaToolUseBlock);
  }
  const usage = {
    input_tokens: (r.usage?.prompt_tokens ?? 0) - (r.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    output_tokens: r.usage?.completion_tokens ?? 0,
    cache_read_input_tokens: r.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  } as Anthropic.Beta.BetaUsage;
  return {
    id: `oai_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: r.model,
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Beta.BetaMessage;
}
