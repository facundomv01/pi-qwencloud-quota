import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSessions } from "../src/sessions.ts";
import { createQuotaModal } from "../src/quota-modal.ts";
import type { QuotaModalData } from "../src/quota-modal.ts";
import type { PiKeybindings, PiTheme } from "../src/types.ts";
import { KNOWN_NOW, makeAgentFixture, seedKnownAgent } from "./helpers.ts";

// S12 redesign tests. The old modal (10-line pages, plain text, ↑/↓ scroll) was
// deliberately replaced by a themed, tabbed, instant-open component; the pinned
// strings below describe the new surface, not the old one.

const ANSI = /\x1b\[[0-9;]*m/gu;

function visible(line: string): string {
	return line.replace(ANSI, "");
}

interface FakeTheme {
	theme: PiTheme;
	calls: string[];
}

function fakeTheme(): FakeTheme {
	const calls: string[] = [];
	return {
		calls,
		theme: {
			fg(color, text) {
				calls.push(`fg:${color}`);
				return `\x1b[${color.length}m${text}\x1b[0m`;
			},
			bold(text) {
				calls.push("bold");
				return `\x1b[1m${text}\x1b[0m`;
			},
		},
	};
}

const KEYS: PiKeybindings = { matches: (data, action) => data === action };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Content rows of the current tab: frame borders, tabs row, footer and blanks removed. */
function contentLines(modal: ReturnType<typeof createQuotaModal>, width: number): string[] {
	return modal
		.render(width)
		.filter((line) => line.startsWith("│ "))
		.map((line) => visible(line.slice(2).replace(/\s*│$/u, "")).trim())
		.filter((line) => line.length > 0 && !line.startsWith("Overview") && !line.startsWith("←/→"));
}

function knownData(dir: string): QuotaModalData {
	return {
		aggregate: aggregateSessions({ agentDir: dir, days: 0, now: KNOWN_NOW }),
		summary: {
			agentDir: dir,
			days: 0,
			env: {},
			bl: {
				windows: [
					{ key: "5-hour", usedPercent: 12.0, resetAt: KNOWN_NOW + 3_600_000 },
					{ key: "monthly", usedPercent: 2.8, resetAt: KNOWN_NOW + 15 * 24 * 3_600_000 },
				],
				source: "usage",
				message: "",
			},
			credits: { configured: true, message: "Credits: 43740 of 45000 remaining (2.8% used)" },
			now: () => KNOWN_NOW,
		},
	};
}

test("modal opens instantly with a loading state before data resolves", () => {
	const d = deferred<QuotaModalData>();
	const { theme } = fakeTheme();
	const modal = createQuotaModal({ requestRender() {} }, theme, KEYS, () => {}, () => d.promise);
	const lines = contentLines(modal, 100);
	assert.ok(lines.length > 0, "the loading frame must not be an empty box");
	assert.ok(
		lines.some((line) => /Loading/.test(line) && /local session/.test(line)),
		`expected a local-sessions loading line in ${JSON.stringify(lines)}`,
	);
	assert.ok(
		lines.some((line) => /plan quota/.test(line)),
		`expected a plan-quota loading line in ${JSON.stringify(lines)}`,
	);
});

test("the ready view appears once the data promise resolves", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, fakeTheme().theme, KEYS, () => {}, () => d.promise);
	d.resolve(knownData(fixture.dir));
	await settle();

	const text = contentLines(modal, 300).join("\n");
	assert.match(text, /qwen-token-plan: 77\.9k tok/);
	assert.match(text, /Individual plan \(bl CLI\): 5-hour 12\.0%/);
	assert.match(text, /Credits: 43740 of 45000 remaining/);
});

test("tab switching changes the rendered tab and Esc closes", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	let renders = 0;
	let closed = 0;
	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal(
		{ requestRender: () => void renders++ },
		fakeTheme().theme,
		KEYS,
		() => closed++,
		() => d.promise,
	);
	d.resolve(knownData(fixture.dir));
	await settle();

	const overview = contentLines(modal, 300);
	assert.ok(overview.some((line) => line.startsWith("Individual plan (bl CLI):")));

	// Right arrow (a direct input match: Pi's keybindings have no left/right
	// select action) switches to Breakdown.
	modal.handleInput("\x1b[C");
	assert.ok(renders > 0, "a tab switch must request a render");
	const breakdown = contentLines(modal, 300);
	assert.ok(breakdown.some((line) => line.startsWith("By provider")), JSON.stringify(breakdown));
	assert.ok(breakdown.some((line) => line.startsWith("By model")), JSON.stringify(breakdown));
	assert.ok(!breakdown.some((line) => line.startsWith("Individual plan (bl CLI):")));

	// "[" (or the left arrow) switches back to Overview.
	modal.handleInput("[");
	assert.ok(contentLines(modal, 300).some((line) => line.startsWith("Individual plan (bl CLI):")));

	modal.handleInput("tui.select.cancel");
	assert.equal(closed, 1);
});

