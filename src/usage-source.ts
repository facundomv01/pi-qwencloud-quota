import { formatShare, formatTokens } from "./format.ts";
import { aggregateSessions, resolveDays } from "./sessions.ts";
import type { ProviderUsage, UsageSourcePayload } from "./types.ts";

// The event gentle-shell subscribes to and validates (gentle-pi/lib/shell-usage.ts
// lines 139-175; runnable example in docs/gentle-shell.md lines 239-247).
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";
export const USAGE_PROVIDER = "qwen-token-plan";

// Shown until the first fetch answers, and after it when nothing is measured.
export const USAGE_PENDING_NOTE = "local usage only · Credits need route B (RAM AccessKey)";

export interface UsageSourceOptions {
	agentDir?: string;
	days?: number;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

export function planLine(totalTokens: number, cacheReadShare: number, days: number): string {
	const window = days > 0 ? `${days}d` : "all";
	return `local ${window} · ${formatTokens(totalTokens)} tok · cacheRead ${formatShare(cacheReadShare)}`;
}

// Route D mapped onto the usage-source contract. There is no server-side quota
// for a token plan, so the payload claims no allowance: `limits` carries one
// window-less entry with `limitReached: false`, and the measured counts ride in
// `plan` (which gentle-shell prints next to the provider name). A `UsageWindow`
// cannot be emitted honestly — `usedPercent` is mandatory, `used`/`budget` are
// only legitimate when a budget is genuinely known, and this route knows none —
// so inventing one would put a fabricated percentage in the bar and panel.
export function buildUsageSource(options: UsageSourceOptions = {}): UsageSourcePayload {
	const days = resolveDays(options);
	return {
		schema: USAGE_SOURCE_SCHEMA,
		provider: USAGE_PROVIDER,
		pendingNote: USAGE_PENDING_NOTE,
		async fetch(_apiKey: string | undefined, _fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
			// apiKey and fetchFn are deliberately unused: route D reads local files
			// only, so it works with zero credentials and zero network access (S2).
			try {
				const aggregate = aggregateSessions({ agentDir: options.agentDir, days, env: options.env, now });
				if (aggregate.turns === 0) return undefined;
				return {
					provider: USAGE_PROVIDER,
					plan: planLine(aggregate.totals.totalTokens, aggregate.cacheReadShare, days),
					limits: [{ name: "local", windows: [], limitReached: false }],
					fetchedAt: now,
				};
			} catch {
				// Never reject into the shell: an unreadable session tree is "no data".
				return undefined;
			}
		},
	};
}
