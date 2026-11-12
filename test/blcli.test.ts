import assert from "node:assert/strict";
import { test } from "node:test";
import { BL_BIN_ENV, BL_REGION_ENV, BL_SITE_ENV, fetchBlUsage, parseBlPayload } from "../src/blcli.ts";
import type { BlRunnerResult } from "../src/blcli.ts";

const ENV = {};

interface RecordedCall {
	cmd: string;
	args: string[];
}

function scriptedRunner(script: Array<BlRunnerResult | { throws: unknown }>): {
	calls: RecordedCall[];
	runner: (cmd: string, args: string[]) => Promise<BlRunnerResult>;
} {
	const calls: RecordedCall[] = [];
	let index = 0;
	const runner = async (cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		const step = script[Math.min(index, script.length - 1)];
		index++;
		if ("throws" in step) throw step.throws;
		return step;
	};
	return { calls, runner };
}

const OK = (stdout: string): BlRunnerResult => ({ ok: true, code: 0, stdout, stderr: "" });
const ENOENT: BlRunnerResult = { ok: false, code: "ENOENT", stdout: "", stderr: "spawn bl ENOENT" };
const AUTH_FAIL: BlRunnerResult = { ok: false, code: 1, stdout: "", stderr: "not authenticated" };

// The sanitized live fixture verified in CodexBar issue #3020.
const LIVE_JSON = JSON.stringify({ per1WeekPercentage: 0.7, per1WeekResetTime: 1787001180000 });

test("parses the verified live shape: fractional ratios become percents, epoch-ms resets pass through", () => {
	const payload = parseBlPayload(LIVE_JSON);
	assert.equal(payload.windows.length, 1);
	assert.deepEqual(payload.windows[0], { key: "weekly", usedPercent: 70, resetAt: 1787001180000 });
});

test("parses every allowlisted window independently, at any depth", () => {
	const payload = parseBlPayload(
		JSON.stringify({
			nested: {
				per5HourPercentage: 0.12,
				per5HourResetTime: 1000,
				per1WeekPercentage: 0.7,
				per1WeekResetTime: 2000,
			},
			per1MonthPercentage: 0.032,
			per1MonthResetTime: 3000,
		}),
	);
	assert.deepEqual(payload.windows, [
		{ key: "5-hour", usedPercent: 12, resetAt: 1000 },
		{ key: "weekly", usedPercent: 70, resetAt: 2000 },
		{ key: "monthly", usedPercent: 3.2, resetAt: 3000 },
	]);
});

test("a value already in percent (1..100] is not multiplied by 100", () => {
	const payload = parseBlPayload(JSON.stringify({ per1WeekPercentage: 70 }));
	assert.equal(payload.windows[0].usedPercent, 70);
});

test("malformed and non-object payloads yield no windows", () => {
	assert.equal(parseBlPayload("not json").windows.length, 0);
	assert.equal(parseBlPayload("[1,2,3]").windows.length, 0);
	assert.equal(parseBlPayload("{}").windows.length, 0);
});

test("runs the usage command first with fixed argv, region and site from env", async () => {
	const { calls, runner } = scriptedRunner([OK(LIVE_JSON)]);
	await fetchBlUsage(
		{ [BL_REGION_ENV]: "ap-southeast-1", [BL_SITE_ENV]: "international", [BL_BIN_ENV]: "C:/tools/bl.exe" },
		{ runner, lookup: async () => undefined },
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, "C:/tools/bl.exe");
	assert.deepEqual(calls[0].args, [
		"usage",
		"token-plan",
		"--output",
		"json",
		"--console-region",
		"ap-southeast-1",
		"--console-site",
		"international",
	]);
});

test("an empty usage JSON (monthly-only account, issue #231) falls back to the console-call API", async () => {
	const { calls, runner } = scriptedRunner([
		OK("{}"),
		OK(JSON.stringify({ data: { per1MonthPercentage: 0.028, per1MonthResetTime: 1790000000000 } })),
	]);
	const usage = await fetchBlUsage(ENV, { runner, lookup: async () => undefined });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].args, [
		"console",
		"call",
		"--api",
		"zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
		"--data",
		"{}",
		"--output",
		"json",
		"--console-region",
		"ap-southeast-1",
		"--console-site",
		"international",
	]);
	assert.deepEqual(usage.windows, [{ key: "monthly", usedPercent: 2.8, resetAt: 1790000000000 }]);
	assert.equal(usage.source, "console-call");
});

test("a missing binary degrades into an explicit not-found message without a fallback", async () => {
	const { calls, runner } = scriptedRunner([ENOENT]);
	const usage = await fetchBlUsage(ENV, { runner });
	assert.equal(calls.length, 1);
	assert.equal(usage.windows.length, 0);
	assert.equal(usage.source, "unavailable");
	assert.match(usage.message, /bl (CLI )?not found/i);
	assert.match(usage.message, /auth login/);
});

test("an auth failure tries the fallback and then degrades without throwing", async () => {
	const { runner } = scriptedRunner([AUTH_FAIL, AUTH_FAIL]);
	const usage = await fetchBlUsage(ENV, { runner });
	assert.equal(usage.windows.length, 0);
	assert.equal(usage.source, "unavailable");
	assert.match(usage.message, /query failed|auth/i);
});

