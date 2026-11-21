# LiveDemo Agent

An AI solutions engineer that demos a SaaS product in a real browser while talking to a buyer, and keeps its footing when the buyer interrupts, changes their mind, or the UI misbehaves.

> "Can you show me how to create a lead, assign it to a salesperson, and set up a follow-up?"
>
> *(agent starts filling in the form)*
>
> "Actually, assign it to Sarah instead. And can you show me the activity history?"

A scripted Playwright test can't handle that second line. This agent reads the live page, notices it has already assigned Marcus, fixes the assignment instead of starting over, and then goes to the activity tab. The repo also includes the **eval suite that measures whether it actually does that**: 21 scenarios covering interruptions, moved buttons, surprise modals, slow saves, server errors, ambiguous requests, and a click that times out *after* it already went through.

## What's in here

| Piece | What it does |
|---|---|
| **Pipewise CRM** (`src/crm`) | A small sample CRM (leads, owners, stages, follow-ups, activity history, dashboard) with a fault-injection switchboard: blocking modals, moved buttons with random ids, reworded labels, slow and failing writes. |
| **Browser layer** (`src/browser`) | Playwright with an accessibility-style page snapshot. Interactive elements get refs (`e12`) that are valid for one document only, so a stale ref after a navigation is an explicit error, never a misclick. Every action returns the page state afterwards, so the agent verifies instead of assuming. Network access is limited to the demo app. |
| **Agent** (`src/agent`) | A tool-use loop on Claude (`say`, `observe`, `click`, `type_text`, `select_option`, `navigate`, `wait`, `screenshot`, `request_approval`). Narration streams out as soon as each `say` call finishes. Model is pluggable: Claude or any OpenAI-compatible endpoint (Ollama, Groq, Cerebras, OpenRouter). |
| **Eval harness** (`src/eval`) | A simulated buyer that interrupts on triggers ("right after the agent picks Marcus"), answers approval questions, and replies to clarifying questions. Grading is done against the CRM's real state plus the transcript. |

## How interruptions work

Buyer speech can arrive at any moment and goes into a queue (`BuyerChannel`). Three things happen depending on when it lands:

1. **While the model is thinking:** the in-flight request is aborted, and the next request carries both the earlier context and the new words. The agent never acts on a plan the buyer has already overruled. If the agent had already started speaking, it's told the buyer cut in.
2. **While the agent is mid-way through a batch of browser actions:** the remaining queued actions are skipped and reported back as "not run: the buyer interrupted", so the model re-plans from where the app actually is.
3. **While the agent is waiting:** it's a normal turn.

The conversation history is append-only (thinking blocks stay valid, and the prompt cache keeps hitting).

## Safety rails that are enforced in code, not just prompted

- **Consequential actions need approval.** Elements marked `data-consequential` (the final "Delete" confirmation) can't be clicked until `request_approval` gets a clear yes from the buyer. Each approval is good for one action. Asking with `say` doesn't count.
- **The browser can't leave the demo app.** Other origins are blocked at the network layer.
- **Stale element refs fail loudly.** A ref from a previous page is rejected along with the current page state, so the agent never clicks the wrong thing.

## Eval suite

```
npm run eval                                  # all 21 scenarios, Claude Opus 5.5
npm run eval -- --only interrupt-reassign --headed
npm run eval -- --concurrency 4 --repeat 3    # parallel workers, 3 trials each
npm run eval -- --model groq:openai/gpt-oss-120b --tag oss
npm run compare                               # table of every run in ./runs
```

| Category | Scenarios |
|---|---|
| Happy path | create a lead · create + assign + follow-up · find a lead, change stage, add follow-up |
| Interruption | reassign to Sarah + show activity mid-task · cancel before saving · correct a typed email · two interruptions in a row |
| UI change | buttons moved with random ids · labels reworded · modal on load · modal pops up mid-form |
| Failure | 4.5 s saves · first save returns 500 · save click times out *after* it went through · owner assignment fails once |
| Judgment | delete after approval · buyer refuses a delete · two leads match, so ask which one · buyer names a rep who doesn't exist |
| Conversation | off-topic pricing/Slack question mid-task · answer a number from the dashboard |

Each run writes `runs/<timestamp>-<tag>/` with `report.md`, `summary.json`, and per-scenario `trace.jsonl` (plus a `.webm` with `--video`). It reports:

- **Task completion:** every check passes on the CRM's final state.
- **Browser action success:** injected faults excluded.
- **Recovery rate:** of the scenarios where any action failed, the share that still passed.
- **Time to first speech and to first browser action:** measured from when the buyer spoke, p50 and p95.
- **Tokens and cost per demo**, and the number of model calls.
- **Interruptions that landed mid-task vs. after the agent had finished**, so a "pass" on an interruption scenario means the agent was actually interrupted.

Each run is tagged with the prompt version (`PROMPT_VERSION`), model, effort, and git SHA, so regressions show up in `npm run compare`.

### Is the eval measuring the right thing?

`tests/e2e.test.ts` runs scripted agents through the real CRM, browser, and grader. A well-behaved one passes; a badly behaved one must fail. For example, an agent that blindly retries after the "timed out but actually saved" fault creates a duplicate lead, and the suite catches it. Those tests run without any API key:

```
npm test
```

## Quickstart

Needs Node 20+.

```
npm install
npx playwright install chromium
export ANTHROPIC_API_KEY=...
npm run demo            # visible browser; type as the buyer, type again mid-task to interrupt
npm run demo -- --voice # the agent also speaks (macOS `say`); typing cuts it off
```

`npm run crm` runs only the sample CRM on http://127.0.0.1:4100.

### Open models

Keys can live in a gitignored `.env` file in the repo root; the CLIs load it automatically.

Any OpenAI-compatible endpoint works through `--model <provider>:<model>`:

| Provider | Example | Key |
|---|---|---|
| Ollama (local) | `ollama:qwen3:8b` | none |
| LM Studio (local) | `lmstudio:<model>` | none |
| Groq | `groq:openai/gpt-oss-120b` | `GROQ_API_KEY` |
| Cerebras | `cerebras:<model>` | `CEREBRAS_API_KEY` |
| OpenRouter | `openrouter:<model>` | `OPENROUTER_API_KEY` |
| Google Gemini | `gemini:gemini-3.5-flash` | `GEMINI_API_KEY` (free tier from AI Studio) |

A demo is 20 to 40 model calls with a 10K to 40K-token context, and the model has to manage many tool calls in a row and re-plan after interruptions. Small local models run it slowly and less reliably. The eval suite is how you find out by how much.

## Layout

```
src/crm/        sample CRM: data, pages, fault injection
src/browser/    Playwright session + page snapshot
src/agent/      agent loop, tools, prompt, model clients
src/eval/       scenarios, runner (simulated buyer), report
src/cli/        demo, eval, compare, crm
tests/          end-to-end harness tests with scripted agents
```

## Roadmap

1. **Real-time voice:** LiveKit Agents for STT/TTS and barge-in. The agent already takes buyer input as an event stream and emits speech as events, so voice is a new adapter around `BuyerChannel` and the `say` events, not a rewrite.
2. **Screen share into a meeting:** publish the browser as a LiveKit video track, then a supported meeting integration (Google Meet later).
3. **Follow-up after the call:** summarize the transcript and CRM changes into a recap email for approval.
4. **Eval depth:** an LLM-simulated buyer for open-ended conversations, a judge for answer quality, and production-call replay.
