import { formatShare, formatTokens } from "./format.ts";
import { aggregateSessions, providerBucket, resolveDays } from "./sessions.ts";
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

// The plan slot carries two figures. The first is this provider's own turns;
// the second is the all-providers total behind an explicit label, so the panel
// can never present other providers' traffic as Qwen quota.
export function planLine(totalTokens: number, cacheReadShare: number, days: number, allProvidersTokens: number): string {
	const window = days > 0 ? `${days}d` : "all";
	return `local ${window} · ${formatTokens(totalTokens)} tok · cacheRead ${formatShare(cacheReadShare)} · all providers ${formatTokens(allProvidersTokens)} tok`;
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
				// Attribute by the provider each record recorded. The aggregate counts
				// every provider on disk; only the subset whose own `provider` field is
				// this one belongs in the plan figure.
				const qwen = providerBucket(aggregate, USAGE_PROVIDER);
				return {
					provider: USAGE_PROVIDER,
					plan: planLine(qwen?.totals.totalTokens ?? 0, qwen?.cacheReadShare ?? 0, days, aggregate.totals.totalTokens),
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