test("a thrown runner (timeout, spawn crash) degrades into an unavailable snapshot", async () => {
	const { runner } = scriptedRunner([{ throws: new Error("killed") }]);
	const usage = await fetchBlUsage(ENV, { runner });
	assert.equal(usage.windows.length, 0);
	assert.equal(usage.source, "unavailable");
	assert.ok(!usage.message.includes("killed"), "runner internals must not leak into the message");
});

// Wiring: the summary renders one bl line; the usage panel prefers bl windows.
// A reset within 24h of the clock renders as HH:MM, further out as a date.
test("renderSummary surfaces the bl line when the CLI reported windows", async (t) => {
	const { renderSummary } = await import("../src/summary.ts");
	const { aggregateSessions, seed: _seed } = { aggregateSessions: (await import("../src/sessions.ts")).aggregateSessions, seed: null };
	const helpers = await import("./helpers.ts");
	const fixture = helpers.makeAgentFixture();
	t.after(() => fixture.cleanup());
	helpers.seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const now = Date.parse("2026-11-09T12:00:00.000Z");
	const text = renderSummary(aggregate, {
		agentDir: fixture.dir,
		days: 0,
		env: {},
		now: () => now,
		bl: {
			windows: [
				{ key: "5-hour", usedPercent: 12, resetAt: now + 3_600_000 },
				{ key: "monthly", usedPercent: 2.8, resetAt: Date.parse("2026-12-12T13:00:00Z") },
			],
			source: "usage",
			message: "bl",
		},
	});

	assert.match(text, /^Individual plan \(bl CLI\): 5-hour 12\.0% · resets \d{2}:\d{2} · monthly 2\.8% · resets 2026-12-12$/m);
});

test("renderSummary omits the bl line when the CLI reported nothing", async (t) => {
	const { renderSummary } = await import("../src/summary.ts");
	const { aggregateSessions } = await import("../src/sessions.ts");
	const fixture = (await import("./helpers.ts")).makeAgentFixture();
	t.after(() => fixture.cleanup());
	(await import("./helpers.ts")).seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const text = renderSummary(aggregate, {
		agentDir: fixture.dir,
		days: 0,
		env: {},
		bl: { windows: [], source: "unavailable", message: "bl CLI not found" },
	});
	assert.ok(!text.includes("bl CLI)"));
});

// The user must be told exactly when and what to do: an unavailable CLI (not
// installed, or not logged in) renders its actionable one-line message in the
// modal instead of disappearing silently.
test("renderSummary shows the bl setup hint when the CLI is unavailable", async (t) => {
	const { renderSummary } = await import("../src/summary.ts");
	const { aggregateSessions } = await import("../src/sessions.ts");
	const helpers = await import("./helpers.ts");
	const fixture = helpers.makeAgentFixture();
	t.after(() => fixture.cleanup());
	helpers.seedKnownAgent(fixture);

	const aggregate = aggregateSessions({ agentDir: fixture.dir, days: 0 });
	const text = renderSummary(aggregate, {
		agentDir: fixture.dir,
		days: 0,
		env: {},
		bl: { windows: [], source: "unavailable", message: 'bl CLI not found · install bailian-cli and run "bl auth login --console" once' },
	});

	assert.match(text, /^bl CLI not found · install bailian-cli/m);
});

// The bare login defaults to the China console; an international user (like
// this package's Singapore default) must be told the site-aware command.
test("the not-logged-in hint names the international site and region when applicable", async () => {
	const { runner } = scriptedRunner([AUTH_FAIL, AUTH_FAIL]);
	const usage = await fetchBlUsage(ENV, { runner });
	assert.match(usage.message, /bl auth login --console --console-site international --console-region ap-southeast-1/);

	const domestic = await fetchBlUsage({ [BL_SITE_ENV]: "domestic" }, { runner: scriptedRunner([AUTH_FAIL, AUTH_FAIL]).runner });
	assert.match(domestic.message, /bl auth login --console --console-site domestic --console-region ap-southeast-1/);
});

// Windows: npm installs `bl` as a .cmd shim that execFile cannot spawn
// (CreateProcess does not resolve PATHEXT). The command must resolve to the
// underlying bailian.mjs entry and run under node — never via a shell.
test("resolveBlCommand passes through on non-Windows and for .mjs pins", async () => {
	const { resolveBlCommand } = await import("../src/blcli.ts");
	const plain = await resolveBlCommand("bl", ["usage", "token-plan"], "linux");
	assert.deepEqual(plain, { cmd: "bl", args: ["usage", "token-plan"] });

	const pinned = await resolveBlCommand("C:/tools/bailian.mjs", ["usage"], "win32");
	assert.equal(pinned.cmd, process.execPath);
	assert.deepEqual(pinned.args, ["C:/tools/bailian.mjs", "usage"]);
});

test("resolveBlCommand resolves the npm shim to the package entry on Windows", async () => {
	const { resolveBlCommand } = await import("../src/blcli.ts");
	const resolved = await resolveBlCommand("bl", ["usage", "token-plan"], "win32", async () => "C:/npm/node_modules/bailian-cli/dist/bailian.mjs");
	assert.equal(resolved.cmd, process.execPath);
	assert.deepEqual(resolved.args, ["C:/npm/node_modules/bailian-cli/dist/bailian.mjs", "usage", "token-plan"]);
});

test("resolveBlCommand falls back to the raw bin when no entry is found (surface the original failure)", async () => {
	const { resolveBlCommand } = await import("../src/blcli.ts");
	const fallback = await resolveBlCommand("bl", ["usage"], "win32", async () => undefined);
	assert.deepEqual(fallback, { cmd: "bl", args: ["usage"] });
});
