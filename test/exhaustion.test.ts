import assert from "node:assert/strict";
import { test } from "node:test";
import { UNKNOWN_RESET_TTL_MS, createExhaustionTracker } from "../src/exhaustion.ts";

// Change B. The only credential-free quota signal is the exhaustion response
// itself: HTTP 429 with `Retry-After`, or an event that exposes
// `insufficient_quota`. Nothing here reads, stores or prints a body or a
// credential, and the state lives in memory only.
const START = Date.parse("2026-11-09T12:00:00.000Z");

test("records a 429 as exhaustion with the reset time Retry-After names", () => {
	let now = START;
	const tracker = createExhaustionTracker(() => now);

	const record = tracker.observe({ status: 429, headers: { "retry-after": "3600" } }, "qwen-token-plan");

	assert.ok(record);
	assert.equal(record.observedAt, START);
	assert.equal(record.resetAt, START + 3_600_000);
	assert.equal(record.provider, "qwen-token-plan");
	// Same record on the next read: nothing recomputes the reset.
	assert.equal(tracker.current(), record);
});

test("a non-429 response never touches the recorded state", () => {
	let now = START;
	const tracker = createExhaustionTracker(() => now);

	// Nothing recorded yet: a 200 creates nothing.
	tracker.observe({ status: 200, headers: { "retry-after": "3600" } }, "qwen-token-plan");
	assert.equal(tracker.current(), undefined);

	const recorded = tracker.observe({ status: 429, headers: { "retry-after": "3600" } }, "qwen-token-plan");
	assert.ok(recorded);
	now += 60_000;

	// A later healthy response must not clear or rewrite it.
	const after = tracker.observe({ status: 200, headers: {} }, "qwen-token-plan");
	assert.equal(after, recorded);
	assert.equal(tracker.current(), recorded);
	assert.equal(tracker.current()?.observedAt, START);
	assert.equal(tracker.current()?.resetAt, START + 3_600_000);
});

test("a missing or malformed Retry-After records exhaustion with an unknown reset and never throws", () => {
	const missing = createExhaustionTracker(() => START).observe({ status: 429, headers: {} }, "qwen-token-plan");
	assert.ok(missing);
	assert.equal(missing.resetAt, null);
	assert.equal(missing.observedAt, START);

	const garbage = createExhaustionTracker(() => START).observe(
		{ status: 429, headers: { "retry-after": "soon-ish" } },
		"qwen-token-plan",
	);
	assert.ok(garbage);
	assert.equal(garbage.resetAt, null);

	const negative = createExhaustionTracker(() => START).observe(
		{ status: 429, headers: { "retry-after": "-30" } },
		"qwen-token-plan",
	);
	assert.ok(negative);
	assert.equal(negative.resetAt, null);

	// Malformed events are tolerated, not fatal.
	const tracker = createExhaustionTracker(() => START);
	assert.doesNotThrow(() => tracker.observe(undefined as never, undefined));
	assert.doesNotThrow(() => tracker.observe({ status: 429, headers: null as never }, "qwen-token-plan"));
	assert.ok(tracker.current());
});

test("expires the record once the reset time passes", () => {
	let now = START;
	const tracker = createExhaustionTracker(() => now);
	tracker.observe({ status: 429, headers: { "retry-after": "60" } }, "qwen-token-plan");

	now = START + 59_000;
	assert.ok(tracker.current());
	now = START + 60_000;
	assert.equal(tracker.current(), undefined);
});

test("ages out an exhaustion whose reset time is unknown", () => {
	let now = START;
	const tracker = createExhaustionTracker(() => now);
	tracker.observe({ status: 429, headers: {} }, "qwen-token-plan");

	now = START + UNKNOWN_RESET_TTL_MS - 1;
	assert.ok(tracker.current());
	now = START + UNKNOWN_RESET_TTL_MS;
	assert.equal(tracker.current(), undefined);
});

// The hook fires for every provider, so a 429 elsewhere says nothing about
// Qwen quota. Recording it as Qwen exhaustion would be the same class of
// misattribution the provider buckets exist to prevent.
test("ignores another provider's 429 but records one from an unidentified provider", () => {
	const tracker = createExhaustionTracker(() => START);

	assert.equal(tracker.observe({ status: 429, headers: { "retry-after": "3600" } }, "nan"), undefined);
	assert.equal(tracker.current(), undefined);

	// Without a provider the hook cannot tell, so the honest record is the signal itself.
	const unknown = tracker.observe({ status: 429, headers: { "retry-after": "3600" } }, undefined);
	assert.ok(unknown);
	assert.equal(unknown.provider, undefined);
});

test("records an event that exposes insufficient_quota without a 429 status", () => {
	const record = createExhaustionTracker(() => START).observe(
		{ status: 400, error: { type: "insufficient_quota" } },
		"qwen-token-plan",
	);

	assert.ok(record);
	assert.equal(record.resetAt, null);
});
