import assert from "node:assert/strict";
import { test } from "node:test";
import {
	USAGE_PROVIDER,
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
	buildUsageSource,
} from "../src/usage-source.ts";
import { KNOWN_NOW, makeAgentFixture, seedKnownAgent } from "./helpers.ts";

// Encode the validators gentle-pi already applies to a usage source, so the
// payload is checked against the real acceptance rules without importing
// gentle-pi (this package must stay dependency-free and publishable).
//
// Source: gentle-pi/lib/shell-usage.ts
//   parseUsageSource          lines 148-175  (schema, provider pattern, fetch, pendingNote)
//   parseProviderUsage        lines 240-254  (provider match, plan, fetchedAt, limits[])
//   parseSourceUsageLimit     lines 220-232  (name, limitReached, windows[])
//   parseSourceUsageWindow    lines 205-218  (label, usedPercent, windowSeconds, resetAt, used?, budget?)
const USAGE_SOURCE_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseUsageSourceLike(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schema !== USAGE_SOURCE_SCHEMA) return undefined;
	if (typeof raw.provider !== "string" || !USAGE_SOURCE_PROVIDER_PATTERN.test(raw.provider)) return undefined;
	if (typeof raw.fetch !== "function") return undefined;
	if (raw.pendingNote !== undefined && typeof raw.pendingNote !== "string") return undefined;
	return raw;
}

function parseWindowLike(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.label !== "string") return undefined;
	if (!isFiniteNumber(raw.usedPercent)) return undefined;
	if (!isFiniteNumber(raw.windowSeconds)) return undefined;
	if (raw.resetAt !== null && !isFiniteNumber(raw.resetAt)) return undefined;
	if (raw.used !== undefined && !isFiniteNumber(raw.used)) return undefined;
	if (raw.budget !== undefined && !isFiniteNumber(raw.budget)) return undefined;
	return raw;
}

function parseLimitLike(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string") return undefined;
	if (typeof raw.limitReached !== "boolean") return undefined;
	if (!Array.isArray(raw.windows)) return undefined;
	for (const window of raw.windows) if (!parseWindowLike(window)) return undefined;
	return raw;
}

function parseProviderUsageLike(value: unknown, expectedProvider: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.provider !== expectedProvider) return undefined;
	if (raw.plan !== undefined && typeof raw.plan !== "string") return undefined;
	if (!isFiniteNumber(raw.fetchedAt)) return undefined;
	if (!Array.isArray(raw.limits)) return undefined;
	for (const limit of raw.limits) if (!parseLimitLike(limit)) return undefined;
	return raw;
}

test("the emitted payload passes gentle-pi's usage-source validation", () => {
	const fixture = makeAgentFixture();
	try {
		seedKnownAgent(fixture);
		const payload = buildUsageSource({ agentDir: fixture.dir, days: 7, now: () => KNOWN_NOW });

		assert.deepEqual(Object.keys(payload).sort(), ["fetch", "pendingNote", "provider", "schema"]);
		assert.equal(payload.schema, USAGE_SOURCE_SCHEMA);
		assert.equal(payload.schema, "gentle-pi.usage-source/v1");
		assert.equal(payload.provider, USAGE_PROVIDER);
		assert.equal(payload.provider, "qwen-token-plan");
		assert.equal(USAGE_SOURCE_EVENT, "gentle-pi:usage-source/v1");
		assert.equal(typeof payload.fetch, "function");
		assert.equal(typeof payload.pendingNote, "string");
		// The Credits figure is route B's job; the note has to say so.
		const pendingNote = payload.pendingNote;
		if (typeof pendingNote !== "string") assert.fail("pendingNote must be a string");
		assert.match(pendingNote, /route B/);
		assert.match(pendingNote, /Credits/);
		// The real validator the shell runs on the event payload.
		assert.ok(parseUsageSourceLike(payload));
		// The validator is not a rubber stamp: a NaN percentage is rejected.
		assert.equal(
			parseProviderUsageLike(
				{ provider: USAGE_PROVIDER, limits: [{ name: "x", limitReached: false, windows: [{ label: "", usedPercent: Number.NaN, windowSeconds: 0, resetAt: null }] }], fetchedAt: 1 },
				USAGE_PROVIDER,
			),
			undefined,
		);
	} finally {
		fixture.cleanup();
	}
});

test("fetch resolves a ProviderUsage carrying raw token counts, never a fabricated percent", async () => {
	const fixture = makeAgentFixture();
	try {
		seedKnownAgent(fixture);
		const payload = buildUsageSource({ agentDir: fixture.dir, days: 7, now: () => KNOWN_NOW });
		const neverFetch = () => {
			throw new Error("route D must never touch the network");
		};

		const usage = await payload.fetch(undefined, neverFetch as never, KNOWN_NOW);

		assert.ok(usage);
		const accepted = parseProviderUsageLike(usage, USAGE_PROVIDER);
		assert.ok(accepted);
		assert.deepEqual(usage, {
			provider: "qwen-token-plan",
			plan: "local 7d · 77.9k tok · cacheRead 65.1%",
			// No server-side quota exists for a token plan, so no allowance is claimed
			// and no window invents a percentage or a reset time.
			limits: [{ name: "local", windows: [], limitReached: false }],
			fetchedAt: KNOWN_NOW,
		});
	} finally {
		fixture.cleanup();
	}
});

test("fetch resolves undefined when there is no local session data", async () => {
	const fixture = makeAgentFixture();
	try {
		const payload = buildUsageSource({ agentDir: fixture.dir, days: 7, now: () => KNOWN_NOW });
		const usage = await payload.fetch(undefined, (() => {
			throw new Error("no network");
		}) as never, KNOWN_NOW);
		assert.equal(usage, undefined);
	} finally {
		fixture.cleanup();
	}
});
