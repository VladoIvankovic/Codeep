# Model catalogue and maintenance policy

Last full review: **2026-09-11**

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
- Update CLI context/pricing in `src/utils/tokenTracker.ts`.
- Add an exact migration in `src/config/index.ts` for removed stored ids.
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
  06:00–10:00 UTC on weekdays). `MODEL_PRICING` holds one rate per model, so it
  carries **peak** — an over-estimate, deliberately, per rule 5. Rows reviewed
  2026-09-11 had drifted two to four and a half times *below* peak, which is the
  wrong direction; re-read the table, don't trust the comment.
- **DeepSeek V4.1 Flash is `deepseek-flash`** on DeepSeek's API but
  `deepseek/deepseek-v4.1-flash` on OpenRouter. From **2026-09-14 12:00 Beijing
  time** every `deepseek-v4-pro` request is routed to V4.1 Flash and billed at its
  price until a V4.1 Pro exists; watch for that release. Cache hits cost 2% of a
  miss but arrive as `prompt_cache_hit_tokens`, which the tracker does not read,
  so DeepSeek estimates bill all input at the miss rate.
- **GPT-5.6 Sol runs a promotional $4/$20** "at least through 2026-11-21" (list
  $5/$30). Long-context requests bill at a higher tier for Sol ($8/$30) and Astra
  ($20/$75); the table carries short-context only.
- **MiniMax-M3 is $0.30/$1.20 up to 512K prompt tokens** ("permanent 50% off"),
  $0.60/$2.40 above. The table carries the lower tier.
- **Gemini 3.6 / 3.7 / 3.8 Flash run a promotional $0.75/$3.75 through
  2026-12-31**, scheduled to step back to $1.50/$7.50 on 2027-01-01. Revisit all
  three together on that date — not before: a scheduled rise entered early is how
  Sonnet 5 over-reported by 50% after Anthropic cancelled its own.
- **GLM-5.3 was unpriced until 2026-08-19**, when it reached the standalone API
  and appeared on the pay-per-use price list at $1.40/$4.40 — the same figures as
  GLM-5.2, read off the page rather than inherited from it. **GLM-5.3 reached the
  China gateway** (`z.ai-cn*`) by 2026-09-11, on the China Coding Plan too, at
  CNY 8/28 (5.3 Flash CNY 0.8/2.8, pay-per-use only). China reuses the USD rows,
  a slight over-estimate.
- **Claude Haiku 4.5 may retire from 2026-10-15** ("not sooner than"), with no
  named replacement yet. Check the deprecations page before that date.

## Official source index

- OpenAI: <https://developers.openai.com/api/docs/models>
- OpenAI pricing: <https://developers.openai.com/api/docs/pricing>
- Anthropic: <https://platform.claude.com/docs/en/docs/about-claude/models/overview>
  (the old docs.anthropic.com address redirects here)
- Google Gemini: <https://ai.google.dev/gemini-api/docs/latest-model>
- DeepSeek: <https://api-docs.deepseek.com/quick_start/pricing>
- DeepSeek thinking-effort mapping:
  <https://api-docs.deepseek.com/guides/thinking_mode>
- Z.AI: <https://docs.z.ai/guides/llm/glm-5.3>
- Z.AI China (BigModel) models: <https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3>
- Z.AI China pricing: <https://docs.bigmodel.cn/cn/guide/start/pricing>
- Kimi: <https://platform.kimi.ai/docs/models>
- Kimi Code plan model access:
  <https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html>
- MiniMax: <https://platform.minimax.io/docs/guides/pricing-paygo>
- xAI: <https://docs.x.ai/developers/models>
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
