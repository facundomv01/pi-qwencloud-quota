import { readCredits } from "./credits.ts";
import type { CreditsStatus } from "./credits.ts";
import type { ExhaustionRecord } from "./exhaustion.ts";
import { formatClock, formatShare, formatTokens, plural } from "./format.ts";
import type { BlUsage } from "./blcli.ts";
import { providerBucket } from "./sessions.ts";
import type { Aggregate, Bucket } from "./sessions.ts";
import { USAGE_PROVIDER } from "./usage-source.ts";

export const STATUS_ID = "qwen-quota";
export const SUMMARY_HEADER = "QwenCloud Token Plan · local token usage";

export interface SummaryOptions {
	agentDir: string;
	days: number;
	env: Record<string, string | undefined>;
	/** Recorded quota exhaustion, when one has been seen and has not aged out. */
	exhaustion?: ExhaustionRecord;
	/** A pre-fetched route B snapshot; when absent, the sync not-configured/pending line is used. */
	credits?: CreditsStatus;
	/** A pre-fetched route B2 (bl CLI) snapshot for Individual plans. */
	bl?: BlUsage;
	/** Clock for rendering bl reset times; defaults to the real one. */
	now?: () => number;
}

/** `exhausted · resets HH:MM`, or an explicit unknown when Retry-After gave nothing usable. */
export function renderExhaustion(record: ExhaustionRecord): string {
	return record.resetAt === null ? "exhausted · resets unknown" : `exhausted · resets ${formatClock(record.resetAt)}`;
}

/**
 * One line for the Individual-plan windows the bl CLI reported. A reset within
 * 24h renders as a local clock time, further out as a date.
 */
export function renderBlLine(bl: BlUsage, now: number): string | undefined {
	if (bl.windows.length === 0) return undefined;
	const parts = bl.windows.map((window) => {
		if (window.resetAt === null) return `${window.key} ${window.usedPercent.toFixed(1)}%`;
		const reset = window.resetAt - now <= 86_400_000 ? `resets ${formatClock(window.resetAt)}` : `resets ${new Date(window.resetAt).toISOString().slice(0, 10)}`;
		return `${window.key} ${window.usedPercent.toFixed(1)}% · ${reset}`;
	});
	return `Individual plan (bl CLI): ${parts.join(" · ")}`;
}

// Compact, human-readable and honest: token counts, the cacheRead ratio, and
// where the numbers came from. No USD figure anywhere, because the catalog cost
// for every qwen-token-plan model is zero (S10).
export function renderSummary(aggregate: Aggregate, options: SummaryOptions): string {
	const lines = [SUMMARY_HEADER];
	const credits = (options.credits ?? readCredits(options.env)).message;
	const blLine = options.bl ? renderBlLine(options.bl, (options.now ?? Date.now)()) : undefined;
	// When the CLI reported nothing, its one-line reason IS the signal the user
	// asked for: exactly what to install or run, shown instead of silence.
	const blHint = options.bl && options.bl.windows.length === 0 ? options.bl.message : undefined;

	if (aggregate.turns === 0) {
		const root = options.agentDir.replace(/[\\/]+$/, "");
		lines.push(`no local session data yet · looked in ${root}/sessions and ${root}/gentle-agents/sessions`);
		if (blLine) lines.push(blLine);
		else if (blHint) lines.push(blHint);
		lines.push(credits);
		return lines.join("\n");
	}

	const totals = aggregate.totals;
	const qwen = providerBucket(aggregate, USAGE_PROVIDER);
	lines.push(
		`window: ${aggregate.from ?? "unknown"} → ${aggregate.to ?? "unknown"} · ${plural(aggregate.sessions, "session")} · ${plural(aggregate.turns, "assistant turn")} (all providers)`,
	);
	// Two figures, two labels: the plan's own turns first, then every local turn
	// as explicitly labelled context. Reporting the aggregate under the plan's
	// name was the mislabelling defect this line exists to prevent.
	if (qwen) {
		lines.push(
			`${USAGE_PROVIDER}: ${formatTokens(qwen.totals.totalTokens)} tok · cacheRead ${formatTokens(qwen.totals.cacheRead)} (${formatShare(qwen.cacheReadShare)}) · fresh input ${formatTokens(qwen.totals.input)} · output ${formatTokens(qwen.totals.output)} · cacheWrite ${formatTokens(qwen.totals.cacheWrite)} · reasoning ${formatTokens(qwen.totals.reasoning)}`,
		);
	} else {
		lines.push(`${USAGE_PROVIDER}: no turns in this window`);
	}
	// The plan's real quota belongs beside the plan's measured usage, not
	// buried at the bottom of a 40-line modal.
	// Only ever the exhaustion the provider itself reported; nothing is inferred.
	if (options.exhaustion) lines.push(renderExhaustion(options.exhaustion));
	if (blLine) lines.push(blLine);
	lines.push(
		`all providers: ${formatTokens(totals.totalTokens)} tok · cacheRead ${formatTokens(totals.cacheRead)} (${formatShare(aggregate.cacheReadShare)}) · local context only, not Qwen quota`,
	);
	lines.push(
		...renderBuckets("by provider", aggregate.byProvider),
		...renderBuckets("by source", aggregate.bySource),
		...renderBuckets("by model", aggregate.byModel),
		...renderBuckets("by day", aggregate.byDay),
		...renderBuckets("by project", aggregate.byProject),
	);
	if (blHint) lines.push(blHint);
	lines.push(credits);
	return lines.join("\n");
}

function renderBuckets(title: string, buckets: readonly Bucket[]): string[] {
	if (buckets.length === 0) return [];
	const keyWidth = Math.max(...buckets.map((bucket) => bucket.key.length));
	const turnLabels = buckets.map((bucket) => plural(bucket.turns, "turn"));
	const turnWidth = Math.max(...turnLabels.map((label) => label.length));
	return [
		`${title}:`,
		...buckets.map(
			(bucket, index) =>
				`  ${bucket.key.padEnd(keyWidth)} ${turnLabels[index].padEnd(turnWidth)} · ${formatTokens(bucket.totals.totalTokens)} tok · cacheRead ${formatShare(bucket.cacheReadShare)}`,
		),
	];
}

// Short enough for the shell's status row, and never a percentage of a quota
// that does not exist: only the qwen-token-plan subset's measured counts and
// its cacheRead ratio. Other providers' traffic never rides in this segment —
// that is exactly how the panel once showed 917M tokens of local traffic as
// qwen-token-plan consumption.
export function renderStatusWidget(aggregate: Aggregate, exhaustion?: ExhaustionRecord): string | undefined {
	if (aggregate.turns === 0) return undefined;
	const qwen = providerBucket(aggregate, USAGE_PROVIDER);
	const base = `qwen ${formatTokens(qwen?.totals.totalTokens ?? 0)} tok · cacheRead ${formatShare(qwen?.cacheReadShare ?? 0)}`;
	return exhaustion ? `${base} · ${renderExhaustion(exhaustion)}` : base;
}
