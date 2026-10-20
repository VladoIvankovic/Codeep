# Model catalogue and maintenance policy

Last full review: **2026-10-14** (DeepSeek and MiniMax rechecked 2026-10-20)

## Product scope

- Actively maintain the CLI/TUI, macOS app, and codeep.dev.
- Keep iOS paused. Do not add iOS-only features, screens, provider work, or
  release chores unless real usage justifies restarting it.
- Prefer polish, reliability, and current model support over new surface area.

## Catalogue rules

1. Use an official provider model page, pricing page, lifecycle notice, or a
   provider-owned models API as the source of truth.
2. Add a model only when its exact API identifier, endpoint, context limit, and
   parameter behavior are verified.
3. When a provider names a replacement, remove the retired model from the
   picker and add an explicit stored-config migration. Historical pricing and
   context aliases may remain so old session exports still render correctly.
4. Keep subscription and pay-per-use catalogues separate. Never assume a
   general API model is accepted by a coding-plan exact-string allowlist.
5. Do not invent a price. If a provider does not publish one, show no estimate
   or clearly label a conservative approximation.
6. OpenRouter, ModelScope, and Ollama remain dynamic. Maintain only a small,
   current fallback list for the period before their live catalogue loads.

## Review cadence

- Check release notes and lifecycle pages monthly.
- Check immediately when a provider announces a flagship, replacement, price
  change, context change, or deprecation.
- Review resource-impact assumptions quarterly; these estimates should become
  narrower only when better public measurements exist.

## Update checklist

- Update the CLI catalogue and capability rules in
  `src/config/providers.ts`.
- **When a new id changes shape, grep every capability check for it.** Gates
  written as a prefix (`startsWith`, `hasPrefix`) or a substring (`contains`)
  silently miss a renamed family. It happened twice in one month: `gpt-6-astra`
  failed `startsWith('gpt-5')` and would have shipped with `/thinking` hidden;
  `deepseek-flash` failed `deepseek-v4` in three places, one of which sized its
  context window at 128K instead of 1M. Search `providers.ts`, `ModelTuning`,
  `CostEstimator` and `ContextWindowEstimator` for the old family name.
- **Check where a thinking model reports its thinking tokens.** They are billed
  as output, and a client that reads one count misses them if the provider
  reports them apart: Google's OpenAI-compat `usage` left 153 of 160 output
  tokens out of `completion_tokens` (only the gap in `total_tokens` showed
  them), and native `usageMetadata` carries `thoughtsTokenCount` beside
  `candidatesTokenCount` (see the Gemini 4 Argon entry). Read a real response
  before trusting the field names.
- Update CLI context/pricing in `src/utils/tokenTracker.ts`, including the
  cache-read and cache-write rates (model, surface and provider tables).
  The context table is read by exact id, then by canonical id (macOS
  `ContextWindowEstimator` canonicalizes too, then matches by substring), so
  OpenRouter's `vendor/dotted.id` finds the vendor row. Add an exact OpenRouter row only where OpenRouter's
  `context_length` is smaller than the vendor's (`openai/gpt-5.5`); dated
  snapshots such as `…-0813` match nothing and keep the 128K default.
  A model priced by prompt length gets a `longPrompt` tier on its own pricing
  row (Claude Haiku 5.5, below, is the first to have one); the cost maths, the cache
  savings, `/cost`, `/stats` and the catalogue export all read it from there.
- Add an exact migration for removed stored ids to `RETIRED_MODEL_REPLACEMENTS`
  in `src/config/providers.ts`, and the same entry to macOS
  `AppState.retiredModelReplacements`. Both are one flat lookup that never
  chains.
  - The CLI applies it on **every** load (`src/config/index.ts`). Until
    2026-09-23 it ran only below `migrationVersion` 4, and every config since
    2026-08-15 records 4, so the GPT-5.5/5.4, Grok, DeepSeek and Gemini entries
    never reached an existing user's active model; only fresh installs and
    profile loads saw them. `startupMigration.test.ts` loads the module over a
    real config file to hold that. `/rewind` (TUI and ACP) and an editor's
    pinned `providerId/modelId` (ACP `applyConfigOption`) go through it too, so
    neither puts a retired id back on the running process.
  - macOS applies it wherever a saved model is restored (`resolvedModel`,
    `migratedModel`), except on the dynamic catalogues, which `resolvedModel`
    returns untouched (see ModelScope under the Qwen entry below).
  - A source must NOT be a model the provider offers: the map runs on every
    load, so an entry for an offered id undoes the user's pick at each launch.
    `providers.test.ts` checks it. (GPT-6 Astra's entry went for this reason
    when it was offered again on 2026-09-26.)
  - A target must be a model the same provider offers, which
    `providers.test.ts` and `ProviderChoiceTests` check. On a plan that means
    the plan's allowlist, not the vendor's named replacement: bare `qwen3-max`
    → `qwen3.7-plus` on the Coding Plans, because 3.7 Max is not on them.
  - Custom bots pinned to a migrated id (`model: openai/gpt-5.5`) resolve
    through the same map on both clients (CLI `exactModelPreference`, macOS
    `resolvePersonalityModelDeclaration`), so removing an id no longer makes
    those bots unavailable. An id that a curated provider neither offers nor
    migrates still does.
- **Check the fresh-install default** — `DEFAULT_PROVIDER` / `DEFAULT_MODEL` in
  `src/config/index.ts`. It stayed `glm-5.2` for a month after Z.AI's default
  moved to `glm-5.3`, and nothing failed because 5.2 still works.
  `index.test.ts` ('fresh-install defaults') now requires the default model to
  be the default provider's own `defaultModel`, so moving one without the other
  fails the suite.
- Mirror the catalogue, tuning, context, and pricing in
  `Codeep-macOS/Packages/CodeepCore`.
- Update the OpenRouter fallback in both clients.
- Update the public provider matrix in
  `Codeep-web/src/app/docs/providers/page.tsx`.
- Regenerate the site's model list — `npm run export:catalogue` in this repo.
  It writes `Codeep-web/src/data/catalogue.json` straight from `PROVIDERS`, the
  context table and the pricing table, so /docs/providers can only ever show
  what the client actually offers. Commit the JSON; the site must build without
  this repo present.
- Run:
  - `npm test`, `npx tsc --noEmit`, and `npm run build` in the root.
  - `swift test --package-path Packages/CodeepCore` plus a macOS Debug build.
  - `npm test`, `npm run typecheck`, `npm run typecheck:test`, and
    `npm run build` in `Codeep-web`.
- Verify a migrated config, a new install, model selection, one real response,
  `/cost`, `/stats`, Mac Usage, Mac Insights, and the web dashboard.

## Known pricing quirks

- **DeepSeek bills peak / off-peak** (off-peak is half; peak is 01:00–04:00 and
  06:00–10:00 UTC on weekdays, excluding Chinese public holidays — a clause the
  pricing page gained after 2026-09-17 with no changelog entry). `MODEL_PRICING`
  holds one rate per model, so it
  carries **peak** — an over-estimate, deliberately, per rule 5. Rows reviewed
  2026-09-11 had drifted two to four and a half times *below* peak, which is the
  wrong direction; re-read the table, don't trust the comment.
- **DeepSeek V4.1 Flash is `deepseek-flash`** on DeepSeek's API but
  `deepseek/deepseek-v4.1-flash` on OpenRouter.
- **`deepseek-flash` became V4.1-Flash-1017 on 2026-10-17** (changelog entry of
  that date; pricing page "MODEL VERSION"). Same id, same price, 1M context,
  384K output: "simply use `deepseek-flash` to access the latest model", so the
  CLI needed no catalogue or price change, only the picker description. **On
  OpenRouter the new snapshot is a separate id**, `deepseek/deepseek-v4.1-flash-1017`
  (canonical slug `…-20261017`, $0.30/$1.20, cache read $0.006, read 2026-10-20),
  while `deepseek/deepseek-v4.1-flash` stays the 2026-09-10 release. The
  fallback list keeps the undated id. OpenRouter's current price for the older
  one is far lower than DeepSeek's own ($0.056/$0.12), so do not copy that
  number into `MODEL_PRICING`.
