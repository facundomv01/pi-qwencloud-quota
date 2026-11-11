import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSessions } from "../src/sessions.ts";
import { renderStatusWidget, renderSummary } from "../src/summary.ts";
import { KNOWN_NOW, makeAgentFixture, seedKnownAgent } from "./helpers.ts";

const CREDITS_LINE =
	"Credits: not configured · route B needs ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET";

test("renders the compact summary for a known fixture", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const text = renderSummary(aggregate, { agentDir: fixture.dir, days: 0, env: {} });

	assert.equal(
		text,
		[
			"QwenCloud Token Plan · local token usage",
			"window: 2026-11-08 → 2026-11-09 · 2 sessions · 3 assistant turns",
			"total: 77.9k tok · cacheRead 50.7k (65.1%) · fresh input 26.8k · output 393 · cacheWrite 10 · reasoning 29",
			"by source:",
			"  subagent     1 turn  · 45.1k tok · cacheRead 88.7%",
			"  orchestrator 2 turns · 32.8k tok · cacheRead 32.7%",
			"by model:",
			"  deepseek-v4-flash 2 turns · 76.2k tok · cacheRead 65.9%",
			"  glm5.3-flash      1 turn  · 1.7k tok · cacheRead 29.2%",
			"by day:",
			"  2026-11-08 1 turn  · 45.1k tok · cacheRead 88.7%",
			"  2026-11-09 2 turns · 32.8k tok · cacheRead 32.7%",
			"by project:",
			"  agent 1 1 turn  · 45.1k tok · cacheRead 88.7%",
			"  demo    2 turns · 32.8k tok · cacheRead 32.7%",
			CREDITS_LINE,
		].join("\n"),
	);
});

test("renders a status line short enough for a shell bar", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const status = renderStatusWidget(aggregate);

	assert.equal(status, "qwen local 77.9k tok · cacheRead 65.1%");
	assert.ok((status ?? "").length <= 60);
});

test("renders no data instead of throwing on an empty agent dir", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 7 });
	const text = renderSummary(aggregate, { agentDir: fixture.dir, days: 7, env: {} });

	assert.equal(
		text,
		[
			"QwenCloud Token Plan · local token usage",
			`no local session data yet · looked in ${fixture.dir}/sessions and ${fixture.dir}/gentle-agents/sessions`,
			CREDITS_LINE,
		].join("\n"),
	);
	assert.equal(renderStatusWidget(aggregate), undefined);
});

test("reports route B as configured-but-unimplemented without echoing secrets", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const text = renderSummary(aggregate, {
		agentDir: fixture.dir,
		days: 0,
		env: { ALIBABA_CLOUD_ACCESS_KEY_ID: "AKIA-not-a-secret", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "super-secret-value" },
	});

	assert.match(text, /Credits: route B recognised the credentials but is not implemented yet/);
	assert.ok(!text.includes("super-secret-value"));
	assert.ok(!text.includes("AKIA-not-a-secret"));
});
