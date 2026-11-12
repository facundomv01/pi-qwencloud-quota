import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateSessions, providerBucket } from "../src/sessions.ts";
import {
	makeAgentFixture,
	nestedTurn,
	providerlessTurn,
	sessionRecord,
	toolResultRecord,
	userRecord,
} from "./helpers.ts";

const ORCHESTRATOR_DIR = "--G--Proyectos-demo--";

// One agent dir holding both roots, so source/project bucketing is exercised.
// A 2026-11-09T10:00Z timestamp is 2026-11-09 in every timezone the fixture is
// plausibly read in, so the day bucket is stable without pinning TZ.
function bothRoots() {
	const fixture = makeAgentFixture();
	fixture.write(`sessions/${ORCHESTRATOR_DIR}/orchestrator.jsonl`, [
		sessionRecord("2026-11-09T09:59:00.000Z", "G:\\Proyectos\\demo"),
		// Verbatim nested shape measured in real Pi session files.
		'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-11-09T10:00:00.000Z","message":{"role":"assistant","provider":"qwen-token-plan","model":"deepseek-v4-flash","usage":{"input":20779,"output":93,"cacheRead":10240,"cacheWrite":0,"reasoning":9,"totalTokens":31112,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0,"totalFromProvider":false}},"timestamp":1794218400000}}',
		userRecord("2026-11-09T10:05:00.000Z"),
		nestedTurn({
			timestamp: "2026-11-09T11:00:00.000Z",
			model: "glm5.3-flash",
			input: 1000,
			output: 200,
			cacheRead: 500,
			cacheWrite: 10,
			reasoning: 0,
			totalTokens: 1710,
		}),
		toolResultRecord("2026-11-09T11:01:00.000Z"),
		JSON.stringify({
			type: "model_change",
			id: "mc1",
			parentId: null,
			timestamp: "2026-11-09T11:02:00.000Z",
			provider: "qwen-token-plan",
			modelId: "glm5.3-flash",
		}),
	]);
	fixture.write("gentle-agents/sessions/subagent.jsonl", [
		sessionRecord("2026-11-08T09:00:00.000Z", "G:\\Proyectos\\agent 1"),
		nestedTurn({
			timestamp: "2026-11-08T10:00:00.000Z",
			input: 5000,
			output: 100,
			cacheRead: 40000,
			cacheWrite: 0,
			reasoning: 20,
			totalTokens: 45100,
		}),
	]);
	return fixture;
}

test("aggregates the nested record shape by day, model, source and project", (t) => {
	const fixture = bothRoots();
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });

	assert.equal(aggregate.turns, 3);
	assert.equal(aggregate.sessions, 2);
	assert.deepEqual(aggregate.totals, {
		input: 26779,
		output: 393,
		cacheRead: 50740,
		cacheWrite: 10,
		reasoning: 29,
		totalTokens: 77922,
	});
	assert.equal(aggregate.cacheReadShare, 50740 / 77922);
	assert.equal(aggregate.from, "2026-11-08");
	assert.equal(aggregate.to, "2026-11-09");

	assert.deepEqual(
		aggregate.byDay.map((bucket) => bucket.key),
		["2026-11-08", "2026-11-09"],
	);
	assert.deepEqual(aggregate.byDay[0].totals, {
		input: 5000,
		output: 100,
		cacheRead: 40000,
		cacheWrite: 0,
		reasoning: 20,
		totalTokens: 45100,
	});
	assert.deepEqual(aggregate.byDay[1].totals, {
		input: 21779,
		output: 293,
		cacheRead: 10740,
		cacheWrite: 10,
		reasoning: 9,
		totalTokens: 32822,
	});
	assert.deepEqual(
		aggregate.byDay.map((bucket) => bucket.turns),
		[1, 2],
	);
	assert.equal(aggregate.byDay[1].cacheReadShare, 10740 / 32822);

	assert.deepEqual(
		aggregate.byModel.map((bucket) => bucket.key),
		["deepseek-v4-flash", "glm5.3-flash"],
	);
	assert.deepEqual(aggregate.byModel[0].totals, {
		input: 25779,
		output: 193,
		cacheRead: 50240,
		cacheWrite: 0,
		reasoning: 29,
		totalTokens: 76212,
	});
	assert.deepEqual(aggregate.byModel[1].totals, {
		input: 1000,
		output: 200,
		cacheRead: 500,
		cacheWrite: 10,
		reasoning: 0,
		totalTokens: 1710,
	});

	assert.deepEqual(
		aggregate.bySource.map((bucket) => bucket.key),
		["subagent", "orchestrator"],
	);
	assert.deepEqual(aggregate.bySource[0].totals, {
		input: 5000,
		output: 100,
		cacheRead: 40000,
		cacheWrite: 0,
		reasoning: 20,
		totalTokens: 45100,
	});
	assert.deepEqual(aggregate.bySource[1].totals, {
		input: 21779,
		output: 293,
		cacheRead: 10740,
		cacheWrite: 10,
		reasoning: 9,
		totalTokens: 32822,
	});

	assert.deepEqual(
		aggregate.byProject.map((bucket) => bucket.key),
		["agent 1", "demo"],
	);
	assert.deepEqual(
		aggregate.byProject.map((bucket) => bucket.turns),
		[1, 2],
	);
});

