# pi-qwencloud-quota

A [Pi](https://github.com/earendil-works/pi) package that reports **QwenCloud Token Plan consumption**.

It has two routes. Only the first one ships today:

| Route | Source | Status |
|---|---|---|
| **D — local token usage** | Pi's own session JSONL under `~/.gentle-shell/agent/` | **implemented** |
| **B — remaining Credits** | Alibaba Cloud `BssOpenAPI` `GetSubscriptionStats` (RAM AccessKey) | **not implemented yet** — see the seam in [`src/credits.ts`](src/credits.ts) |

## What it does

- Aggregates every assistant turn Pi recorded: fresh `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning` and `totalTokens`, broken down by **day**, **model**, **source** (orchestrator vs subagent) and **project**.
- Reports `cacheRead` as a share of total tokens. On real Token Plan sessions that ratio sits around **96–97%**, which is the single most decision-relevant number: almost all consumption is cached context, not fresh input.
- Registers itself with gentle-pi's native usage-source hook (`gentle-pi:usage-source/v1`), so the provider appears in the shell's usage panel next to Codex, Claude and NaN.
- Adds a slash command and a one-line status segment.

Route D works with **zero credentials and zero network access**: it reads local files only.

```
/ qwen-quota
QwenCloud Token Plan · local token usage
window: 2026-11-08 → 2026-11-09 · 2 sessions · 3 assistant turns
total: 77.9k tok · cacheRead 50.7k (65.1%) · fresh input 26.8k · output 393 · cacheWrite 10 · reasoning 29
...
Credits: not configured · route B needs ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET
```

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

- `/qwen-quota` prints the full summary for the configured window.
- A short status segment appears after `session_start` and after running the command:
  `qwen local 881.3M tok · cacheRead 96.7%`.
- In gentle-shell the provider shows up in the usage panel and `/gentle:usage` **when the session targets the `qwen-token-plan` provider** (the shell only refreshes providers in the current routing scope). The panel line carries the measured totals in the plan slot: `local 7d · 881.3M tok · cacheRead 96.7%`.

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

## Honesty rules this package follows

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

Tests never read the real `~/.gentle-shell/agent` tree: every fixture lives in a fresh `mkdtemp` directory and is removed afterwards. Route D is verified against the real session shape (`{type:"message", message:{role:"assistant", usage:{…}}}` — a nested record, not a flat one).

## License

MIT.