- **DeepSeek V4 Pro was NOT phased out.** The 2026-09-10 news post announced
  routing `deepseek-v4-pro` to V4.1 Flash from 2026-09-14. DeepSeek reversed
  that on 2026-09-11, before the cutover: the changelog's 09-10 entry now says V4
  Pro service continues "with the billing method remaining unchanged". The news
  post was never corrected, and 3.3.0 migrated Pro users to Flash on the
  strength of it. Pro is back in the picker as `deepseek-v4-pro`
  (DeepSeek-V4-Pro-0813; peak $1.32/$3.96, cache hit $0.044; low/high/max
  effort) and the migration is gone. On OpenRouter the GA Pro is
  `deepseek/deepseek-v4-pro-0813`; `deepseek/deepseek-v4-pro` is the April 0423
  preview, which only third parties serve. **Read the changelog, not the news
  post.** Still no V4.1 Pro.
- **DeepSeek cache hits cost 2% of a miss** (V4.1 Flash: $0.006 against $0.30;
  V4 Pro was 1/30). The count arrives twice — nested as
  `prompt_tokens_details.cached_tokens` and top-level as
  `prompt_cache_hit_tokens` — and is read once. *Corrected 2026-09-14:* this note
  previously said the tracker could not read DeepSeek cache hits. It always
  could; the fault was the rate, which had no DeepSeek entry and fell back to
  0.1, billing cached tokens at five times their price. Checked against the raw
  API reference, not a summary of it — the summary had nested the fields wrongly.
- **DeepSeek's Anthropic-format endpoint** (`api.deepseek.com/anthropic`) does not
  document its `usage` object. `extractAnthropicUsage` assumes Anthropic's
  semantics there (input exclusive of cache reads); unverified. OpenAI format is
  the default protocol for DeepSeek.
- **GPT-5.6 Sol runs a promotional $4/$20** "at least through 2026-11-21" (list
  $5/$30). Long-context requests (over 272K input) bill at a higher tier: Sol
  $8/$30, Astra $20/$75, GPT-6 Sol and GPT-6.1 Sol $4/$15, GPT-6 Luna
  $0.20/$0.75. The table carries short-context only.
- **From GPT-5.6 on, OpenAI bills cache writes at 1.25× input** and reports them
  as `prompt_tokens_details.cache_write_tokens`, inside `prompt_tokens`
  (ordinary input = prompt − cached − written). The CLI reads the field in
  `extractOpenAIUsage` and prices it with `cacheWriteRateFor`; macOS reads it in
  `OpenAIProtocolClient` and prices it with `ModelPricing.cacheWriteRate` in
  `CostEstimator`. GPT-5.5, 5.4 and 5.4 mini have no write charge (1.0×). Kimi
  K3 reports writes in the same field, and its default 5-minute write costs the
  plain input rate (1.0×; the 1-hour TTL Codeep never asks for is 2×). Kimi's
  price table has a write column only for K3, so a K2.x write bills as plain
  input too: every Kimi surface writes at 1.0× in both clients. Before
  2026-09-23 neither client read the field, so written tokens billed as ordinary
  input (1.0×) and GPT estimates erred low.