test("skips malformed lines and non-assistant messages without throwing", (t) => {
	const fixture = makeAgentFixture();
	fixture.write(`sessions/${ORCHESTRATOR_DIR}/broken.jsonl`, [
		sessionRecord("2026-11-10T09:00:00.000Z", "G:\\Proyectos\\demo"),
		// Truncated mid-object, exactly what an interrupted write leaves behind.
		'{"type":"message","message":{"role":"assistant","model":"m1","usage":{"input":100,',
		"not json at all",
		nestedTurn({
			timestamp: "2026-11-10T10:00:00.000Z",
			model: "m1",
			input: 100,
			output: 50,
			cacheRead: 25,
			cacheWrite: 5,
			reasoning: 2,
			totalTokens: 180,
		}),
		userRecord("2026-11-10T10:01:00.000Z"),
		toolResultRecord("2026-11-10T10:02:00.000Z"),
		'{"type":"message","message":{"role":"system","content":"rules"}}',
		JSON.stringify({ type: "model_change", provider: "x", modelId: "y", timestamp: "2026-11-10T10:03:00.000Z" }),
		JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low", timestamp: "2026-11-10T10:04:00.000Z" }),
		JSON.stringify({ type: "custom", customType: "note", data: { any: true }, timestamp: "2026-11-10T10:05:00.000Z" }),
		// Assistant message with no usage: nothing to count.
		JSON.stringify({
			type: "message",
			timestamp: "2026-11-10T10:06:00.000Z",
			message: { role: "assistant", model: "m1", content: [{ type: "text", text: "hi" }] },
		}),
	]);
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });

	assert.equal(aggregate.turns, 1);
	assert.equal(aggregate.sessions, 1);
	assert.deepEqual(aggregate.totals, {
		input: 100,
		output: 50,
		cacheRead: 25,
		cacheWrite: 5,
		reasoning: 2,
		totalTokens: 180,
	});
	assert.deepEqual(
		aggregate.byDay.map((bucket) => bucket.key),
		["2026-11-10"],
	);
});

test("counts a flat role/usage record defensively", (t) => {
	const fixture = makeAgentFixture();
	fixture.write(`sessions/${ORCHESTRATOR_DIR}/flat.jsonl`, [
		sessionRecord("2026-11-10T09:00:00.000Z", "G:\\Proyectos\\demo"),
		JSON.stringify({
			type: "message",
			id: "flat-1",
			timestamp: "2026-11-10T10:00:00.000Z",
			role: "assistant",
			provider: "qwen-token-plan",
			model: "qwen3-coder-plus",
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 12 },
		}),
	]);
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });

	assert.equal(aggregate.turns, 1);
	assert.deepEqual(aggregate.totals, {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 1,
		totalTokens: 12,
	});
	assert.deepEqual(
		aggregate.byModel.map((bucket) => bucket.key),
		["qwen3-coder-plus"],
	);
	assert.equal(aggregate.cacheReadShare, 0);
});

// The correctness defect this unit fixes: the aggregate used to be reported as
// if every local turn went through `qwen-token-plan`, so the usage panel showed
// 917M tokens of total local traffic as the Qwen plan's consumption.
test("buckets per provider and keeps another provider's turns out of the qwen plan", (t) => {
	const fixture = makeAgentFixture();
	fixture.write(`sessions/${ORCHESTRATOR_DIR}/mixed.jsonl`, [
		sessionRecord("2026-11-09T09:00:00.000Z", "G:\\Proyectos\\demo"),
		nestedTurn({
			timestamp: "2026-11-09T10:00:00.000Z",
			provider: "nan",
			model: "deepseek-v4-flash",
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
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });

	// Sorted by tokens desc, so the heavy non-Qwen traffic comes first.
	assert.deepEqual(
		aggregate.byProvider.map((bucket) => bucket.key),
		["nan", "qwen-token-plan"],
	);
	assert.deepEqual(aggregate.byProvider[0].totals, {
		input: 2000,
		output: 1000,
		cacheRead: 197000,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 200000,
	});
	assert.equal(aggregate.byProvider[0].turns, 1);
	assert.deepEqual(aggregate.byProvider[1].totals, {
		input: 100,
		output: 50,
		cacheRead: 850,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 1000,
	});
	assert.equal(aggregate.byProvider[1].turns, 1);

	// The all-providers total still counts everything; only the qwen subset shrinks.
	assert.equal(aggregate.totals.totalTokens, 201000);
	const qwen = providerBucket(aggregate, "qwen-token-plan");
	assert.ok(qwen);
	assert.equal(qwen.turns, 1);
	assert.equal(qwen.totals.totalTokens, 1000);
	assert.equal(qwen.totals.cacheRead, 850);
	assert.equal(qwen.cacheReadShare, 0.85);
});

test("buckets a record with no provider field under unknown, never under the qwen plan", (t) => {
	const fixture = makeAgentFixture();
	fixture.write(`sessions/${ORCHESTRATOR_DIR}/no-provider.jsonl`, [
		sessionRecord("2026-11-09T09:00:00.000Z", "G:\\Proyectos\\demo"),
		providerlessTurn({
			timestamp: "2026-11-09T10:00:00.000Z",
			model: "qwen3-coder-plus",
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 5,
			totalTokens: 120,
		}),
	]);
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });

	assert.deepEqual(
		aggregate.byProvider.map((bucket) => bucket.key),
		["unknown"],
	);
	assert.equal(providerBucket(aggregate, "unknown")?.turns, 1);
	assert.equal(providerBucket(aggregate, "qwen-token-plan"), undefined);
	assert.equal(aggregate.totals.totalTokens, 120);
});

