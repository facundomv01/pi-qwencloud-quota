# pi-qwencloud-quota

Pi extension that surfaces QwenCloud Token Plan consumption: local token aggregation from Pi session JSONL (route D, zero credentials) plus remaining Credits from the Alibaba Cloud subscription-stats OpenAPI (route B, env-gated), plugged into gentle-pi's native usage-source hook so it renders in `/gentle:usage` and the shell bar.

## Specs

**S1** — User request, verbatim: «verifica si existe algun plugin o extension para poder ver el consumo o uso de la cuota de qwencloud». Verified answer: nothing installed; `qwen-token-plan` is absent from `SUPPORTED_USAGE_PROVIDERS` (`gentle-pi/lib/shell-usage.ts:122` = `openai-codex`, `anthropic`, `nan` only), so `/gentle:usage` reports "no subscription usage for this provider". This package is the remedy.

**S2** — User directive, verbatim: «haz B+D y evita siempre riesgos». Two routes, both mandatory; risk avoidance is a hard constraint, not a preference. Concretely:
- No session-cookie or `sec_token` scraping of `cs-data.qwencloud.com` / `home.qwencloud.com` (route C) — explicitly excluded.
- No credential may ever be hardcoded, logged, echoed, committed, or persisted to disk by this package.
- Credentials are read from environment variables only, and their absence must never throw, warn noisily, or break route D.

**S3** — User directive, verbatim: «quiza sea más conveniente npm para poder repartirlo si es necesario publicarlo». Must be a real, publishable npm package: valid `package.json` with `name`, `version`, `description`, `license`, `repository`, `files`, `main`/`exports`, `keywords`; a `.gitignore` that excludes `node_modules` and any credential-bearing file; and a README sufficient for a third party to install and configure it. Publishing itself is NOT authorized by this spec — it remains a separate human decision.

**S4** — User question, verbatim: «no puede tomar el registro que tuve hoy del login?». Resolved: no. The credential in `~/.gentle-shell/agent/auth.json` under `qwen-token-plan` is a **Token Plan API key**, which authenticates only against the inference endpoint `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`. That endpoint returns no quota/rate-limit headers and `pi-ai/dist/providers/qwen-token-plan.js` parses none. Credits live behind Alibaba Cloud `BssOpenAPI` `GetSubscriptionStats`, which requires an **AccessKey ID + Secret** with RAM read permission — a different credential from a different console. Reusing today's browser login would mean route C cookies, excluded by S2.