test("theme colors and weight are actually applied", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const { theme, calls } = fakeTheme();
	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, theme, KEYS, () => {}, () => d.promise);
	d.resolve(knownData(fixture.dir));
	await settle();

	const rendered = modal.render(300);
	assert.ok(calls.includes("fg:accent"), `expected an accent fg call in ${JSON.stringify(calls)}`);
	assert.ok(calls.includes("fg:dim"), `expected a dim fg call in ${JSON.stringify(calls)}`);
	assert.ok(calls.includes("bold"), `expected a bold call in ${JSON.stringify(calls)}`);
	assert.ok(rendered.some((line) => line.includes("\x1b[")), "rendered lines must carry ANSI styling");
});

test("the bl plan line renders prominently near the top of Overview", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, fakeTheme().theme, KEYS, () => {}, () => d.promise);
	d.resolve(knownData(fixture.dir));
	await settle();

	const lines = contentLines(modal, 300);
	const index = lines.findIndex((line) => line.startsWith("Individual plan (bl CLI):"));
	assert.ok(index >= 0, `expected the bl plan line in ${JSON.stringify(lines)}`);
	assert.ok(index <= 7, `the bl plan line must be within the first ~8 content lines, found at ${index}`);
});

test("degradation renders as a status line, never a crash or a fabricated figure", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const data = knownData(fixture.dir);
	data.summary.bl = {
		windows: [],
		source: "unavailable",
		message: 'bl CLI not found · install bailian-cli and run "bl auth login --console" once',
	};
	data.summary.credits = {
		configured: false,
		message: "Credits: not configured · route B needs ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET",
	};
	const { theme, calls } = fakeTheme();
	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, theme, KEYS, () => {}, () => d.promise);
	d.resolve(data);
	await settle();

	const text = contentLines(modal, 300).join("\n");
	assert.match(text, /bl CLI not found · install bailian-cli/);
	assert.match(text, /Credits: not configured · route B needs/);
	assert.ok(calls.includes("fg:warning"), `expected a warning fg call in ${JSON.stringify(calls)}`);
	assert.ok(!/0 remaining/.test(text), "a missing subscription must never render as zero");
});

test("a loader failure degrades into an error line instead of an empty box", async () => {
	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, fakeTheme().theme, KEYS, () => {}, () => d.promise);
	d.reject(new Error("sessions dir vanished"));
	await settle();

	const lines = contentLines(modal, 200);
	assert.ok(lines.some((line) => /could not load/.test(line) && /sessions dir vanished/.test(line)), JSON.stringify(lines));
});

test("no credential value ever renders", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const data = knownData(fixture.dir);
	data.summary.env = { ALIBABA_CLOUD_ACCESS_KEY_ID: "AKIA-test-id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "super-secret-value" };
	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, fakeTheme().theme, KEYS, () => {}, () => d.promise);
	d.resolve(data);
	await settle();

	const text = modal.render(300).join("\n");
	assert.ok(!text.includes("super-secret-value"));
	assert.ok(!text.includes("AKIA-test-id"));
});

test("every row fits the terminal width and wrapped rows keep a hanging indent", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const d = deferred<QuotaModalData>();
	const modal = createQuotaModal({ requestRender() {} }, fakeTheme().theme, KEYS, () => {}, () => d.promise);
	d.resolve(knownData(fixture.dir));
	await settle();

	const width = 48;
	const rendered = modal.render(width);
	assert.match(rendered[0], /┌/);
	assert.match(rendered[rendered.length - 1], /└/);
	const plain = rendered.map(visible);
	assert.ok(plain.every((line) => Array.from(line).length <= width), plain.join("\n"));

	// The long qwen figure line wraps, and its continuation rows stay indented
	// instead of starting flush-left.
	const continuation = plain.filter((line) => line.startsWith("│ ") && /^│ {4,}[^ ]/u.test(line));
	assert.ok(continuation.length > 0, `expected wrapped continuations in ${JSON.stringify(plain)}`);
});
