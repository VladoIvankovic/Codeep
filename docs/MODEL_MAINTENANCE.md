# Model catalogue and maintenance policy

Last full review: **2026-09-23**

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
- Update CLI context/pricing in `src/utils/tokenTracker.ts`, including the
  cache-read and cache-write rates (model, surface and provider tables).
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
  - A target must be a model the same provider offers, which
    `providers.test.ts` and `ProviderChoiceTests` check. On a plan that means
    the plan's allowlist, not the vendor's named replacement: bare `qwen3-max`
    → `qwen3.7-plus` on the Coding Plans, because 3.7 Max is not on them.
  - Custom bots pinned to a migrated id (`model: openai/gpt-6-astra`) resolve
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
  $8/$30, Astra $20/$75, GPT-6 Sol $4/$15, GPT-6 Luna $0.20/$0.75. The table
  carries short-context only.
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
- **GPT-6 on Chat Completions cannot reason and call tools at once.** Codeep's
  only OpenAI transport is Chat Completions. There, GPT-6 Sol and Luna support
  function calling "only with `reasoning_effort` set to `none`", and Astra does
  not support it at all ("Chat Completions does not support function calling
  with GPT-6 Astra"; this was already in its 2026-09-03 launch notes). So:
  - Sol and Luna are offered, and every request that carries tools sends
    `reasoning_effort: "none"`, even on Auto (`/thinking auto` in the CLI), which
    would run them at medium. Requests without `tools` keep the tier: plain
    chat and the text-tool fallback in the CLI, Plan mode on macOS. The CLI's
    `/thinking` and picker descriptions say so; on macOS, Settings and the
    thinking menu do.
  - Astra is **not** offered on `openai`. Stored `gpt-6-astra` migrates to
    `gpt-6-sol` on `openai` only. OpenRouter's `openai/gpt-6-astra` is untouched,
    since OpenRouter may call OpenAI's Responses API upstream.
  - Revisit all of this when a Responses API transport exists, and drop the
    Astra migration then. The default stays `gpt-5.6-sol`, the newest model
    OpenAI documents with reasoning and tools together on Chat Completions.
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
  at the Max tier; no other model gets this floor. 32K is Codeep's own number,
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
  $0.60/$2.40 above. The table carries the lower tier.
- **Gemini 3.6 / 3.7 / 3.8 Flash run a promotional $0.75/$3.75 through
  2026-12-31**, scheduled to step back to $1.50/$7.50 on 2027-01-01. Revisit all
  three together on that date — not before: a scheduled rise entered early is how
  Sonnet 5 over-reported by 50% after Anthropic cancelled its own.
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
  an inference, not a published date; recheck the deprecations page.
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
- OpenAI GPT-6 on Chat Completions: <https://developers.openai.com/api/docs/guides/latest-model>
  and <https://developers.openai.com/api/docs/guides/reasoning>
- OpenAI prompt caching (cache-write billing): <https://developers.openai.com/api/docs/guides/prompt-caching>
- Google Gemini: <https://ai.google.dev/gemini-api/docs/latest-model> (now 3.8
  Flash only) and <https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5>
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
