// Token counts are the only unit this package reports. Never a currency: every
// `qwen-token-plan` model carries `cost: {input: 0, output: 0, ...}`, so a USD
// figure would be invented rather than measured (see the spec, S10).

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(Math.round(value));
}

export function formatShare(share: number): string {
	const percent = Number.isFinite(share) ? share * 100 : 0;
	return `${percent.toFixed(1)}%`;
}

export function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
