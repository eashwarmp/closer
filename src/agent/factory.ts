import { AnthropicModel, type Effort, type ModelClient } from "./model.js";
import { OpenAICompatModel } from "./openai-compat.js";

// OpenAI-compatible providers that serve open models. Free tiers exist for all of these; Ollama runs locally.
const PROVIDERS: Record<string, { baseUrl: string; keyEnv?: string }> = {
  ollama: { baseUrl: "http://localhost:11434/v1" },
  lmstudio: { baseUrl: "http://localhost:1234/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  // Gemini API's OpenAI-compatible endpoint. Keys come from Google AI Studio (free tier available).
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
};

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * "claude-opus-5-5" -> Anthropic API. "<provider>:<model>" -> that OpenAI-compatible provider,
 * e.g. "ollama:qwen3:4b" or "groq:openai/gpt-oss-120b". LIVEDEMO_BASE_URL overrides the provider URL.
 */
export function makeModel(spec = DEFAULT_MODEL, effort: Effort = "medium"): ModelClient {
  const i = spec.indexOf(":");
  const provider = i > 0 ? spec.slice(0, i) : "";
  if (!PROVIDERS[provider]) {
    if (!spec.startsWith("claude-")) throw new Error(`Unknown model "${spec}". Use a claude-* model or one of: ${Object.keys(PROVIDERS).map((p) => `${p}:<model>`).join(", ")}`);
    return new AnthropicModel(spec, effort);
  }
  const p = PROVIDERS[provider];
  const apiKey = p.keyEnv ? process.env[p.keyEnv] : undefined;
  if (p.keyEnv && !apiKey) throw new Error(`${provider} needs ${p.keyEnv} set in the environment.`);
  return new OpenAICompatModel({ baseUrl: process.env.LIVEDEMO_BASE_URL ?? p.baseUrl, model: spec.slice(i + 1), apiKey });
}
