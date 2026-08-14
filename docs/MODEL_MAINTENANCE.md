# Model catalogue and maintenance policy

Last full review: **2026-08-09**

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
- Update CLI context/pricing in `src/utils/tokenTracker.ts`.
- Add an exact migration in `src/config/index.ts` for removed stored ids.
- Mirror the catalogue, tuning, context, and pricing in
  `Codeep-macOS/Packages/CodeepCore`.
- Update the OpenRouter fallback in both clients.
- Update the public provider matrix in
  `Codeep-web/src/app/docs/providers/page.tsx`.
- Run:
  - `npm test`, `npx tsc --noEmit`, and `npm run build` in the root.
  - `swift test --package-path Packages/CodeepCore` plus a macOS Debug build.
  - `npm test`, `npm run typecheck`, `npm run typecheck:test`, and
    `npm run build` in `Codeep-web`.
- Verify a migrated config, a new install, model selection, one real response,
  `/cost`, `/stats`, Mac Usage, Mac Insights, and the web dashboard.

## Official source index

- OpenAI: <https://developers.openai.com/api/docs/models>
- Anthropic: <https://docs.anthropic.com/en/docs/about-claude/models/overview>
- Google Gemini: <https://ai.google.dev/gemini-api/docs/latest-model>
- DeepSeek: <https://api-docs.deepseek.com/quick_start/pricing>
- Z.AI: <https://docs.z.ai/guides/llm/glm-5.2>
- Kimi: <https://platform.kimi.ai/docs/models>
- Kimi Code plan model access:
  <https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html>
- MiniMax: <https://platform.minimax.io/docs/guides/pricing-paygo>
- xAI: <https://docs.x.ai/developers/models>
- Alibaba Model Studio models:
  <https://www.alibabacloud.com/help/en/model-studio/models>
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