// The ambiguity trap: `deepseek-v4-flash` is in both the `nan` and the
// `qwen-token-plan` catalogues, so catalog membership must never attribute a
// turn. Only the record's own `provider` field may.
test("does not attribute a shared model id to the qwen plan when the record says nan", (t) => {
	const fixture = makeAgentFixture();
	fixture.write(`sessions/${ORCHESTRATOR_DIR}/trap.jsonl`, [
		sessionRecord("2026-11-09T09:00:00.000Z", "G:\\Proyectos\\demo"),
		nestedTurn({
			timestamp: "2026-11-09T10:00:00.000Z",
			provider: "nan",
			model: "deepseek-v4-flash",
			input: 10,
			output: 5,
			cacheRead: 900,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 915,
		}),
	]);
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });

	assert.deepEqual(
		aggregate.byModel.map((bucket) => bucket.key),
		["deepseek-v4-flash"],
	);
	assert.equal(providerBucket(aggregate, "qwen-token-plan"), undefined);
	assert.equal(providerBucket(aggregate, "nan")?.turns, 1);
});

test("reports no data for a missing or empty agent directory", () => {
	const missing = aggregateSessions({ agentDir: "/definitely/not/a/real/agent/dir", days: 7 });

	assert.equal(missing.turns, 0);
	assert.equal(missing.sessions, 0);
	assert.deepEqual(missing.totals, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
	});
	assert.equal(missing.cacheReadShare, 0);
	assert.deepEqual(missing.byDay, []);
	assert.deepEqual(missing.byModel, []);
	assert.deepEqual(missing.bySource, []);
	assert.deepEqual(missing.byProject, []);
	assert.deepEqual(missing.byProvider, []);
	assert.equal(missing.from, null);
	assert.equal(missing.to, null);

	const fixture = makeAgentFixture();
	try {
		const empty = aggregateSessions({ agentDir: fixture.dir, days: 7 });
		assert.equal(empty.turns, 0);
		assert.equal(empty.sessions, 0);
	} finally {
		fixture.cleanup();
	}
});

test("windows the aggregate to the last N local days", (t) => {
	const fixture = bothRoots();
	t.after(() => fixture.cleanup());

	const aggregate = aggregateSessions({
		agentDir: fixture.dir,
		days: 1,
		now: Date.parse("2026-11-09T12:00:00.000Z"),
	});

	assert.equal(aggregate.turns, 2);
	assert.equal(aggregate.sessions, 1);
	assert.equal(aggregate.totals.totalTokens, 32822);
	assert.deepEqual(
		aggregate.byDay.map((bucket) => bucket.key),
		["2026-11-09"],
	);
});

// resolveAgentDir default for a general Pi audience: gentle-shell keeps its
// agent dir, plain Pi uses ~/.pi/agent. The default must follow whichever
// actually exists, and explicit configuration must always win.
test("resolveAgentDir prefers an existing gentle-shell dir, then an existing .pi dir", async (t) => {
	const { resolveAgentDir } = await import("../src/sessions.ts");
	const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const home = mkdtempSync(join(tmpdir(), "qwen-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));

	const piDir = join(home, ".pi", "agent");
	const gsDir = join(home, ".gentle-shell", "agent");

	// explicit option wins over everything
	assert.equal(resolveAgentDir({ agentDir: "/somewhere/else", env: {} }), "/somewhere/else");

	// env wins over detection
	assert.equal(resolveAgentDir({ env: { PI_QWENCLOUD_AGENT_DIR: "/env/dir" } }), "/env/dir");

	// neither exists yet: the plain-Pi standard location is the default
	assert.equal(resolveAgentDir({ env: {}, home }), piDir);

	// only .pi exists -> .pi
	mkdirSync(piDir, { recursive: true });
	assert.equal(resolveAgentDir({ env: {}, home }), piDir);

	// both exist -> gentle-shell wins (it is the tuned host)
	mkdirSync(gsDir, { recursive: true });
	assert.equal(resolveAgentDir({ env: {}, home }), gsDir);
});
