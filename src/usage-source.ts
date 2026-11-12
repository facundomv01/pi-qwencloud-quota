import { formatShare, formatTokens } from "./format.ts";
import { fetchCredits } from "./credits.ts";
import type { CreditsSnapshot } from "./credits.ts";
import { fetchBlUsage } from "./blcli.ts";
import type { BlRunner, BlUsage, BlWindow } from "./blcli.ts";
import { aggregateSessions, providerBucket, resolveDays } from "./sessions.ts";
import type { ProviderUsage, UsageSourcePayload, UsageWindow } from "./types.ts";

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
	/** Injectable transport for the bl CLI (route B2); no spawn when omitted. */
	blRunner?: BlRunner;
}

// The provider row shows only its own local traffic, never a quota gauge.
export function planLine(totalTokens: number, cacheReadShare: number, days: number): string {
	const window = days > 0 ? `${days}d` : "all";
	return `local ${window} · ${formatTokens(totalTokens)} tok · cache read ${formatShare(cacheReadShare)} · not quota`;
}

// Route B's snapshot becomes one honest monthly window — but only when the
// API actually reported a budget and the subscription period. Without a real
// budget there is no gauge: `usedPercent` is mandatory in the contract, so an
// unknown allowance must stay windowless rather than fabricate a percentage.
export function creditsWindow(snapshot: CreditsSnapshot): UsageWindow | undefined {
	if (snapshot.remaining === undefined || snapshot.total === undefined) return undefined;
	if (snapshot.subscriptionStart === undefined || snapshot.subscriptionEnd === undefined) return undefined;
	const spanSeconds = Math.round((snapshot.subscriptionEnd - snapshot.subscriptionStart) / 1000);
	if (!Number.isFinite(spanSeconds) || spanSeconds <= 0) return undefined;
	const used = Math.max(0, snapshot.total - snapshot.remaining);
	const usedPercent = snapshot.total > 0 ? Math.min(100, Math.max(0, (used / snapshot.total) * 100)) : 0;
	return {
		label: "monthly",
		usedPercent: Math.round(usedPercent * 10) / 10,
		windowSeconds: spanSeconds,
		resetAt: snapshot.resetAt ?? null,
		used,
		budget: snapshot.total,
	};
}

// Route B2's windows are the real gauge for an Individual plan: the CLI
// reports used ratios and resets per window, and each window's length is the
// documented period its name stands for.
const BL_WINDOW_SECONDS: Record<BlWindow["key"], number> = {
	"5-hour": 5 * 3600,
	weekly: 7 * 24 * 3600,
	monthly: 30 * 24 * 3600,
};

export function blWindows(bl: BlUsage): UsageWindow[] {
	return bl.windows.map((window) => ({
		label: window.key,
		usedPercent: window.usedPercent,
		windowSeconds: BL_WINDOW_SECONDS[window.key],
		resetAt: window.resetAt,
	}));
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
		async fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
			// apiKey is deliberately unused: the plan's inference key is never
			// accepted by quota endpoints. Route D reads local files only; route B
			// rides on the shell's timeout-bounded fetchFn with env-only AccessKey
			// credentials, and any failure degrades into the windowless payload.
			try {
				const aggregate = aggregateSessions({ agentDir: options.agentDir, days, env: options.env, now });
				if (aggregate.turns === 0) return undefined;
				// Attribute by the provider each record recorded. The aggregate counts
				// every provider on disk; only the subset whose own `provider` field is
				// this one belongs in the plan figure.
				const qwen = providerBucket(aggregate, USAGE_PROVIDER);
				// Route B2 first: an Individual plan's real windows. Only when the CLI
				// reports nothing does the seat-based credits route (B) get asked —
				// and with no credentials configured that call stays local.
				let limits: ProviderUsage["limits"] = [{ name: "local", windows: [], limitReached: false }];
				// Route B2 always runs: the default transport is the real bl binary;
				// options.blRunner only overrides it for tests.
				const bl = await fetchBlUsage(options.env ?? {}, { runner: options.blRunner });
				const windows = blWindows(bl);
				if (windows.length > 0) {
					limits = [{ name: "token plan", windows, limitReached: windows.some((w) => w.usedPercent >= 100), scope: "provider" }];
				}
				if (limits[0].windows.length === 0) {
					const snapshot = await fetchCredits(options.env ?? {}, { fetchFn, now: () => now });
					const window = creditsWindow(snapshot);
					if (window) {
						limits = [{ name: "credits", windows: [window], limitReached: (snapshot.remaining ?? 1) <= 0, scope: "provider" }];
					}
				}
				return {
					provider: USAGE_PROVIDER,
					plan: planLine(qwen?.totals.totalTokens ?? 0, qwen?.cacheReadShare ?? 0, days),
					limits,
					fetchedAt: now,
				};
			} catch {
				// Never reject into the shell: an unreadable session tree is "no data".
				return undefined;
			}
		},
	};
}
