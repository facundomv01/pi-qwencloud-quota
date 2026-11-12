import type { BlUsage } from "./blcli.ts";
import type { CreditsStatus } from "./credits.ts";
import type { ExhaustionRecord } from "./exhaustion.ts";
import { formatShare, formatTokens, plural } from "./format.ts";
import { providerBucket } from "./sessions.ts";
import type { Aggregate, Bucket } from "./sessions.ts";
import { renderBlLine, renderExhaustion } from "./summary.ts";
import type { SummaryOptions } from "./summary.ts";
import type { PiKeybindings, PiTheme, PiThemeColor, PiTui } from "./types.ts";
import { USAGE_PROVIDER } from "./usage-source.ts";

/**
 * S12: the modal opens instantly and the data arrives later. The loader runs
 * exactly once per modal open (so `aggregateSessions` and the cached bl/credits
 * fetches are never re-triggered by tab switches) and must never throw — a
 * rejection renders as an error line inside the frame.
 */
export interface QuotaModalData {
	aggregate: Aggregate;
	summary: SummaryOptions;
}

export type QuotaModalLoader = () => Promise<QuotaModalData>;

// Measure terminal cells rather than UTF-16 units, including wide CJK and emoji.
function cellWidth(char: string): number {
	if (/\p{Mark}|\p{Default_Ignorable_Code_Point}/u.test(char)) return 0;
	return /[\p{Extended_Pictographic}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(char) ? 2 : 1;
}

/** Visible width: ANSI SGR sequences are zero-width for layout purposes. */
function widthOf(text: string): number {
	let width = 0;
	for (const char of text.replace(/\x1b\[[0-9;]*m/gu, "")) width += cellWidth(char);
	return width;
}

interface Seg {
	text: string;
	color?: PiThemeColor;
	bold?: boolean;
}

const t = (text: string): Seg => ({ text });
const dim = (text: string): Seg => ({ text, color: "dim" });
const colored = (color: PiThemeColor, text: string): Seg => ({ text, color });
const bold = (text: string): Seg => ({ text, bold: true });
const accentBold = (text: string): Seg => ({ text, color: "accent", bold: true });

function paint(segs: readonly Seg[], theme: PiTheme): string {
	return segs
		.map((seg) => {
			const styled = seg.color ? theme.fg(seg.color, seg.text) : seg.text;
			return seg.bold ? theme.bold(styled) : styled;
		})
		.join("");
}

/**
 * Word-wrap styled segments without ever splitting an escape pair: every word
 * carries its own style, so a wrapped row can be repainted safely. The first
 * row keeps the row's own leading whitespace; continuations hang by it +2
 * cells so table rows stay visually nested.
 */
function wrapSegs(segs: readonly Seg[], width: number): Seg[][] {
	const plain = segs.map((seg) => seg.text).join("");
	if (widthOf(plain) <= width) return [segs as Seg[]];
	const leading = plain.match(/^\s*/u)?.[0] ?? "";
	const hang = widthOf(leading) + 2;

	interface Tok {
		text: string;
		color?: PiThemeColor;
		bold?: boolean;
	}
	const tokens: Tok[] = [];
	for (const seg of segs) {
		for (const word of seg.text.split(/\s+/u).filter(Boolean)) tokens.push({ text: word, color: seg.color, bold: seg.bold });
	}

	const rows: Seg[][] = [];
	let row: Seg[] = leading ? [t(leading)] : [];
	let rowWidth = widthOf(leading);
	for (const token of tokens) {
		let word = token;
		// Hard-split words wider than the row (rare: long ids at tiny widths).
		while (widthOf(word.text) > Math.max(1, width - hang)) {
			let head = "";
			for (const char of word.text) {
				if (widthOf(head + char) > Math.max(1, width - hang)) break;
				head += char;
			}
			rows.push([...row, { ...word, text: head }]);
			row = [];
			rowWidth = 0;
			word = { ...word, text: word.text.slice(head.length) };
			if (!word.text) break;
		}
		if (!word.text) continue;
		const sep = rowWidth > 0 ? 1 : 0;
		if (rowWidth + sep + widthOf(word.text) > width && rowWidth > 0) {
			rows.push(row);
			row = [t(" ".repeat(hang))];
			rowWidth = hang;
		}
		if (sep && rowWidth > 0) {
			row.push(t(" "));
			rowWidth += 1;
		}
		row.push(word);
		rowWidth += widthOf(word.text);
	}
	if (rowWidth > 0 || rows.length === 0) rows.push(row);
	return rows;
}

const TABS = ["Overview", "Breakdown"] as const;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Pi's keybindings expose no left/right select action (the tui.select.* union
// is up/down/pageUp/pageDown/confirm/cancel only), so tab switching matches
// these inputs directly: the arrow escape sequences, plus [ ] and a d.
const PREV_TAB_KEYS = new Set(["\x1b[D", "[", "a"]);
const NEXT_TAB_KEYS = new Set(["\x1b[C", "]", "d"]);

/**
 * A `/stats`-style themed modal: full available width, bold colored headers,
 * dim labels, bright key numbers, two tabs (Overview / Breakdown), and an
 * instant loading state. The overlay renders every row of the active tab —
 * unlike `setWidget` arrays, custom overlays are not capped at 10 lines, so no
 * 44-page scrolling is needed.
 */
export function createQuotaModal(tui: PiTui, theme: PiTheme, keys: PiKeybindings, done: () => void, load: QuotaModalLoader) {
	type State = { kind: "loading" } | { kind: "ready"; data: QuotaModalData } | { kind: "error"; message: string };
	let state: State = { kind: "loading" };
	let tab = 0;
	let tick = 0;

	// Runs once per open; the result stays for every later tab switch.
	load()
		.then((data) => {
			state = { kind: "ready", data };
			tui.requestRender();
		})
		.catch((error: unknown) => {
			state = { kind: "error", message: error instanceof Error ? error.message : "unknown error" };
			tui.requestRender();
		});

	const frame = (row: string, inner: number): string => `│ ${row}${" ".repeat(Math.max(0, inner - widthOf(row)))} │`;

	function loadingRows(): Seg[][] {
		const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
		return [
			[colored("accent", `${spinner} Loading local session usage…`)],
			[colored("accent", `${spinner} Loading plan quota (bl CLI / credits)…`)],
		];
	}

	function errorRows(message: string): Seg[][] {
		return [[colored("error", `✗ could not load quota data: ${message}`)]];
	}

	function overviewRows(data: QuotaModalData): Seg[][] {
		const rows: Seg[][] = [];
		const options = data.summary;
		const now = (options.now ?? Date.now)();
		// The plan's real quota leads the tab: never buried below the local figures.
		if (options.bl) {
			const blLine = renderBlLine(options.bl, now);
			if (blLine) rows.push([colored("accent", blLine)]);
			else rows.push([colored("warning", options.bl.message)]);
		}
		const credits = (options.credits?.message ?? "").trim();
		if (credits) rows.push([colored(/not configured|pending|no subscription/.test(credits) ? "dim" : "success", credits)]);

		const aggregate = data.aggregate;
		if (aggregate.turns === 0) {
			const root = options.agentDir.replace(/[\\/]+$/, "");
			rows.push([t(`no local session data yet · looked in ${root}/sessions and ${root}/gentle-agents/sessions`)]);
			return rows;
		}

		rows.push([t("")]);
		rows.push([bold("Local session usage")]);
		rows.push([
			dim(
				`window: ${aggregate.from ?? "unknown"} → ${aggregate.to ?? "unknown"} · ${plural(aggregate.sessions, "session")} · ${plural(aggregate.turns, "assistant turn")} (all providers)`,
			),
		]);
		const qwen = providerBucket(aggregate, USAGE_PROVIDER);
		if (qwen) {
			rows.push([
				dim(`${USAGE_PROVIDER}: `),
				bold(`${formatTokens(qwen.totals.totalTokens)} tok`),
				dim(
					` · cacheRead ${formatTokens(qwen.totals.cacheRead)} (${formatShare(qwen.cacheReadShare)}) · fresh input ${formatTokens(qwen.totals.input)} · output ${formatTokens(qwen.totals.output)} · cacheWrite ${formatTokens(qwen.totals.cacheWrite)} · reasoning ${formatTokens(qwen.totals.reasoning)}`,
				),
			]);
		} else {
			rows.push([dim(`${USAGE_PROVIDER}: no turns in this window`)]);
		}
		// Only the exhaustion the provider itself reported; never inferred.
		if (options.exhaustion) rows.push([colored("error", renderExhaustion(options.exhaustion))]);
		rows.push([
			dim(
				`all providers: ${formatTokens(aggregate.totals.totalTokens)} tok · cacheRead ${formatTokens(aggregate.totals.cacheRead)} (${formatShare(aggregate.cacheReadShare)}) · local context only, not Qwen quota`,
			),
		]);
		return rows;
	}

	function bucketRows(buckets: readonly Bucket[]): Seg[][] {
		const keyWidth = Math.max(...buckets.map((bucket) => bucket.key.length));
		const turnLabels = buckets.map((bucket) => plural(bucket.turns, "turn"));
		const turnWidth = Math.max(...turnLabels.map((label) => label.length));
		return buckets.map((bucket, index) => [
			t(`  ${bucket.key.padEnd(keyWidth)} ${turnLabels[index].padEnd(turnWidth)} `),
			dim("· "),
			bold(`${formatTokens(bucket.totals.totalTokens)} tok`),
			dim(` · cacheRead ${formatShare(bucket.cacheReadShare)}`),
		]);
	}

	function breakdownRows(data: QuotaModalData): Seg[][] {
		const rows: Seg[][] = [];
		const aggregate = data.aggregate;
		const tables: Array<[string, readonly Bucket[]]> = [
			["By provider", aggregate.byProvider],
			["By source", aggregate.bySource],
			["By model", aggregate.byModel],
			["By day", aggregate.byDay],
			["By project", aggregate.byProject],
		];
		for (const [title, buckets] of tables) {
			if (buckets.length === 0) continue;
			rows.push([bold(title)]);
			rows.push(...bucketRows(buckets));
			rows.push([t("")]);
		}
		if (rows.length === 0) rows.push([dim("no breakdown rows in this window")]);
		else rows.pop(); // drop the trailing blank
		return rows;
	}

	return {
		render(width: number): string[] {
			tick++;
			const frameWidth = Math.max(20, width);
			const inner = frameWidth - 4;

			const title = paint([accentBold("QwenCloud Token Plan")], theme);
			const top = `┌─ ${title} ${"─".repeat(Math.max(0, frameWidth - 6 - widthOf("QwenCloud Token Plan")))}┐`;
			const bottom = `└${"─".repeat(frameWidth - 2)}┘`;
			const tabsRow = paint(
				TABS.map((name, index) =>
					index === tab ? accentBold(name) : dim(name),
				).flatMap((seg, index) => (index === 0 ? [seg] : [dim(" · "), seg])),
				theme,
			);
			const footer = paint([dim("←/→ switch tab · Esc close")], theme);

			let content: Seg[][];
			if (state.kind === "loading") content = loadingRows();
			else if (state.kind === "error") content = errorRows(state.message);
			else content = tab === 0 ? overviewRows(state.data) : breakdownRows(state.data);

			const body = content.flatMap((row) => wrapSegs(row, inner)).map((row) => frame(paint(row, theme), inner));
			return [top, frame(tabsRow, inner), frame("", inner), ...body, frame("", inner), frame(footer, inner), bottom];
		},
		handleInput(data: string): void {
			if (keys.matches(data, "tui.select.cancel")) return done();
			let next = tab;
			if (PREV_TAB_KEYS.has(data)) next = (tab + TABS.length - 1) % TABS.length;
			else if (NEXT_TAB_KEYS.has(data)) next = (tab + 1) % TABS.length;
			else return;
			if (next !== tab) {
				tab = next;
				tui.requestRender();
			}
		},
		invalidate(): void {},
	};
}