- **GPT-6 agent turns go over the Responses API** (`POST /v1/responses`) since
  2026-09-26. On Chat Completions GPT-6 cannot reason and call tools at once:
  Sol and Luna support function calling "only with `reasoning_effort` set to
  `none`", and Astra does not support it at all ("Chat Completions does not
  support function calling with GPT-6 Astra"; already in its 2026-09-03 launch
  notes). The Responses transport (CLI `src/api/responses.ts`, stateless:
  `store: false`, `include: ["reasoning.encrypted_content"]`, every turn's
  output items replayed as returned) was verified live by the owner on
  **2026-09-26**, with their own key (`scripts/record-responses-fixture.mjs`;
  recordings in `src/utils/__fixtures__/responses/recorded`, key redacted,
  `encrypted_content` truncated):
  - GPT-6 Astra calls tools over Responses.
  - GPT-6 Sol at effort high calls tools, two in parallel in one response. The
    interim "tools force reasoning `none`" is not needed there.
  - (a) Replayed reasoning items, with `encrypted_content`, are **accepted**
    under `store: false` (Astra and Sol). Both reasoned first (17 and 24
    reasoning tokens), called `read_file` on the right file, and answered after
    the replay. OpenAI encrypts a reasoning item afresh for
    `output_item.added` (a shorter token), `output_item.done` and
    `response.completed`; the accepted replay used the `.done` one, which is
    what the parser keeps. Whether the other two would be accepted is untested.
  - (b) A follow-up **without** the reasoning items is accepted too (158 input
    tokens against 177 with them). Replay is not enforced; Codeep keeps
    replaying, as OpenAI's docs recommend.
  - (c) Astra's default effort is `medium`, with `reasoning.context:
    "all_turns"`, so `/thinking auto` runs it at medium.
  - (d) `usage` carries `input_tokens_details.cached_tokens`,
    `input_tokens_details.cache_write_tokens` and
    `output_tokens_details.reasoning_tokens` on every model. The recorded
    requests were too small for the cache, so the cache counts were 0: the
    cache-read and cache-write paths are pinned for presence only.

  What shipped on that basis:
  - The switch's shipped default is `auto` (CLI `DEFAULT_OPENAI_WIRE_API`,
    macOS `WireAPIPreference.shippedDefault`): `openai` catalogue models at the
    official base URL use `/v1/responses`. `chat` (config `openaiWireApi` or
    `CODEEP_OPENAI_WIRE_API` in the CLI) forces Chat Completions and stays for
    one release as the kill switch.
  - **Chat Completions remains for proxies.** An `OPENAI_BASE_URL` override
    (Azure, LiteLLM, …) stays on Chat Completions unless the switch forces
    `responses`, and so does a model id the catalogue does not list. There the
    old rules still apply, keyed to the wire: Sol/Luna agent turns send
    `reasoning_effort: "none"` (the CLI's `/thinking` says so), and Astra's
    agent turns get a 400 on tools and fall back to the text tool format. The
    CLI says that once per process at the start of a run (`agentToolsNote`),
    and its picker description mentions it. The macOS app has no text-tool
    fallback: there Astra's tool turns fail, and the model's thinking/tools
    note (`ModelTuning.toolCallingNote`) says why. Its kill switch is
    `defaults write dev.codeep.mac OpenAIWireAPI chat`. 5.6 Sol reasons with
    tools on either API.
  - Astra is back in the `openai` picker, and its `gpt-6-astra` → `gpt-6-sol`
    migration is gone (see the rule above). Configs it already moved stay on
    Sol. OpenRouter's `openai/gpt-6-astra` was never migrated.
  - The OpenAI default model became `gpt-6-sol` then (was `gpt-5.6-sol`). It
    has been `gpt-6.1-sol` since 2026-09-30 (next entry). The global
    fresh-install provider is unchanged.
  - The recordings are the transport's regression tests against reality:
    `src/api/responses.recorded.test.ts` parses them through the real parser,
    and `src/utils/responsesLoop.test.ts` checks that the step-2 input the
    agent loop builds from step 1's recorded stream matches the accepted step-2
    request item for item. Re-record with the script when OpenAI changes the
    event stream, and keep the key out of the files (a test checks).
- **GPT-6.1 Sol** (`gpt-6.1-sol`, released 2026-09-30; the only snapshot, no
  dated id; OpenRouter `openai/gpt-6.1-sol`) is **the OpenAI default** in both
  clients since 2026-09-30, by the owner's decision. The GPT-6 guide now
  features Astra, 6.1 Sol ("Near-Astra performance for complex work at a lower
  cost") and Luna. GPT-6 Sol is no longer featured, but it is **not
  deprecated**: the deprecations page has no GPT-6 entry, and the guide says to
  "review the migration guidance before switching". So GPT-6 Sol stays in the
  picker as the previous Sol with **no migration**. In the CLI the default
  applies only when a user switches to OpenAI (`setProvider`). On macOS it also
  fills a new chat when no OpenAI pick is remembered (`lastUsedModels`), while
  existing conversations and remembered picks keep GPT-6 Sol. A config that
  already names `gpt-6-sol` keeps it, including one that got it as the 3.6/3.7
  default.
  - $2/$10, like GPT-6 Sol, but **its cache read is 0.05× ($0.10), not 0.1×**
    ("Cached input tokens are priced at 5% of the uncached input token rate").
    That is a model row in the CLI's `MODEL_CACHE_READ_RATE` and its own row
    in macOS `CostEstimator`. GPT-6 Sol reads at $0.20, the 0.1× default, so
    don't copy the row there. Cache writes are the usual 1.25× ($2.50).
    Above 272K input the whole request bills at 2× input and cache and 1.5×
    output ($4/$15), as on every GPT-6 model. The table carries the
    short-context tier.
  - 1,050,000 context, 922,000 max input, 128,000 output, knowledge cutoff
    2026-04-30. OpenRouter's `context_length` is the same, so
    `openai/gpt-6.1-sol` is sized through the canonical id and needs no exact
    row.
  - Efforts `low`, `medium` (default), `high`, `xhigh` and `max`. It has **no
    `none` and no `minimal`** ("GPT-6 Astra and GPT-6.1 Sol do not support
    none; use low instead"). No `/thinking` tier sends either. The only
    `none` Codeep sends is `toolsForceReasoningOff`, for GPT-6 Sol/Luna agent
    turns on Chat Completions, and 6.1 Sol stays out of it. Without `none` it
    never takes `temperature`/`top_p`; the `gpt-6` entry in the sampling list
    already covers it. OpenRouter lists `max` for it too.
  - **It calls tools only over Responses**, as Astra does: "Use the Responses
    API for tool calling. Chat Completions is supported without tool
    calling." At the official URL its agent turns go over Responses because
    it is in the catalogue (`openAIWireApi` 'auto'). Taken out of the
    catalogue, they would quietly go to Chat Completions without native
    tools. `providers.responses.test.ts` pins the default to that route.
  - **The proxy downside, accepted by the owner.** Through an
    `OPENAI_BASE_URL` proxy, or with the switch at `chat`, its tools request
    is refused, and the CLI runs agent turns on the text-tool fallback with
    the one-time notice (`chatCompletionsCannotCallTools` /
    `agentToolsNote`). The notice names `gpt-6-sol` as the model that still
    calls tools there, with reasoning off. On macOS, see Astra above.
  - **Id shape.** `gpt-6.1-sol` canonicalizes to `gpt-6-1-sol`. The `gpt-6`
    prefix gates take it in, rightly: the `/thinking` control, Max → `max`,
    OpenRouter's Max and the sampling list. The exact `gpt-6-sol` gate in
    `toolsForceReasoningOff` misses it, also rightly; widening that gate to
    the `gpt-6` prefix would send it `none` and get a 400. The context, price
    and cache rows are exact.
  - **Not live-recorded.** The 2026-09-26 recordings cover Astra and GPT-6
    Sol. 6.1 Sol's Responses behaviour rests on OpenAI's docs until the owner
    records a 6.1 Sol case with `scripts/record-responses-fixture.mjs`.
- **OpenAI `reasoning_effort: "max"`** is valid from GPT-5.6 on (changelog
  2026-07-09) and on every GPT-6 model. Our Max tier sends it there; GPT-5.5 and
  earlier still get `xhigh`.
- **OpenRouter's Max goes as high as the model lists** in `/api/v1/models`
  `reasoning.supported_efforts`: `max` for GPT-5.6/6, the Claude 5 family,
  Opus 4.7/4.8, DeepSeek V4.1 Flash / V4 Pro 0813 and Kimi K3; `xhigh` for
  GPT-5.4/5.5, Grok 4.6/4.7 and Qwen 3.8 Max. Everything else, Gemini included,
  stays at `high`. That includes `deepseek/deepseek-v4-pro` (the 0423 preview)
  and `deepseek/deepseek-v4-flash`, which list only `xhigh`/`high`, so the list
  names the DeepSeek ids in full, never the `deepseek-v4` family. Both
  clients carry the same list (`openRouterMaxEffort` in `providers.ts` and in
  macOS `ModelTuning`); re-read it when adding a family.
- **Claude Opus 5.5** (`claude-opus-5-5`, the Anthropic default since
  2026-09-23) is $4/$20. **Its cache read is 0.05× ($0.20), not 0.1×**, a model
  row in the CLI's `MODEL_CACHE_READ_RATE` and its own row in macOS
  `CostEstimator`. Its 5-minute write is the usual 1.25× ($5). There is no
  long-context tier. It defaults to **medium** effort (Opus 5 used high), so
  users on Auto (`/thinking auto` in the CLI) now run one level lower. It
  "tends to think more per turn than Claude Opus 5", and the thinking spends
  `max_tokens`, so both clients raise its `max_tokens` to at least 32K, or 64K
  at the Max tier; Sonnet 5.5 gets the same floor (below), and no other model
  does. 32K is Codeep's own number,
  not one Anthropic gives. The CLI does it in `minResponseTokensFor` (agent
  turns, chat and the planner's 2048, OpenRouter's `anthropic/claude-opus-5.5`
  included). macOS does it in `ModelTuning.responseTokenBudget`, on the
  Anthropic protocol only: its OpenAI-compatible clients, OpenRouter included,
  send no cap at all. Opus 5 is "Active (legacy)", retiring no sooner than
  2027-07-24, so it stays in the picker with no migration. OpenRouter ids are
  dotted: `anthropic/claude-opus-5.5`, `anthropic/claude-fable-5.1`. As on Fable
  5.1, its narration between tool calls arrives as thinking blocks the stream
  parser drops, so a tool-only turn has no text. The CLI's agent loop stores
  that turn as "Using <tools>." (`assistantHistoryText`), because an empty
  non-final message is a 400 on Anthropic and its text-tool fallback resends the
  same history. Not live-tested; restoring the narration itself needs
  `display: "updates"` (beta) and rendering thinking blocks.
- **Claude Sonnet 5.5** (`claude-sonnet-5-5`, released 2026-09-28; OpenRouter
  lists it dotted, `anthropic/claude-sonnet-5.5`) is $2/$10, "the same prices as
  Claude Sonnet 5, including prompt caching": the 5-minute write is $2.50
  (1.25×) and a cache read $0.20 (0.1×). Both are the defaults, so it has no
  row in the rate tables. Opus 5.5 reads at the same $0.20, but against $4 —
  don't copy its 0.05 row. The $4 one-hour write never applies: Codeep sends no
  cache `ttl`. 1M context, 128K output; the CLI has no per-model output table,
  and the `anthropic` provider no output cap. Thinking is adaptive and **on by
  default**, not always on (`between_tools` is its lowest setting, and Codeep
  never sends it), at a default effort of **high** over five levels that
  Anthropic recalibrated from Sonnet 5; `/thinking auto` sends none. A
  non-default `temperature`/`top_p`/`top_k` is a 400, and the `claude-sonnet-5`
  entry in the sampling list covers 5.5 by prefix. Because the thinking spends
  `max_tokens` ("Revisit max_tokens. It covers thinking plus text"), it gets
  Opus 5.5's 32K/64K floor, matched exactly so Sonnet 5 stays out; on macOS,
  as for Opus 5.5, only on the Anthropic protocol (OpenRouter goes over the
  OpenAI client, which sends no cap). Its minimum cacheable prompt is 512
  tokens (Sonnet 5: 1,024). The Anthropic default stays
  Opus 5.5, where the models overview still says to start. Sonnet 5 stays in the
  picker as the previous Sonnet with **no migration**: it is still Active,
  retiring no sooner than 2027-06-30. Against Sonnet 5, and why each change
  does or does not reach Codeep:
  - `thinking: {type: "disabled"}` is a 400. Codeep sends no `thinking` field
    at all and has no "off" tier.
  - Forced `tool_choice` (`any`/`tool`) is a 400. Anthropic-format requests
    send no `tool_choice` (the default is auto); OpenAI-format ones send `auto`.
  - Thinking blocks are tied to the model and the conversation: replaying one
    after an edit to earlier history is a 400 for accounts created on or after
    2026-08-31. Codeep keeps history as plain text and never replays thinking
    blocks, so compaction and `/rewind` cannot hit it. Replaying them would.
  - `computer_20251124` is rejected, and so are some advisor-tool pairings.
    Codeep uses neither tool.
  - Text between tool calls comes back as progress-update thinking blocks,
    empty at the default display. Same as Opus 5.5 above; unchanged.
  - It declines in more categories: `stop_reason: "refusal"`, HTTP 200, with
    `stop_details.category` `cyber`, `bio`, `frontier_llm`,
    `reasoning_extraction` or `general_harms`. Every Anthropic-format chat and
    agent path now says "Claude declined this request (category: …)."
    (`src/api/anthropicContent.ts`), and a refused agent turn runs none of its
    tools. It used to be an empty reply, and in agent mode the empty turn read
    as unfinished and was sent again. The task planner is the exception: a
    refused plan still falls back to a single task, and the run that follows
    shows the notice. No fallback or retry. OpenRouter replies (OpenAI format)
    are not covered.

    The notice is for people. Where Codeep uses a reply as data, a decline is
    a failed reply, as the "" it used to be was. CLI: chat() returns the notice
    alone, and those callers check `isAnthropicRefusalNotice`. Compaction keeps
    the history and says why (an empty summary also used to replace it). The
    earlier-conversation recap is neither injected nor cached. Session titles
    and `/recall` recaps are null. `/plan` fails instead of storing it for
    `/go`. A skill's prompt step fails, so `${_prev}` never carries it into a
    command. MCP sampling answers with an error. `/me learn` keeps only bullet
    lines, and headless review shows the notice in its advisory AI section.
    macOS mirrors this: `AnthropicProtocolClient` streams the notice and ends
    on `StopReason.refusal`, which the agent treats like `.other`;
    `ProviderText.complete` throws `CodeepError.refused`, so compaction, the
    request-time trim, Learn, the commit message, recall and MCP sampling fail
    as they did before the notice, and `SessionTitler` returns nil.

  Read Anthropic replies **by block type**. A reply can start with a thinking
  block, so `content[0].text` was empty on Opus 5.5 and Sonnet 5/5.5 whenever
  the model thought first. The CLI's chat, text-tool-fallback and planner reads
  now join the `text` blocks; the stream parsers already skipped thinking deltas.
- **Claude Haiku 5.5** (`claude-haiku-5-5`, released 2026-10-07; a fixed id with
  no date suffix and no alias; OpenRouter lists it dotted,
  `anthropic/claude-haiku-5.5`) is the only Claude model in the catalogue
  **priced by prompt length** (the first Codeep prices that way): $0.10 in /
  $0.50 out for a prompt of up to 100,000 tokens, and $0.50 / $2.50 for one
  over it — every token of that request, not only those past the line. "A
  request's prompt length counts all of its input tokens, including cache
  reads and cache writes. Each request is priced on its own: a request over
  the threshold pays the higher prices even when part of its prompt is a cache
  hit" (platform.claude.com pricing, read 2026-10-09). The
  cache multiples are the usual ones in both tiers — read $0.01 / $0.05 (0.1×),
  5-minute write $0.125 / $0.625 (1.25×) — so it has no row in the rate tables;
  the 1-hour write ($0.20 / $1) never applies, because Codeep sends no cache
  `ttl`. Batch is half of each. "Claude 4.6 and later models (except Claude
  Haiku 5.5) … include the full 1M token context window at standard pricing":
  every other Claude row stays flat.
  - **How Codeep prices it.** Its `MODEL_PRICING` row carries a `longPrompt`
    tier (`overTokens: 100_000`, $0.50 / $2.50) beside the base rates, and
    `getCostBreakdown` picks the tier **per record**: `promptTokens` strictly
    over 100,000 takes the tier, exactly 100,000 does not ("up to"). Every
    extractor's `promptTokens` already includes cache reads and writes
    (`extractAnthropicUsage` adds Anthropic's separate fields back in), which
    is Anthropic's own measure, so the threshold reads it unchanged. It is never
    decided on a session's total: fifty 60K prompts are all base rate. Cache
    reads and writes bill at 0.1× and 1.25× of the tier's input rate, and
    `getCacheStats` nets the savings at the same tier. A cost the provider
    reports (OpenRouter's `usage.cost`, `actualCostUsd`) still beats the table;
    OpenRouter lists the same override itself (`min_prompt_tokens: 100000`,
    $0.50 / $2.50, read 2026-10-09). `/cost` adds a note when a request was
    priced at the long rate, so a figure five times the listed price is not
    mistaken for an error; `/stats` shows a second row in its pricing table;
    `getPricingTable()` gives this one row a `longPrompt` key, and
    `npm run export:catalogue` puts the same key under `pricing`, so the site
    can show both tiers. The mechanism is generic, but this is its only row:
    the other tiered models in this list (GPT-6, Grok, Gemini 3.1 Pro,
    MiniMax-M3, Qwen 3.6 Plus) still carry just their short-context rate.
    Giving them a tier is a data change, and a separate decision.
  - 1M context, 128K output (300K on the Batch API, with a beta header). The
    CLI has no per-model output table, and the `anthropic` provider no output
    cap. Knowledge cutoff June 2026; retirement not sooner than 2027-10-07. The
    Anthropic default stays Opus 5.5, where the models overview still says to
    start.
  - Thinking is adaptive and **on by default**, at a default effort of
    **medium** — Opus 5.5's, where every other model defaults to high — over all
    five levels (low, medium, high, xhigh, max). `/thinking auto` sends
    nothing, so an Auto user runs it at medium; the CLI keeps no table of
    per-model defaults, so none needed a row. The tiers send low, medium, high
    and max. **The effort gate was a trap:** the Anthropic pattern in
    `modelSupportsReasoningEffort` is an allowlist of families (`opus-5`,
    `opus-4-x`, `sonnet-4-6|5`, `fable-5`), and `claude-haiku-5-5` matched none
    of them — it would have shipped with `/thinking` hidden and no effort ever
    sent. `haiku-5` is in the pattern now; Haiku 4.5 stays out by its own
    guard. On OpenRouter the Max tier goes to `max`
    (`openRouterMaxEffort`; its `supported_efforts` are max, xhigh, high, medium
    and low, default medium, read 2026-10-09).
  - **A response floor.** Thinking tokens "count toward max_tokens, so a small
    limit can stop after a thinking block and before any text", so
    `minResponseTokensFor` gives it the 32K floor (64K at Max) of Opus 5.5 and
    Sonnet 5.5, matched exactly. Haiku 4.5, which thinks only when asked, stays
    out. 32K is Codeep's number, not Anthropic's.
  - **Sampling.** Omit `temperature`, `top_p` and `top_k`: sent, `temperature`
    must be 1 and `top_p` 0.99, and any `top_k`, or `temperature` together with
    `top_p`, is a 400. `claude-haiku-5` is in the sampling list (Haiku 4.5
    stays out of it), and Codeep leaves the fields off.
  Against Haiku 4.5, and why each change does or does not reach Codeep:
  - `thinking: {type: "enabled", budget_tokens}` is a 400, and
    `{type: "disabled"}` is allowed only at effort high or below. Codeep sends
    no `thinking` field at all and has no "off" tier.
  - **Prefill is a 400**, thinking on or off. Codeep never sends one: every
    Anthropic request ends on a user turn — the prompt, tool results or a
    nudge — and the only assistant turns it makes up ("Understood.") sit at the
    start. An MCP server's sampling request is rebuilt to end on the last user
    message too.
  - A forced `tool_choice` (`any`, or a named tool) **is accepted** here,
    unlike on Sonnet 5.5, but the reply starts with the tool call and has no
    thinking block. Moot: Anthropic-format requests send no `tool_choice`
    (auto), and OpenAI-format ones send `auto`.
  - Safety classifiers can decline a request: `stop_reason: "refusal"`, HTTP
    200, and **no server-side fallback** for this model. The notice added for
    Sonnet 5.5 ("Claude declined this request …") already covers every
    Anthropic-format path; OpenRouter replies still are not covered.
  - Thinking blocks belong to the account that produced them and stay valid
    only while everything before them is unchanged — a changed `system`,
    `tools` or earlier message is a 400 (enforced by default for accounts
    created on or after 2026-08-31). Codeep keeps history as plain text and
    never replays thinking blocks, so compaction and `/rewind` cannot hit it,
    as with Sonnet 5.5. Thinking text is omitted by default
    (`display: "omitted"`); Codeep drops thinking blocks either way.
    `between_tools` is Sonnet 5.5's, not this model's.
  - **The same text is about 30% more tokens** (the tokenizer of Claude 4.7
    and later). Against Haiku 4.5's $1 / $5 the rates are a tenth up to 100,000
    prompt tokens and half above, so the bill for the same text still falls (to
    about 13% and 65% of it), but the token counts `/cost` and the context
    meter show rise by about 30%. Compaction is character-based, so no budget
    moves.
  - A reply can begin with a thinking block, so it is read by block type, as
    for Opus 5.5 and Sonnet 5/5.5 (above). Priority Tier is not offered, and
    computer use (`computer_toolset_20260801`) and the browser use tool are
    ones Codeep does not use. Per-message effort changes need a beta header;
    Codeep sends one effort per request.

  Haiku 4.5 (`claude-haiku-4-5-20251001`) stays in the picker as the previous
  Haiku, now named "Claude Haiku 4.5", with **no migration**: it is still
  offered, and a map entry for an offered id would undo the user's pick at every
  launch (the rule under the update checklist; `providers.test.ts` checks it).

  **Live-tested once, not recorded.** On 2026-10-09 the owner sent Haiku 5.5 a
  request from the 3.10.2 build on Omarchy and it was answered, so the request
  shape is accepted. Which effort tier it ran at, and whether any prompt went
  over 100K tokens, was not written down: the effort parameter's values, the
  response floor, the refusal notice and the tier maths still rest on
  Anthropic's pages and OpenRouter's catalogue (read 2026-10-09), not on a
  recorded response.
- **Every Grok text model has a ≥200K tier**, not only 4.5/4.6: 4.7, 4.6, 4.5,
  build-0.1 and 4.3 all double once a prompt reaches 200K tokens. The higher rate
  then applies to **all** tokens in that request, not only those past 200K. Both
  clients carry the base tier. Grok cached input is 0.15–0.25× by model (4.7/4.6
  0.25, 4.5 0.15, build-0.1 0.2, 4.3 0.16), none of it the 0.1 default; the CLI
  holds these in `MODEL_CACHE_READ_RATE`, macOS on each Grok row in
  `CostEstimator`. `reasoning_effort` `xhigh` is documented from grok-4.6 on, so
  Max maps there on 4.6/4.7. It is **disputed** on 4.5 and 4.3 (the model pages list it; the
  reasoning guide and the May-15 page do not), so those keep the high ceiling
  until a live request settles it.
- **MiniMax-M3 is $0.30/$1.20 up to 512K prompt tokens** ("permanent 50% off"),
  $0.60/$2.40 above. The table carries the lower tier. Its cache read is $0.06
  ($0.12 above 512K), 0.2× the input rate, which `MODEL_CACHE_READ_RATE` now
  holds; before 2026-10-20 it fell to the 0.1 default and billed every cached
  token at half its price.
- **MiniMax-M3.1-Flash** (`MiniMax-M3.1-Flash`, read 2026-10-20 on
  platform.minimax.io `guides/text-generation`, `guides/pricing-paygo` and
  `token-plan/intro`) is **the default on `minimax`, `minimax-api` and
  `minimax-cn`**, first in the picker, with M3 kept beside it ("MiniMax-M3 also
  remains available"; no migration).
  - $0.15/$0.60 with cache read $0.015 (0.1×), one tier, no long-prompt step.
    Priority (`service_tier: priority`) is 1.5× and Codeep never sends it.
  - 1,000,000 context. Multimodal input (text, image, video).
  - **The retired `MiniMax-M3.1-Flash-Preview` is served by this model.** The
    M Plan page says so; Codeep never offered the Preview id, so there is no
    migration row.
  - **Thinking cannot be turned off**: `thinking: {"type": "disabled"}` or
    `effort: "none"` is a 400 (`requires adaptive thinking`). It takes a
    five-level `effort` (low/medium/high/xhigh/max, default **max**) as
    `output_config.effort` on the Anthropic protocol and `reasoning_effort` on
    the OpenAI one, and `/thinking` drives it (2026-10-20). **`/thinking auto`
    sends nothing, so the model runs at its own default, `max`**, the slowest
    and most token-hungry level on a subscription's 5-hour window; picking
    Low/Medium/High is how a user gets off it.
    - **The field depends on the protocol**, so `reasoningParamsFor` takes
      `opts.protocol` (agent turns, the text-tool fallback, plain chat and
      `/thinking`'s own readout all pass it). Without one it uses the provider's
      default: Anthropic for `minimax` and `minimax-cn`, OpenAI for
      `minimax-api`. The macOS app reaches MiniMax over the OpenAI endpoint only.
    - **Four tiers, five levels.** Low/Medium/High/Max map one to one; `xhigh`
      has no tier of its own and is never sent. No tier sends `none`, which is
      a 400 on this model.
    - **M3 gets nothing.** Its docs list no effort, so it stays without a
      control rather than being sent a field it may reject.
    - **Not verified against the live API.** The two field names are from
      MiniMax's text-generation page, which gives a working curl for each; no
      request was made with a key. The Anthropic shape is the one to check
      first, because Codeep's own comment says MiniMax's Anthropic endpoint
      "doesn't support native tools properly", so `minimax` agent turns run
      over the text-tool fallback, which is where its effort is sent. Record
      the first real response here.
  - **The coding-plan page now calls the subscription "M Plan"** (Go / Explore /
    Build), with M3.1 Flash as its only text model. Codeep's `minimax` provider
    is still labelled "Coding Plan", and its `subscribeUrl` still points at
    `/subscribe/coding-plan`; not changed here, not verified as stale.
  - **OpenRouter** lists `minimax/minimax-m3.1-flash:free` only (1M context,
    free); no paid id was listed on 2026-10-20, so the fallback list is
    unchanged.
  - The China host in MiniMax's own China docs is `api.minimax.cn`; Codeep's
    `minimax-cn` uses `api.minimaxi.com`. Unverified which is current, left as
    is.
- **Gemini 3.6 / 3.7 / 3.8 Flash run a promotional $0.75/$3.75 through
  2026-12-31**, scheduled to step back to $1.50/$7.50 on 2027-01-01. Revisit all
  three together on that date — not before: a scheduled rise entered early is how
  Sonnet 5 over-reported by 50% after Anthropic cancelled its own. (3.7 Flash is
  deprecated since 2026-10-08, below; its row stays for old session exports.)
- **Gemini 4 Argon** (`gemini-4-argon`, GA 2026-10-13; OpenRouter
  `google/gemini-4-argon`, listed in OpenRouter's `/api/v1/models` on
  2026-10-14 with a 1,048,576 context and $2/$10) is the Google default and
  first in the picker. Everything here is either from Google's own pages, read
  2026-10-14 (latest-model, models, pricing, openai-compat, deprecations,
  release notes), or from **the owner's run on 2026-10-14** of
  `scripts/verify-gemini-argon.mjs` with their own key (8 requests, recorded
  verbatim at the end of this entry). The script is the way to settle what is
  still open (it has since gained `stream` and `stream-tools` legs, a fourth
  replay rebuilt the way the app rebuilds it, and the path of every
  signature; 12 requests in all); it prints `usage` and `usageMetadata`
  verbatim, on both paths Codeep uses: the OpenAI-compat endpoint (CLI) and
  native `generateContent` (macOS), and takes `--model <id>` to ask the same
  questions of another Gemini.
  - **Price steps on 2026-12-01.** Introductory $2.00 in / $10.00 out (thinking
    is output) through 2026-11-30, then **$4.00 / $20.00**; cached input $0.10,
    then $0.20. The tables carry **the current $2/$10** and the step is not
    written ahead of time — the rule from the Flash note above and from Sonnet
    5. **Revisit on 2026-12-01, not before**: CLI `MODEL_PRICING`, macOS
    `CostEstimator`, then `npm run export:catalogue`. The cache-read ratio does
    not move (see next). No long-prompt tier on the Standard rows; Batch and
    Flex are half, Priority $3.60/$18 → $7.20/$36, none of them used.
  - **Cache read is 0.05×** ($0.10 against $2.00; "discounts cached input by
    95%"), a per-model row in the CLI's `MODEL_CACHE_READ_RATE` and macOS
    `CostEstimator` — the 0.1× default would bill every hit at twice its price.
    Implicit caching only, for prompts of at least 4,096 tokens; **explicit
    caching (`cachedContents`, `extra_body.google.cached_content`) is not
    supported** and Codeep never creates one, so there is nothing to remove.
    No cache-write charge and no storage price (write rate 1.0). **What its
    `usage` reports for a cache hit is still unverified**: every request of
    the owner's run was far below the 4,096-token threshold, so no hit was
    seen and the rate is Google's published price, not a measurement.
  - **Thinking tokens: reported apart, and now counted** (owner's run,
    2026-10-14).
    - *OpenAI-compat (CLI).* **Seen on one NON-streamed reply of one model
      only** — the CLI streams chat and agent turns, and the final
      `include_usage` chunk was not observed (open: a `stream: true` compat
      leg in the script). `usage` leaves thinking OUT of
      `completion_tokens` and has no `completion_tokens_details`:
      `{"completion_tokens":7,"prompt_tokens":47,"total_tokens":207}` at
      `reasoning_effort: "high"` — 207 − 47 − 7 = 153 thinking tokens that
      exist only as the gap in the total, billed as output. (At the default
      effort the totals had no gap: 5 + 38 = 43.) `extractOpenAIUsage(data,
      providerId)` in `src/utils/tokenTracker.ts` adds `total − prompt −
      completion` to the completion count **for `google` only**, passed from
      every call site that has a provider id (chat(), the agent streams and
      non-streamed turns, the text-tool fallback). Not for OpenRouter, whose
      usage already folds reasoning into `completion_tokens`, nor for any
      other provider, where `total_tokens` may legitimately differ. The rule is
      by shape: it fires on any Google model whose reply has the gap, and
      adds nothing twice if Google folds thinking in (the gap is then 0).
      Argon's reply is the only one inspected; whether 3.x had the same gap,
      so that its past estimates were low, is not known. `reasoningTokens` is
      not set, since there is no field to read it from.
    - *Native (macOS).* `usageMetadata` reports it beside the answer:
      `{"promptTokenCount":47,"candidatesTokenCount":7,"totalTokenCount":186,
      "thoughtsTokenCount":132}` — total = prompt + candidates + thoughts.
      `GoogleProtocolClient` now adds `thoughtsTokenCount` to the output
      count; it read `candidatesTokenCount` alone before, which under-counted
      every Gemini thinking model it could talk to. Google's Thinking guide:
      "response pricing is the sum of output tokens and thinking tokens".
    - The task planner (`src/utils/taskPlanner.ts`) and the text-tool
      fallback's streamed path (`handleStream`) record **no usage at all**, and
      did not before; not changed.
  - **Unified window, and thinking counts in the cap.** 1,048,576 tokens for
    input + thinking + output together; default `max_output_tokens` 65,536,
    "a hard limit: the response stops once thinking and output together reach
    it". Google: "We recommend at least 32,768, since Gemini 4 Argon can spend
    more of the limit on thinking". Both clients send at least
    **32,768 at every tier** (CLI `minResponseTokensFor`, macOS
    `ModelTuning.responseTokenBudget`). Max sends `high`, the same request as
    High, so it gets no larger floor — unlike Claude's 64K at Max. Where it
    bites: the CLI planner's 2,048 and any `maxTokens` lowered in /settings (the
    one-time bump to 32,768 runs once, so a lower value set later sticks), and
    macOS, whose Google client used to send
    `maxResponseTokens` (8,192) straight to the wire — the Claude floor was
    wired to the Anthropic client only. **Check every client that sends a cap
    when a floor is added.** A reply longer than 64K needs the Interactions
    API's background execution (or client-side continuation, which Google
    describes for GenerateContent); Codeep does neither, so one request ends
    at its cap.
  - **Sampling parameters are ignored**, not rejected ("If provided, they are
    ignored"). Argon is on the omit lists anyway (CLI `SAMPLING_PARAMS_REJECTED`,
    macOS `samplingParamsRejectedModels`): omitting is the safe side, and a
    /settings temperature should not look like it does something here.
  - **Effort.** `low | medium (default) | high`. The OpenAI-compat table maps
    `reasoning_effort` minimal→low, low→low, medium→medium, high→high; macOS
    sends `thinkingConfig.thinkingLevel` natively. No level switches thinking
    off. Both `/thinking` gates were `gemini-3` prefixes, which
    `gemini-4-argon` fails (the `gpt-6-astra` trap again); both name it exactly
    now. Max sends `high`. `reasoning_effort: "high"` was accepted on the
    compat endpoint (owner's run).
  - **Paid key only.** "Not available on the Free tier or on the Google AI Pro
    plan" — the CLI's picker description and provider hint say so; **the macOS
    app shows nothing**, its picker lists bare ids. It is the Google default in
    both, so a key on the free tier that selects Google starts on a model it
    cannot call until it picks another. How each client reports Google's
    refusal for a free-tier key is not verified (the run used a paid key):
    macOS treats a Gemini quota 400 as a retryable rate limit, so it may show
    retries and a rate-limit message rather than "needs a paid key".
  - **Latency, and the timeouts that follow** (owner's runs). The same
    one-line requests took 3.7 s and 29.0 s at the default effort, and 59.7 s
    and 3.5 s at `reasoning_effort: "high"`, on the compat endpoint in two
    runs the same day (native, `thinkingLevel: high`: 9.7 s and 4.6 s). It is
    uneven, not by effort, and a prompt that needs real thinking will be
    slower. Google: hard prompts "can take several minutes", use HTTP timeouts
    of at least 15 minutes.
    - **CLI plain `chat()`** (the TUI's own chat mode, /plan, compaction
      summaries, session titles, /recall, /me learn, headless review and the
      MCP sampling bridge; the task planner makes its own request with no timer
      of its own) ran on `apiTimeout`, 60 s, one timer for the whole reply
      streamed or not — the 59.7 s reply came in 0.3 s under it, and 29 s
      was seen at default effort. Argon now
      gets a **300 s floor** there: `minRequestTimeoutMsFor(model)` in
      `src/config/providers.ts` (canonical-id match, like
      `minResponseTokensFor`), read as `Math.max(config.get('apiTimeout'),
      floor)` at both `chat()` timer sites in `src/api/index.ts`, so a larger
      `apiTimeout` still wins. 300 s is the most a non-streamed reply can
      wait: Node's fetch (undici) cuts a connection that is silent for 300 s
      (headers or body — observed on Node 24.16 against a local server)
      whatever timer is set. Nothing else moved; the global default is
      untouched.
    - **CLI agent turns** get `agentApiTimeout` (600 s) × 1.0, 1.2 (iteration
      4+) or 1.5 (9+) — 600, 720 or 900 s, then ×1.5 and ×2 on up to two
      timeout retries (`maxTimeoutRetries` is 3 and the loop breaks at 3, so
      ×2.5 is never sent; plain `chat()` does not retry a timeout at all) — as
      ONE total-time timer that streaming does not reset (`agentChat.ts`), and
      under it the same 300 s undici cut. Unchanged.
    - **macOS**'s Google client sets an idle `timeoutInterval = 300`, which
      resets on every byte. Unchanged; there is no per-model hook there.
    - **Not done:** 15 minutes. It needs an `undici` Agent with
      `headersTimeout` and `bodyTimeout` raised (a new dependency, since
      Node's bundled undici cannot be imported) and a per-model floor read by
      `agentChat`; a retry after a timeout bills the thinking again. Do it if a
      real turn ever hits the cut.
  - **Interactions API.** Google's own quickstart, long decode and
    "`previous_interaction_id`" server-side conversation state are the
    Interactions API (`/v1beta/interactions`). Codeep uses Chat Completions on
    the OpenAI-compat endpoint (CLI) and `streamGenerateContent` (macOS),
    keeps conversation state client-side, and has not moved.
  - **Thought signatures: required back on a replayed function call**
    (owner's run, native `generateContent`).
    - *The fact.* A function call replayed WITHOUT its `thoughtSignature` is
      HTTP 400 INVALID_ARGUMENT, "Function call is missing a thought_signature
      in functionCall parts … `default_api:read_file`, position 2". The same
      call replayed as returned (signature kept, the `functionResponse` named
      by the function) is a 200. The signature is a string on the
      `functionCall` part, 124 characters on the one call seen (no thinking);
      572 and 660 characters came back on high-effort text answers, and one
      (124) on a plain "ready".
    - *CLI: not affected.* It keeps history as plain text and never replays a
      native function call (`src/utils/agent.ts`: the model's own turn goes back
      as `assistantHistoryText`, tool results as a user message). The run's
      OpenAI-compat follow-up replayed the reply as returned, which is stricter
      than what the CLI sends and was accepted; the CLI's own follow-up shape
      (plain text history) was not itself exercised.
    - *macOS: fixed.* `GoogleProtocolClient` used to drop the signature and
      name the `functionResponse` by its minted id (`gemini-call-N`), which is
      what got the 400. It now parses `part["thoughtSignature"]` and puts it
      into the minted id, `gemini-call-<n>~<signature>` (`GeminiCallID`, the
      one place the format lives): `ContentBlock.toolUse` has no slot for it
      and is matched in thirty-odd places, and a persisted conversation
      round-trips it as a Codable string. On replay a signed call goes back
      with `thoughtSignature` beside `functionCall`, and `functionResponse.name`
      is the function's name (resolved in message order: the counter behind
      `gemini-call-<n>` restarts every stream, so old history repeats
      `gemini-call-1`). A model turn in which no call carries a signature
      (history from before the fix, or another provider's) gets Google's
      documented `skip_thought_signature_validator` on its FIRST call only;
      the 2nd and later parallel calls of a signed turn get nothing, since
      Google ships the signature on the first. **The id is long and has a `~`:**
      Anthropic's `tool_use.id` is `^[a-zA-Z0-9_-]+$`, so the OpenAI,
      Anthropic and Responses clients put `GeminiCallID.providerNeutral(id)`
      on their wire (`gemini-call-<n>-<8 hex of the signature's SHA-256>`, for
      both the call and its result) when a conversation moves to another
      provider. Nothing else in the app, audit log, exporter or UI reads the
      id's content.
    - *Verified in the second run (12 requests):* the dummy is accepted on
      Argon and on `gemini-3.8-flash` (leg 2 of 4); the call rebuilt the way
      the app rebuilds it — `{functionCall: {name, args}}` plus that part's
      own `thoughtSignature` — is accepted on both (leg 4 of 4; the signature
      sits at `content.parts[0].thoughtSignature`); the replay without a
      signature is the same 400 on both, so **tool use on Gemini 3.x was broken
      on macOS before this fix, not only on Argon**; the `{"content": …}`
      response shape is accepted.
    - *Still unverified:* signature placement in `streamGenerateContent`
      chunks (the runs used `generateContent`), parallel calls, a signature
      replayed after a model switch, and Gemini 3.x other than 3.8 Flash.
  - **Streamed usage on the compat path** (second run). Google puts `usage`
    on EVERY chunk of a stream — 2 of 2 chunks in both streamed requests, the
    same totals — so a handler that records each chunk that carries it counts
    the reply once per chunk. `chat()`'s two stream handlers did (the agent
    stream kept the last); both now record the last once. No streamed request
    had thinking in it, so a streamed reply's gap in `total_tokens` was not
    seen.
  - **What is still unverified, in one place:** a streamed reply WITH thinking
    (compat `usage` gap) and the streamed native `usageMetadata`; cache-hit
    `usage` fields (below the 4,096-token threshold); Gemini 3.x other than
    3.8 Flash; free-tier error text; replays with parallel calls; streamed
    signature placement; a signature replayed after a model switch. Re-run
    the script (`--model` included) and move each into the entry above when it
    is settled.
  - **Second run** (owner, 2026-10-14, 12 requests, then 6 on
    `gemini-3.8-flash`): plain 28.9 s, `{"completion_tokens":5,
    "prompt_tokens":38,"total_tokens":43}`; tool call 3.6 s; follow-up 6.3 s;
    effort high 3.5 s, `{"completion_tokens":7,"prompt_tokens":47,
    "total_tokens":174}` (120 thinking); streamed plain 2.4 s and tool call
    3.0 s, usage on 2 of 2 chunks each; native high 4.6 s,
    `{"promptTokenCount":47,"candidatesTokenCount":7,"totalTokenCount":205,
    "thoughtsTokenCount":151}`; native replays: no signature 400, dummy 200,
    as returned 200, rebuilt like the app 200. On `gemini-3.8-flash`: native
    high `thoughtsTokenCount` 216 beside 3, the same 400 without a signature,
    dummy, as returned and rebuilt all 200, signatures of 332 to 780
    characters.
  - **First run, verbatim figures** (owner, 2026-10-14, 8 requests): plain 3.7 s,
    `{"completion_tokens":5,"prompt_tokens":38,"total_tokens":43}`; tool call
    3.0 s, `read_file({"path":"notes.txt"})`, `{"completion_tokens":24,
    "prompt_tokens":124,"total_tokens":148}`; follow-up as returned 1.9 s,
    `{"completion_tokens":6,"prompt_tokens":172,"total_tokens":178}`; effort
    high 59.7 s, 391, `{"completion_tokens":7,"prompt_tokens":47,
    "total_tokens":207}`; native high 9.7 s, `usageMetadata` above; native
    function call 9.6 s; native replay without a signature 400 in 0.2 s;
    native replay as returned 20.3 s, "PELICAN".
