import Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest {
  system: string;
  tools: Anthropic.Beta.BetaToolUnion[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface ModelCallbacks {
  /** Fires as soon as one content block finishes streaming, before the whole response is done. */
  onBlock?: (block: Anthropic.Beta.BetaContentBlock) => void;
}

/** The agent talks to the model only through this, so tests can substitute a scripted model. */
export interface ModelClient {
  readonly model: string;
  create(req: ModelRequest, signal: AbortSignal, cb?: ModelCallbacks): Promise<Anthropic.Beta.BetaMessage>;
}

export class AnthropicModel implements ModelClient {
  private client = new Anthropic();

  constructor(
    readonly model = "claude-opus-5-5",
    private effort: Effort = "medium",
  ) {}

  async create(req: ModelRequest, signal: AbortSignal, cb: ModelCallbacks = {}): Promise<Anthropic.Beta.BetaMessage> {
    // Streaming lets narration reach the buyer as soon as its say call is complete, instead of
    // after the model has also written out every browser action in the same turn.
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16000,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        output_config: { effort: this.effort },
        cache_control: { type: "ephemeral" },
        // If a safety classifier declines a turn, the API retries it on a fallback model instead of stopping the demo.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    if (cb.onBlock) stream.on("contentBlock", cb.onBlock);
    return stream.finalMessage();
  }
}

// USD per million tokens: [input, output, cache read]. Cache writes (5 min TTL) bill at 1.25x input.
const PRICES: Record<string, [number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

/** Cost of one call. Models without a known price (local or free-tier open models) count as $0. */
export function costUsd(model: string, usage: Anthropic.Beta.BetaUsage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const [inp, out, read] = price;
  const write = usage.cache_creation_input_tokens ?? 0;
  return (
    (usage.input_tokens * inp + write * inp * 1.25 + (usage.cache_read_input_tokens ?? 0) * read + usage.output_tokens * out) / 1_000_000
  );
}
