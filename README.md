# pi-qwencloud-quota

A [Pi](https://github.com/earendil-works/pi) package that reports **QwenCloud Token Plan consumption**.

It has two routes. Only the first one ships today:

| Route | Source | Status |
|---|---|---|
| **D — local token usage** | Pi's own session JSONL under `~/.gentle-shell/agent/` | **implemented** |
| **B — remaining Credits** | Alibaba Cloud `BssOpenAPI` `GetSubscriptionStats` (RAM AccessKey) | **not implemented yet** — see the seam in [`src/credits.ts`](src/credits.ts) |

## What it does

- Aggregates every assistant turn Pi recorded: fresh `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning` and `totalTokens`, broken down by **day**, **model**, **provider**, **source** (orchestrator vs subagent) and **project**.
- Attributes each turn by the `provider` field **the turn itself recorded** — never by catalogue membership, because the same model id can exist in several catalogues (`deepseek-v4-flash` is in both `nan` and `qwen-token-plan`). A turn with no provider lands under `unknown`.
- Reports `cacheRead` as a share of total tokens. On real Token Plan sessions that ratio sits around **96–97%**, which is the single most decision-relevant number: almost all consumption is cached context, not fresh input.
- Reports the **qwen-token-plan** figure separately from the **all providers** figure, each with its own explicit label. The plan figure is never the aggregate of every provider on disk.
- Detects quota exhaustion from the provider's own `HTTP 429` + `Retry-After` response — the only quota signal that exists without credentials — and shows `exhausted · resets HH:MM` on the status row and in `/qwen-quota`.
- Registers itself with gentle-pi's native usage-source hook (`gentle-pi:usage-source/v1`), so the provider appears in the shell's usage panel next to Codex, Claude and NaN. The source is announced **on activation and again on `session_start`**: a `/reload` re-activates the module without replaying `session_start`, and a start-only announce left the old module's closure in charge of the panel.
- Adds a slash command that opens a navigable modal plus a one-line status segment.

Route D works with **zero credentials and zero network access**: it reads local files only.

```
/qwen-quota   →  opens this table in a modal

QwenCloud Token Plan · local token usage
window: 2026-11-07 → 2026-11-11 · 116 sessions · 6165 assistant turns (all providers)
qwen-token-plan: 1.8M tok · cacheRead 1.6M (87.3%) · fresh input 150.2k · output 42.1k · cacheWrite 1.2k · reasoning 8.4k
all providers: 917.0M tok · cacheRead 886.8M (96.7%) · local context only, not Qwen quota
by provider:
  nan             3401 turns · 620.4M tok · cacheRead 96.9%
  openai-codex    2100 turns · 294.6M tok · cacheRead 96.2%
  qwen-token-plan   59 turns · 1.8M tok · cacheRead 87.3%
...
Credits: not configured · route B needs ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET
```

That block shows the output's shape; the counts are illustrative and abridged with `...`.

## Install

```bash
# once published
pi install npm:pi-qwencloud-quota

# from a local checkout
pi install ./pi-qwen-usage

# try it for a single run without changing settings
pi -e ./pi-qwen-usage
```

Or add it to a `settings.json` `packages` array:

```json
{
  "packages": ["npm:pi-qwencloud-quota"]
}
```

The package declares its extension entry through the `pi.extensions` manifest in `package.json` (`./index.ts`), so Pi loads it as a normal package extension.

## Use

- `/qwen-quota` opens the full local-token summary for the configured window, including the per-provider breakdown sorted by tokens. Use ↑/↓ to scroll and Escape to close. Opening it clears any widget left by an older version.
- A short status segment appears after `session_start` and after a detected exhaustion:
  `qwen 1.8M tok · cacheRead 87.3%`.
- In gentle-shell the provider shows up in the usage panel and `/gentle:usage` **when the session targets the `qwen-token-plan` provider** (the shell only refreshes providers in the current routing scope). Its compact row shows only Qwen's local tokens and cache-read share, not a quota percentage: `local 7d · 1.8M tok · cache read 87.3% · not quota`. Use `/qwen-quota` for the all-providers total and breakdown.

### Modal navigation

The modal replaces the old persistent widget and avoids the widget's ten-line cap. Scroll with ↑/↓ to reach the remaining breakdowns and Credits note, and press Escape to close it. If the modal cannot open, a short error notification is shown.

### Why two figures

The first version of this package reported the aggregate of *every* local session under the `qwen-token-plan` name. The shell panel then read `qwen-token-plan · local 7d · 917.0M tok` while only ~1.8M tokens had actually gone through the token plan — the rest was `nan`, `openai-codex` and `claude-bridge` traffic. That is a dangerously wrong reading of a Qwen quota, so attribution is now taken from each record's own `provider` field and the two figures are labelled separately everywhere they appear.

## Configuration

All configuration is environment-only. Nothing is read from disk except the session files, and no credential is ever logged, echoed or persisted.

| Variable | Route | Default | Meaning |
|---|---|---|---|
| `PI_QWENCLOUD_AGENT_DIR` | D | `~/.gentle-shell/agent` | Pi agent dir. The aggregator reads `<dir>/sessions/<project-slug>/*.jsonl` (orchestrator) and `<dir>/gentle-agents/sessions/*.jsonl` (subagents). |
| `PI_QWENCLOUD_QUOTA_DAYS` | D | `7` | Window in local calendar days. `0` aggregates every session file on disk. |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | B | — | RAM AccessKey ID with read-only BSS permission. **Not used yet.** |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | B | — | Matching RAM AccessKey secret. **Not used yet.** |
| `ALIBABA_CLOUD_REGION_ID` | B | `ap-southeast-1` | BSS OpenAPI region. **Not used yet.** |

### Why route B is not implemented yet

Credits are not reported by the Token Plan API key Pi already holds: that endpoint exposes no quota headers at all. `GetSubscriptionStats` needs a **separate RAM AccessKey** created in the Alibaba Cloud console. This package therefore ships the seam (`src/credits.ts`) and reports `Credits: not configured` until that unit lands. When credentials are present it says so without echoing them:

```
Credits: route B recognised the credentials but is not implemented yet
```

Scraping the QwenCloud console with browser cookies is deliberately **not** implemented — a hard constraint of the spec, not an oversight.

## Quota exhaustion detection (zero credentials)

The token-plan inference endpoint returns **no** quota or rate-limit headers, so remaining quota cannot be read from a successful response. The one real signal is the exhaustion response itself: a `429` with `Retry-After: <seconds>`.

The extension registers `pi.on("after_provider_response")` and looks at exactly two things: the status and the `Retry-After` header. On a `429` from `qwen-token-plan` (or from a provider the hook cannot identify) it records the time, the provider and the derived reset time **in memory only**, then shows `exhausted · resets HH:MM`. The record disappears once the reset time passes; an exhaustion with no usable `Retry-After` shows `exhausted · resets unknown` and ages out after an hour.

- A missing, malformed or negative `Retry-After` still records the exhaustion, with an unknown reset. It never throws.
- A non-429 response never touches the recorded state, so a healthy request cannot silently clear a real exhaustion.
- A 429 from a **different** provider is not recorded: the hook fires for every provider, and another provider's rate limit says nothing about Qwen quota. This mirrors the attribution rule above — the extension never looks up whether a model id also exists in the qwen catalogue.
- No credential, request body or response body is read or stored. Nothing is written to disk.

## Honesty rules this package follows

- **Attribution comes from the record, not from the catalogue.** A turn is qwen-token-plan only when its own `provider` field says so; a missing field is `unknown`; a shared model id proves nothing.
- **No percentages of a quota that does not exist.** A Token Plan has no server-side quota window, so the usage-source payload claims no allowance: it emits one window-less limit with `limitReached: false` and puts the measured totals in `plan`. An honest `usedPercent` is impossible here, and a fabricated one would paint a fake gauge in the shell bar.
- **No USD figures.** Every `qwen-token-plan` model carries `cost: {input: 0, output: 0, …}`, so any dollar amount would be invented.
- **Read-only.** The package never writes to the session tree.
- **Fail-safe.** A malformed or truncated session line is skipped, never fatal; a missing agent dir is "no data", never an error; a handler never throws into the session.

## Develop

Requires Node.js ≥ 22.18 (type stripping is used, so the tests run without a build step).

```bash
npm test          # node --test, hermetic fixtures in a temp dir
npm install       # only needed for the type check
npm run typecheck
```

Tests never read the real `~/.gentle-shell/agent` tree: every fixture lives in a fresh `mkdtemp` directory and is removed afterwards. Route D is verified against the real session shape (`{type:"message", message:{role:"assistant", provider, usage:{…}}}` — a nested record, not a flat one).

## License

MIT.