- **Gemini 3.7 Flash and 3.5 Flash are deprecated (2026-10-08).** Google
  replaced them with `gemini-3.8-flash` and `gemini-3.6-flash` and removed them
  from AI Studio's picker; the endpoints are "not shutting down" and "automatically
  route" to the replacement, with no shutdown date. They left both pickers and
  are in `RETIRED_MODEL_REPLACEMENTS` / `AppState.retiredModelReplacements`
  (rule 3); pricing and context rows stay. Unchanged: `gemini-3.8-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash-lite` and `gemini-3.1-pro-preview`
  (a preview, "No shutdown date announced") are current. `google/gemini-3.7-flash`
  is still in the OpenRouter fallback in both clients; OpenRouter's own
  catalogue still served it on 2026-10-14 ($0.75/$3.75, 1,048,576), and so
  `google/gemini-3.5-flash`, so it is not a dead id there.
- **Both GLM Coding Plans accept exactly `glm-5.3` and `glm-5.3-flash`**
  ("Only the following two models can be called", docs.z.ai/devpack/faq; the
  China plan says the same). Both route 5.2/5.1 to 5.3; China also routes Turbo
  to 5.3-Flash. Z.AI warns that other models on the plan risk "unexpected
  charges", which a flat-fee surface would never show in /cost. The pickers
  carry the two, and stored 5.2/5.1/5 → 5.3 and Turbo → 5.3-Flash, on the plan
  surfaces only. Pay-per-use still sells 5.2. `glm-5.3-flashx` ($0.37/$1.25,
  cached $0.075, 1M) is pay-per-use only. GLM-5-Turbo left the **international**
  price list, model overview and OpenAPI enum after 2026-07-31, with no notice, so
  it is off `z.ai-api` (migrated to Flash) and stays on `z.ai-cn-api`. Cache reads
  differ by platform (international 0.186–0.203; China 0.25–0.2875). The CLI's
  `SURFACE_CACHE_READ_RATE` holds them per surface. macOS `CostEstimator` is
  keyed on the model alone and carries the international ratios, so China
  cache reads come out a little low there.
