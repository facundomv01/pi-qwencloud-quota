import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSessions } from "../src/sessions.ts";
import { renderStatusWidget, renderSummary } from "../src/summary.ts";
import { KNOWN_NOW, makeAgentFixture, nestedTurn, seedKnownAgent, sessionRecord } from "./helpers.ts";

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
			"window: 2026-11-08 → 2026-11-09 · 2 sessions · 3 assistant turns (all providers)",
			"qwen-token-plan: 77.9k tok · cacheRead 50.7k (65.1%) · fresh input 26.8k · output 393 · cacheWrite 10 · reasoning 29",
			"all providers: 77.9k tok · cacheRead 50.7k (65.1%) · local context only, not Qwen quota",
			"by provider:",
			"  qwen-token-plan 3 turns · 77.9k tok · cacheRead 65.1%",
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

	assert.equal(status, "qwen 77.9k tok · cacheRead 65.1%");
	assert.ok((status ?? "").length <= 60);
});

// The mislabelling defect: 917M of total local traffic was rendered as
// qwen-token-plan consumption. The tables must separate the two figures now.
test("separates the qwen plan from the all-providers context figure", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	fixture.write("sessions/--G--Proyectos-demo--/mixed.jsonl", [
		sessionRecord("2026-11-09T09:00:00.000Z", "G:\\Proyectos\\demo"),
		nestedTurn({
			timestamp: "2026-11-09T10:00:00.000Z",
			provider: "nan",
			model: "gpt-5.1-codex",
			input: 2000,
			output: 1000,
			cacheRead: 197000,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 200000,
		}),
		nestedTurn({
			timestamp: "2026-11-09T10:01:00.000Z",
			provider: "qwen-token-plan",
			model: "deepseek-v4-flash",
			input: 100,
			output: 50,
			cacheRead: 850,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 1000,
		}),
	]);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const text = renderSummary(aggregate, { agentDir: fixture.dir, days: 0, env: {} });

	assert.equal(
		text,
		[
			"QwenCloud Token Plan · local token usage",
			"window: 2026-11-09 → 2026-11-09 · 1 session · 2 assistant turns (all providers)",
			"qwen-token-plan: 1.0k tok · cacheRead 850 (85.0%) · fresh input 100 · output 50 · cacheWrite 0 · reasoning 0",
			"all providers: 201.0k tok · cacheRead 197.8k (98.4%) · local context only, not Qwen quota",
			"by provider:",
			"  nan             1 turn · 200.0k tok · cacheRead 98.5%",
			"  qwen-token-plan 1 turn · 1.0k tok · cacheRead 85.0%",
			"by source:",
			"  orchestrator 2 turns · 201.0k tok · cacheRead 98.4%",
			"by model:",
			"  gpt-5.1-codex     1 turn · 200.0k tok · cacheRead 98.5%",
			"  deepseek-v4-flash 1 turn · 1.0k tok · cacheRead 85.0%",
			"by day:",
			"  2026-11-09 2 turns · 201.0k tok · cacheRead 98.4%",
			"by project:",
			"  demo 2 turns · 201.0k tok · cacheRead 98.4%",
			CREDITS_LINE,
		].join("\n"),
	);
	// The status row is the Qwen subset only, so the bar cannot repeat the defect.
	assert.equal(renderStatusWidget(aggregate), "qwen 1.0k tok · cacheRead 85.0%");
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
		].join("\n"),	);
	assert.equal(renderStatusWidget(aggregate), undefined);
});

test("reports route B as configured-but-unimplemented without echoing secrets", (t) => {	const fixture = makeAgentFixture();
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

// Change B: the exhaustion the provider itself reported, surfaced on both
// surfaces. The clock is derived from the local timezone, so the test computes
// it the same way the formatter does instead of pinning a hardcoded hour.
function localClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${`${date.getHours()}`.padStart(2, "0")}:${`${date.getMinutes()}`.padStart(2, "0")}`;
}

test("surfaces a recorded exhaustion as exhausted · resets HH:MM", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const resetAt = KNOWN_NOW + 1_800_000;
	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const options = {
		agentDir: fixture.dir,
		days: 0,
		env: {},
		exhaustion: { observedAt: KNOWN_NOW, resetAt, provider: "qwen-token-plan" },
	};
	const text = renderSummary(aggregate, options);
	const clock = localClock(resetAt);

	const lines = text.split("\n");
	const qwenIndex = lines.findIndex((line) => line.startsWith("qwen-token-plan: ") && line.includes("tok"));
	assert.ok(qwenIndex >= 0);
	assert.equal(lines[qwenIndex + 1], `exhausted · resets ${clock}`);
	// The all-providers figure keeps its label and its position.
	assert.equal(
		lines[qwenIndex + 2],
		"all providers: 77.9k tok · cacheRead 50.7k (65.1%) · local context only, not Qwen quota",
	);
	assert.equal(
		renderStatusWidget(aggregate, { observedAt: KNOWN_NOW, resetAt, provider: "qwen-token-plan" }),
		`qwen 77.9k tok · cacheRead 65.1% · exhausted · resets ${clock}`,
	);
});

test("labels an exhaustion with no usable Retry-After as an unknown reset", (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const text = renderSummary(aggregate, {
		agentDir: fixture.dir,
		days: 0,
		env: {},
		exhaustion: { observedAt: KNOWN_NOW, resetAt: null },
	});

	assert.match(text, /^exhausted · resets unknown$/m);
	assert.equal(renderStatusWidget(aggregate, { observedAt: KNOWN_NOW, resetAt: null }), "qwen 77.9k tok · cacheRead 65.1% · exhausted · resets unknown");
});