**S5** — Package location, user-selected: `G:/Proyectos/pi-qwen-usage` (independent git repo, sibling of the user's other projects; deliberately NOT inside the `landing bitnest` repo).

**S6** — Package name, user-selected: `pi-qwencloud-quota`. (Directory name differs; see L4.)

**S7** — Integration contract. Emit `gentle-pi:usage-source/v1` with payload `{schema: "gentle-pi.usage-source/v1", provider: "qwen-token-plan", pendingNote?, fetch(apiKey, fetchFn, now)}` per `gentle-pi/lib/shell-usage.ts:148-175`; gentle-shell subscribes at `extensions/gentle-shell.ts:2229-2237` and supplies the provider's real API key plus a timeout-bounded `fetchFn`. `fetch` must resolve to `ProviderUsage { provider, plan?, limits[], fetchedAt }` where `UsageLimit { name, windows[], limitReached, scope? }` and `UsageWindow { label, usedPercent, windowSeconds, resetAt, used?, budget? }`. Runnable example: `gentle-pi/docs/gentle-shell.md:239-247`.

**S8** — Route D parser semantics, pinned from measurement. Pi session records are **nested**: `{type:"message", message:{role:"assistant", model, usage:{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost}}}`. Filtering on top-level `role`/`usage` yields zero rows — this was an actual defect during investigation. Roots: `~/.gentle-shell/agent/sessions/<project-slug>/*.jsonl` (orchestrator, grouped by cwd) and `~/.gentle-shell/agent/gentle-agents/sessions/*.jsonl` (subagents). Malformed or truncated lines must be skipped, never fatal.

**S9** — Verified baseline the aggregator must be able to reproduce: 5 days (2026-11-07 → 11-11), 111 sessions, 5,898 assistant turns, 852.6M total tokens; cacheRead 825.5M = 96.8%, fresh input 17.5M = 2.0%, output 6.3M = 0.7%, reasoning 3.0M = 0.35%. Orchestrator 16 sessions / 1,889 turns / 293.9M; subagents 95 sessions / 4,009 turns / 558.8M.

**S10** — Non-goals: no npm publish, no git push, no writes outside `G:/Proyectos/pi-qwen-usage`, no modification of `~/.gentle-shell/agent/**` or gentle-pi internals, no cost estimation in USD (catalog `cost` is `0/0` for every `qwen-token-plan` model, so any USD figure would be fabricated).

## Tasks

- T1 (S3,S5,S6) Scaffold publishable npm package: package.json, tsconfig, .gitignore, index.ts entry — worker — done (commit: pending parent commit)
- T2 (S2,S8,S9) Route D: local session JSONL aggregator (by day, model, provider, role) — worker — done incl. per-provider attribution (L8) (commit: pending parent commit)
- T3 (S2,S4) Route B: Alibaba Cloud GetSubscriptionStats client, env-gated, silent degradation — worker — pending (seam only: `src/credits.ts`)
- T4 (S7) Wire `gentle-pi:usage-source/v1` + slash command + status widget — worker — partial: route D done incl. provider-scoped labelling and the `after_provider_response` exhaustion listener (L8), route B fields (Credits) pending (commit: pending parent commit)
- T5 (S2,S8) Tests: parser against the nested shape, malformed-line tolerance, credential-absence degradation — worker — partial: 31 route D + attribution + exhaustion tests green, route B tests pending (commit: pending parent commit)
- T6 (S3) README and install/configure docs for a third party — worker — stub written (commit: pending parent commit)

## Log

**L1** — User, verbatim: «verifica si existe algun plugin o extension para poder ver el consumo o uso de la cuota de qwencloud».

**L2** — Investigation outcome: no installed package relates to usage/quota (`agent/settings.json:15-20` = gentle-engram, pi-web-access, pi-btw, pi-claude-bridge). No pi-ai adapter parses remaining-quota from any response body; grep hits are only error-string classifiers for `insufficient_quota`/`usage_limit_reached`. `get_session_stats` RPC exposes tokens and cost but no quota field. Extension feasibility confirmed: outbound `fetch`, `pi.registerCommand`, `ctx.ui.setStatus`/`setWidget`/`setFooter`, and the `after_provider_response` hook are all available (`docs/extensions.md`).

**L3** — Ecosystem scan: `@hk_net/pi-usage-bars@0.6.0` already researched `qwen-token-plan`/`-individual`/`-cn` and concluded "no documented API-key-authenticated endpoint that reports consumed or remaining quota". CodexBar, oh-my-pi (#6521), OmniRoute (#9603) and openchamber (#6209) all reach the numbers by scraping console cookies + `sec_token` — the route excluded by S2.

**L4** — User selected location `G:/Proyectos/pi-qwen-usage` and package name `pi-qwencloud-quota`. Directory and package name differ; directory kept as explicitly selected. Rename is a one-line follow-up if the user wants alignment.

**L5** — Billing facts verified from official Token Plan Personal docs, relevant to how results are labelled: "The Credits consumed per request are dynamically determined by model type, token usage, thinking mode, and tool calls"; unused monthly quota does not carry over; plan tiers Lite 20,000 / Essential 45,000 / Standard 80,000 / Pro 200,000 Credits; Credit Pack = 20,000 Credits, max 5; exhaustion returns HTTP 429 with `Retry-After` and `error.type: "insufficient_quota"`. The user's 25,000 Credits matches no published tier (promotional or trial grant).

**L6** — Environment probe: `bl` CLI absent, `aliyun` CLI absent, no `ALIBABA*`/`ALIYUN*`/`DASHSCOPE*`/`BAILIAN*` env vars, no `~/.aliyun/config.json`, no `~/.alibabacloud/credentials`. Route A (official CLI) is therefore unavailable without installing and configuring new credentials; route B remains the only risk-acceptable path to real Credits, and it is gated on a user-created RAM AccessKey.

**L7** — Unit 1 built in `G:/Proyectos/pi-qwen-usage`: T1, T2 done; T4 route D only; T5 route D only; T6 stub. Published surface is 10 files (`index.ts`, `src/*.ts`, `package.json`, `README.md`), zero runtime dependencies, `.gitignore`/`.npmignore` excluding `node_modules` and every credential-shaped name. Evidence: `npm test` 16/16 green (node:test against `test/**/*.test.ts`, Node type stripping, no build step); `npm pack --dry-run` lists exactly those 10 files; parser cross-checked against the real tree with an independent one-off counter — identical per-file turn counts. Real-tree run (read-only): 116 session files, 6,165 assistant turns, 881.3M tokens, cacheRead 96.7%, fresh input 2.1%, output 0.7%, reasoning 0.35%, days 2026-11-07 → 2026-11-11. That reproduces S9's *ratios*; its absolute counts are lower (111 files / 5,898 turns / 852.6M) because sessions kept accruing after S9 was measured — which is why the committed tests pin exact totals on fixtures instead of on live data.

Deviations, all deliberate:
- The usage-source payload emits `limits: [{ name: "local", windows: [], limitReached: false }]` and **no `UsageWindow`**. `usedPercent` is mandatory in gentle-pi's contract (`lib/shell-usage.ts:205-218`) and route D knows no budget, so any window would paint a fabricated gauge in the bar. The measured totals ride in `plan`, which the panel already prints beside the provider name (`lib/shell-usage.ts:598`). `pendingNote` says the Credits figure needs route B.
- No `after_provider_response` refresh: re-parsing the whole session tree (~170MB) on every turn is not worth it. The status segment refreshes on `session_start` and on `/qwen-quota`.
- `package.json` `repository`/`bugs`/`homepage` point at `github.com/facun/pi-qwencloud-quota` as a placeholder; correct them before any publish.
- `router`-style name alignment (L4) untouched: package `pi-qwencloud-quota`, directory `pi-qwen-usage`.

Not verified: `npm run typecheck` (typescript and @types/node are declared but not installed — no installer was authorized), and the actual gentle-shell rendering of the payload (validated against `parseUsageSource`/`parseProviderUsage` rules re-encoded in `test/usage-source.test.ts`, not against a running shell).

Commits: none yet. The worker does not run git mutations, so staging and commit remain with the parent; suggested Conventional Commit slices are (1) `feat: aggregate local QwenCloud token usage from Pi session JSONL`, (2) `feat: register qwen-token-plan usage source, command and status`, (3) `test: cover nested parser, malformed lines and degradation`, (4) `docs: scaffold publishable package and README stub`.

**L8** — Unit 2, two bounded changes (S2, S8, S10 honoured; no credential stored, echoed or persisted; no console scraping).

*Defect (verified, not theoretical).* `src/usage-source.ts` emitted `aggregateSessions()` totals under `provider: "qwen-token-plan"`, i.e. the aggregate of **every** local session on disk. The gentle-shell panel therefore rendered `qwen-token-plan · local 7d · 917.0M tok` while only ~1.8M tokens had actually gone through `qwen-token-plan`; the remainder was `nan`, `openai-codex` and `claude-bridge` traffic. Any quota decision read off that line was wrong by two orders of magnitude.

*Change A — attribution.* `Aggregate` gains `byProvider`, bucketed from the `provider` field on the assistant record itself (`message.provider`, falling back to a top-level `provider`, else `unknown`); new `providerBucket(aggregate, provider)` is the only supported way to read a provider-scoped figure. Catalogues are never consulted: `deepseek-v4-flash` exists in **both** the `nan` and `qwen-token-plan` catalogues, so membership proves nothing and a model-id lookup would reintroduce the defect. Consequences: the usage-source `plan` keeps its shape `local <window> · <tokens> tok · cacheRead <share>` over the qwen subset only and appends a labelled ` · all providers <tokens> tok`; `/qwen-quota` prints `qwen-token-plan:` totals, an explicitly labelled `all providers: … · local context only, not Qwen quota` line, and a `by provider:` table (provider, turns, total tokens, cacheRead share) sorted by tokens desc; the status row became `qwen <tokens> tok · cacheRead <share>` (qwen subset), dropping the ambiguous `local` wording. `MODEL_CHANGE`/`model_change` records are still not used for attribution — only the turn's own field is.

*Change B — exhaustion detection.* New `src/exhaustion.ts`: `createExhaustionTracker(now, ttl?)` + `pi.on("after_provider_response")` (event shape `{type, status, headers}` per `pi-coding-agent/dist/core/extensions/types.d.ts:725-729`). It reads only `status`, the `Retry-After` header (case-insensitive; seconds, HTTP-date tolerated) and an `insufficient_quota` error type when the event exposes one. Records `{provider?, observedAt, resetAt}` in memory only — no disk, no request or response body, no credential. `resetAt = observedAt + Retry-After × 1000`; missing/malformed/negative header still records with `resetAt: null` (visible for `UNKNOWN_RESET_TTL_MS` = 1h); the record expires at/after `resetAt`; a non-429 response never mutates the state; a 429 attributed to another provider (`ctx.model.provider`) is ignored rather than reported as Qwen exhaustion — same misattribution class as Change A. Rendering: `exhausted · resets HH:MM` (local clock) or `exhausted · resets unknown`, appended to the status row and printed on its own line by `/qwen-quota`. Every path is wrapped: the hook never rejects into the session.

*Evidence.* RED observed twice — Change A: 8 failing tests, the decisive one showing actual `plan: 'local 7d · 201.0k tok · cacheRead 98.4%'` against expected `'local 7d · 1.0k tok · cacheRead 85.0% · all providers 201.0k tok'` (the foreign `nan` turn counted as qwen); Change B: 4 failing tests, including `ERR_MODULE_NOT_FOUND: src/exhaustion.ts` and a missing `after_provider_response` handler. GREEN: `npm test` 31/31, exit 0. `npm run typecheck` exit 0 — typescript + @types/node are now present in `node_modules`, so L7's "typecheck unverified" no longer applies and this run is the evidence.

*Tests updated because the labelling changed* (deliberate, not regressions): `test/usage-source.test.ts` plan string, `test/summary.test.ts` summary + status strings, `test/extension.test.ts` summary string. New: 3 aggregate attribution tests (mixed providers, provider-less record, shared-model-id trap), 1 usage-source subset test, 2 summary labelling/exhaustion tests, 1 extension 429 test, and `test/exhaustion.test.ts` (7 tests: reset from Retry-After, non-429 inert, malformed tolerance, expiry, unknown-reset TTL, foreign-provider 429, `insufficient_quota` without 429).

Not verified: the live gentle-shell rendering of the new `plan` string (still validated against the encoded `parseUsageSource`/`parseProviderUsage` rules, not a running shell); a real 429 from `token-plan.ap-southeast-1.maas.aliyuncs.com` (exhausting the plan is not something this unit may do). Route B remains untouched and pending (T3).