- **GLM-5.3 was unpriced until 2026-08-19**, when it reached the standalone API
  and appeared on the pay-per-use price list at $1.40/$4.40 — the same figures as
  GLM-5.2, read off the page rather than inherited from it. **GLM-5.3 reached the
  China gateway** (`z.ai-cn*`) by 2026-09-11, on the China Coding Plan too, at
  CNY 8/28 (5.3 Flash CNY 0.8/2.8, pay-per-use only). China reuses the USD rows,
  a slight over-estimate.
- **Claude Haiku 4.5 may retire from 2026-10-15** ("not sooner than"), with no
  named replacement yet. Anthropic gives at least 60 days' notice and had given
  none by 2026-09-23, so the earliest realistic date is about 2026-11-22. That is
  an inference, not a published date; recheck the deprecations page. Claude
  Haiku 5.5 (above) has been the Haiku in the picker since 2026-10-09, and 4.5
  stays beside it with no migration. Recheck the deprecations page for 4.5's
  date before moving anyone off it.
- **Gemini 3.1 Pro has a long-context tier:** $4/$18 above 200K prompt tokens
  (cache $0.40). The table carries $2/$12. Stored `gemini-3-flash-preview`
  migrates to `gemini-3.6-flash` (Google's deprecations table; its 3.5 guide
  suggests 3.5 Flash, which costs twice as much), and `gemini-3-pro-preview`,
  shut down 2026-03-09, migrates to `gemini-3.1-pro-preview`.
