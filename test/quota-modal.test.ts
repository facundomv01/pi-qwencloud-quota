import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaModal } from "../src/quota-modal.ts";

test("modal wraps at word boundaries and frames its content within the terminal width", () => {
	const modal = createQuotaModal(
		{ requestRender() {} }, { matches: () => false }, () => {},
		"QwenCloud Token Plan · local token usage\nqwen-token-plan: 28.4M tok · cacheRead 27.3M\nall providers: local context only, not Qwen quota",
	);
	const lines = modal.render(32);
	assert.ok(lines.every((line) => Array.from(line).length <= 32));
	assert.match(lines[0], /┌/);
	assert.match(lines.join("\n"), /qwen-token-plan:/);
	assert.doesNotMatch(lines.join("\n"), /provi\n/);
	assert.equal(lines.filter((line) => line.includes("QwenCloud Token Plan")).length, 1);
});

test("modal displays local summary, scrolls and closes with cancel", () => {
	let renders = 0;
	let closed = 0;
	const modal = createQuotaModal(
		{ requestRender: () => { renders++; } },
		{ matches: (input, action) => input === action },
		() => { closed++; },
		Array.from({ length: 30 }, (_, i) => i === 0 ? "local token usage" : `line ${i}`).join("\n"),
	);
	assert.match(modal.render(80).join("\n"), /local token usage/);
	assert.doesNotMatch(modal.render(80).join("\n"), /line 29/);
	modal.handleInput("tui.select.down");
	assert.equal(renders, 1);
	assert.match(modal.render(80).join("\n"), /line 1/);
	modal.handleInput("tui.select.up");
	assert.equal(renders, 2);
	modal.handleInput("tui.select.cancel");
	assert.equal(closed, 1);
});

// A wrapped table row must keep its shape: continuation lines carry a hanging
// indent instead of starting flush-left and breaking the column rhythm.
test("wrapped rows keep a hanging indent", () => {
	const modal = createQuotaModal(
		{ requestRender() {} },
		{ matches: () => false },
		() => {},
		"  binance-trader-copilot 111 turns · 7.9M tok · cacheRead 98.0%",
	);
	const rendered = modal.render(30);
	const continuation = rendered.filter((line) => /^│ {5}[^ ]/u.test(line) && line.includes("cacheRead"));
	assert.ok(continuation.length > 0, `expected a wrapped continuation in ${JSON.stringify(rendered)}`);
	for (const line of continuation) {
		assert.match(line, /^│ {5}[^ ]/, `continuation must be indented: ${JSON.stringify(line)}`);
	}
});
