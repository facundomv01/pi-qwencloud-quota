import { readCredits } from "./credits.ts";
import { formatShare, formatTokens, plural } from "./format.ts";
import type { Aggregate, Bucket } from "./sessions.ts";

export const STATUS_ID = "qwen-quota";
export const SUMMARY_HEADER = "QwenCloud Token Plan · local token usage";

export interface SummaryOptions {
	agentDir: string;
	days: number;
	env: Record<string, string | undefined>;
}

// Compact, human-readable and honest: token counts, the cacheRead ratio, and
// where the numbers came from. No USD figure anywhere, because the catalog cost
// for every qwen-token-plan model is zero (S10).
export function renderSummary(aggregate: Aggregate, options: SummaryOptions): string {
	const lines = [SUMMARY_HEADER];
	const credits = readCredits(options.env).message;

	if (aggregate.turns === 0) {
		const root = options.agentDir.replace(/[\\/]+$/, "");
		lines.push(`no local session data yet · looked in ${root}/sessions and ${root}/gentle-agents/sessions`);
		lines.push(credits);
		return lines.join("\n");
	}

	const totals = aggregate.totals;
	lines.push(
		`window: ${aggregate.from ?? "unknown"} → ${aggregate.to ?? "unknown"} · ${plural(aggregate.sessions, "session")} · ${plural(aggregate.turns, "assistant turn")}`,
	);
	lines.push(
		`total: ${formatTokens(totals.totalTokens)} tok · cacheRead ${formatTokens(totals.cacheRead)} (${formatShare(aggregate.cacheReadShare)}) · fresh input ${formatTokens(totals.input)} · output ${formatTokens(totals.output)} · cacheWrite ${formatTokens(totals.cacheWrite)} · reasoning ${formatTokens(totals.reasoning)}`,
	);
	lines.push(
		...renderBuckets("by source", aggregate.bySource),
		...renderBuckets("by model", aggregate.byModel),
		...renderBuckets("by day", aggregate.byDay),
		...renderBuckets("by project", aggregate.byProject),
	);
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
// that does not exist: only measured counts and the cacheRead ratio.
export function renderStatusWidget(aggregate: Aggregate): string | undefined {
	if (aggregate.turns === 0) return undefined;
	return `qwen local ${formatTokens(aggregate.totals.totalTokens)} tok · cacheRead ${formatShare(aggregate.cacheReadShare)}`;
}