- **Kimi:**
  - `kimi-for-coding` has been K2.8 Preview since 2026-09-11, with a 1,048,576
    context on every tier and low/high/max effort. Both clients turn the effort
    control on for it by exact id, so the `-highspeed` alias (K2.7 Code
    HighSpeed, no ladder) stays off: CLI `modelSupportsReasoningEffort`, macOS
    `ModelTuning.reasoningEffortSupported`.
  - `k3` gets 1M only on Pro/Allegretto; Plus/Moderato is capped at 256K.
  - Kimi Code answers **HTTP 401** for plan limits (no K3, K3 past 256K,
    HighSpeed below Pro), so a 401 with a key configured no longer reads "No
    API key configured" in the ACP server.
  - K3's cache read is 0.1× (model rows); K2.x is 0.2× on all three surfaces.
  - The docs now label `api.kimi.com/coding/v1` "China" and `api.kimi.ai/coding/v1`
    "Overseas". Not switched: untested with a real overseas key.
- **Qwen retirements on 2026-10-10** (notices 1949/1950, plans included):
  `qwen3-coder-plus`, `qwen3-coder-next` → `qwen3.7-plus`; bare `qwen3-max` →
  `qwen3.7-max` (→ `qwen3.7-plus` on the Coding Plans, whose allowlist lacks
  3.7 Max). The pay-per-use coder migrations used to point at 3.7 Max, which
  costs 6.25× the input rate.
  - The Token Plan retired `qwen3.8-max-preview`: it is routed to `qwen3.8-max`
    and migrated.
  - The Token Plan now has Personal and Team editions on one URL and key format,
    with different allowlists. `qwen3.6-plus` is Team-only (Personal gets 403).
    The CLI picker says so; macOS reports the 403 as a plan limit
    (`CodeepError`).
  - `qwen3.6-plus` lists at $0.5/$3 up to 256K, $2/$6 above.
  - The ModelScope fallback moved to `Qwen/Qwen3.5-397B-A17B`: the old
    Qwen3-Coder-480B is no longer served, and ModelScope named no successor.
    In the CLI a config, profile, checkpoint or bot still on the 480B moves to
    the 397B, on `modelscope` only and for that exact id. It is the one
    migration on a dynamic catalogue, allowed because the 480B was Codeep's own
    default rather than the user's pick; drop it if ModelScope serves the 480B
    again. macOS has no such entry, and `resolvedModel` exempts ModelScope
    before it looks one up, so a remembered 480B selection there keeps the dead
    id, and so does a bot pinned to `modelscope/Qwen/Qwen3-Coder-480B-A35B-Instruct`.

## Official source index

- OpenAI: <https://developers.openai.com/api/docs/models>
- OpenAI pricing: <https://developers.openai.com/api/docs/pricing>
- Anthropic: <https://platform.claude.com/docs/en/models/overview>
  (the older /docs/en/docs/about-claude/… and docs.anthropic.com addresses redirect here)
- Anthropic pricing (per-model cache ratios): <https://platform.claude.com/docs/en/about-claude/pricing>
- OpenAI GPT-6.1 Sol (price, cache, efforts, Responses-only tools):
  <https://developers.openai.com/api/docs/models/gpt-6.1-sol>
- OpenAI GPT-6 on Chat Completions (the tool restrictions), and why Responses:
  <https://developers.openai.com/api/docs/guides/latest-model>
  and <https://developers.openai.com/api/docs/guides/reasoning>
- OpenAI prompt caching (cache-write billing): <https://developers.openai.com/api/docs/guides/prompt-caching>
- Google Gemini: <https://ai.google.dev/gemini-api/docs/latest-model> (now
  "What's new in Gemini 4 Argon": id, thinking levels, output limits, the
  migration checklist) and <https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5>
- Google models: <https://ai.google.dev/gemini-api/docs/models>
- Google pricing (per-model standard/batch/flex/priority and the dated
  steps): <https://ai.google.dev/gemini-api/docs/pricing>
- Google OpenAI-compat (what the CLI uses; the `reasoning_effort` →
  `thinking_level` table): <https://ai.google.dev/gemini-api/docs/openai>
- Google release notes (deprecation announcements land here first):
  <https://ai.google.dev/gemini-api/docs/changelog>
- Google lifecycle: <https://ai.google.dev/gemini-api/docs/deprecations>
- DeepSeek changelog (newer than the news posts): <https://api-docs.deepseek.com/updates>
- DeepSeek: <https://api-docs.deepseek.com/quick_start/pricing>
- DeepSeek thinking-effort mapping:
  <https://api-docs.deepseek.com/guides/thinking_mode>
- Z.AI: <https://docs.z.ai/guides/llm/glm-5.3>
- Z.AI GLM Coding Plan allowlist: <https://docs.z.ai/devpack/faq>,
  <https://docs.z.ai/devpack/overview>; China: <https://docs.bigmodel.cn/cn/coding-plan/overview>
- Z.AI China (BigModel) models: <https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3>
- Z.AI China pricing: <https://docs.bigmodel.cn/cn/guide/start/pricing>
- Kimi: <https://platform.kimi.ai/docs/models>
- Kimi Code models, contexts and effort per plan:
  <https://www.kimi.com/code/docs/en/kimi-code/models.html>; plan-limit 401s:
  <https://www.kimi.com/code/docs/en/kimi-code/error-reference.html>
- MiniMax: <https://platform.minimax.io/docs/guides/pricing-paygo>
- xAI: <https://docs.x.ai/developers/models>
- xAI reasoning effort per model: <https://docs.x.ai/developers/model-capabilities/text/reasoning>
- Alibaba Model Studio models:
  <https://www.alibabacloud.com/help/en/model-studio/models>
- Alibaba Qwen3.8 Max / Flash:
  <https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max>,
  <https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash>
- Kimi pricing: <https://platform.kimi.ai/docs/pricing/chat>
- Alibaba Coding Plan exact allowlist:
  <https://www.alibabacloud.com/help/en/model-studio/coding-plan>
- Alibaba Token Plan endpoint and key isolation:
  <https://www.alibabacloud.com/help/en/model-studio/base-url>
- Alibaba Token Plan setup:
  <https://www.alibabacloud.com/help/en/model-studio/token-plan-team-quickstart>
- Alibaba lifecycle/deprecations:
  <https://www.alibabacloud.com/help/en/model-studio/model-depreciation>
  (the 2026-10-10 retirement tables are images in notices 1949 and 1950)
- Alibaba Token Plan editions:
  <https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview>,
  <https://www.alibabacloud.com/help/en/model-studio/token-plan-team-overview>
- OpenRouter live API: <https://openrouter.ai/api/v1/models>
- ModelScope live API: <https://api-inference.modelscope.cn/v1/models>

## Usage-stat contract

`stats_events` is append-only. Every client must upload only the token and cost
**delta since its last successful report**, never a cumulative conversation
total. A session count is `COUNT(DISTINCT session_id)`, not the number of event
rows. Keep regression tests around both rules whenever telemetry changes.

## Resource-impact estimate

Codeep presents electricity and cooling water as a broad range, never as a
provider measurement:

- Energy: 0.3–1.5 joules per token.
- Cooling water: 0.27–1.08 litres per kWh.

The range is intentionally wide because model size, hardware, batching, context
length, data-centre location, and cooling design are unknown. Useful public
calibration points include Google's production inference study and Microsoft's
fleet water-use effectiveness reporting:

- <https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference/>
- <https://services.google.com/fh/files/misc/measuring_the_environmental_impact_of_delivering_ai_at_google_scale.pdf>
- <https://blogs.microsoft.com/blog/2026/06/24/inside-microsofts-two-decade-push-to-cut-water-intensity-while-scaling-for-growth/>

If Codeep later receives provider-measured energy or regional data, show it as
a separate measured value; do not silently replace a range with false precision.
