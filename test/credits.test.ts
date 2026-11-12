import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDITS_ACCESS_KEY_ID_ENV, CREDITS_ACCESS_KEY_SECRET_ENV, CREDITS_REGION_ENV, fetchCredits, readCredits } from "../src/credits.ts";
import type { CreditsSnapshot } from "../src/credits.ts";

// Pinned ACS3-HMAC-SHA256 known-answer vector, computed by an independent
// one-off oracle implementing the documented algorithm literally (see the
// feature doc's L10). The client must reproduce it byte for byte for these
// exact inputs.
const AK = "test-access-key-id";
const SK = "test-access-key-secret";
const NOW = Date.parse("2026-01-01T12:00:00Z");
const NONCE = "fixed-nonce-0123456789abcdef";
const EXPECTED_AUTHORIZATION =
	"ACS3-HMAC-SHA256 Credential=test-access-key-id,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=d882f071374e517260bbe7203d6af388c3a07e56c86818e6a19f5b06eb8665e4";

const ENV = { [CREDITS_ACCESS_KEY_ID_ENV]: AK, [CREDITS_ACCESS_KEY_SECRET_ENV]: SK };

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function recordingFetch(body: unknown, responseInit?: { status?: number; contentType?: string }): {
	requests: RecordedRequest[];
	fetchFn: typeof fetch;
} {
	const requests: RecordedRequest[] = [];
	const status = responseInit?.status ?? 200;
	const fetchFn = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
		const url = typeof input === "string" ? input : (input as { url: string }).url;
		const options = init ?? (input as { method?: string; headers?: Record<string, string> }) ?? {};
		requests.push({
			url: String(url),
			method: options.method ?? "GET",
			headers: (options.headers ?? {}) as Record<string, string>,
		});
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => text,
		};
	}) as unknown as typeof fetch;
	return { requests, fetchFn };
}

test("a malformed region can only change the host, and the URL stays https", async () => {
	for (const region of ["http://evil.example", "cn-hangzhou/x", "\tcn", ""]) {
		const { requests, fetchFn } = recordingFetch({ Success: true, Data: { Items: [] } });
		const snapshot = await fetchCredits({ ...ENV, [CREDITS_REGION_ENV]: region }, { ...DEPS, fetchFn });
		assert.ok(requests[0].url.startsWith("https://"), `region ${JSON.stringify(region)} must stay https`);
		assert.ok(!snapshot.message.includes(SK));
	}
});

test("an injected dep resolving to a non-object degrades instead of throwing", async () => {
	await assert.doesNotReject(fetchCredits(ENV, { ...DEPS, fetchFn: (async () => undefined) as unknown as typeof fetch }));
	const snapshot = await fetchCredits(ENV, { ...DEPS, fetchFn: (async () => undefined) as unknown as typeof fetch });
	assert.match(snapshot.message, /query failed/);
});

test("a thrown non-Error carrying the secret never leaks it into the message", async () => {
	const fetchFn = (async () => {
		throw `${SK} connection refused`;
	}) as unknown as typeof fetch;
	const snapshot = await fetchCredits(ENV, { ...DEPS, fetchFn });
	assert.match(snapshot.message, /query failed/);
	assert.ok(!snapshot.message.includes(SK));
});

const DEPS = { now: () => NOW, nonce: () => NONCE };

test("missing credentials degrade silently: no fetch, no throw, message names the env vars", async () => {
	let called = 0;
	const fetchFn = (async () => {
		called++;
	}) as unknown as typeof fetch;
	const snapshot = await fetchCredits({}, { ...DEPS, fetchFn });
	assert.equal(snapshot.configured, false);
	assert.equal(called, 0);
	assert.match(snapshot.message, new RegExp(CREDITS_ACCESS_KEY_ID_ENV));
	assert.match(snapshot.message, new RegExp(CREDITS_ACCESS_KEY_SECRET_ENV));
});

test("readCredits stays synchronous and never throws without credentials", () => {
	const status = readCredits({});
	assert.equal(status.configured, false);
	assert.match(status.message, /Credits: not configured/);
});

test("signed request reproduces the documented ACS3 known-answer vector", async () => {
	const body = {
		Success: true,
		Data: {
			SubscriptionStartTime: NOW,
			SubscriptionEndTime: NOW + 30 * 24 * 3600 * 1000,
			Items: [
				{ SeatType: "standard", SeatRefreshTime: NOW + 30 * 24 * 3600 * 1000, TotalSeats: 1, AssignedSeats: 1, SeatCredits: 45000, SeatRemainingCredits: 43740 },
			],
		},
	};
	const { requests, fetchFn } = recordingFetch(body);
	const snapshot = await fetchCredits(ENV, { ...DEPS, fetchFn });
	assert.equal(requests.length, 1);
	const request = requests[0];
	assert.equal(request.method, "GET");
	assert.equal(request.url, "https://modelstudio.ap-southeast-1.aliyuncs.com/tokenplan/subscription/stats");
	assert.equal(request.headers["x-acs-action"], "GetSubscriptionStats");
	assert.equal(request.headers["x-acs-version"], "2026-02-10");
	assert.equal(request.headers["x-acs-date"], "2026-01-01T12:00:00Z");
	assert.equal(request.headers["x-acs-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(request.headers["x-acs-signature-nonce"], NONCE);
	assert.equal(request.headers["authorization"], EXPECTED_AUTHORIZATION);
	// A successful parse: remaining credits ride in the snapshot, and the
	// subscription period comes through for window math.
	assert.equal(snapshot.configured, true);
	assert.equal(snapshot.total, 45000);
	assert.equal(snapshot.remaining, 43740);
	assert.equal(snapshot.subscriptionStart, NOW);
	assert.equal(snapshot.subscriptionEnd, NOW + 30 * 24 * 3600 * 1000);
});

test("region env override switches the endpoint host", async () => {
	const { requests, fetchFn } = recordingFetch({ Success: true, Data: { Items: [] } });
	await fetchCredits({ ...ENV, [CREDITS_REGION_ENV]: "cn-hangzhou" }, { ...DEPS, fetchFn });
	assert.equal(requests[0].url, "https://modelstudio.cn-hangzhou.aliyuncs.com/tokenplan/subscription/stats");
});

test("multiple seat groups are summed; the reset only surfaces when every cycle end agrees", async () => {
	const { fetchFn } = recordingFetch({
		Success: true,
		Data: {
			Items: [
				{ SeatType: "standard", SeatRefreshTime: 5000, TotalSeats: 2, AssignedSeats: 1, SeatCredits: 100, SeatRemainingCredits: 40 },
				{ SeatType: "pro", SeatRefreshTime: 5000, TotalSeats: 1, AssignedSeats: 1, SeatCredits: 200, SeatRemainingCredits: 60 },
			],
		},
	});
	const snapshot = await fetchCredits(ENV, { ...DEPS, fetchFn });
	assert.equal(snapshot.total, 300);
	assert.equal(snapshot.remaining, 100);
	assert.equal(snapshot.resetAt, 5000);
	const { fetchFn: disagreeing } = recordingFetch({
		Success: true,
		Data: {
			Items: [
				{ SeatType: "standard", SeatRefreshTime: 5000, SeatCredits: 100, SeatRemainingCredits: 40 },
				{ SeatType: "pro", SeatRefreshTime: 9000, SeatCredits: 200, SeatRemainingCredits: 60 },
			],
		},
	});
	const other = await fetchCredits(ENV, { ...DEPS, fetchFn: disagreeing });
	assert.equal(other.remaining, 100);
	assert.equal(other.resetAt, null);
});

test("an empty Items list means no subscription data, never zero remaining", async () => {
	const { fetchFn } = recordingFetch({ Success: true, Data: { Items: [] } });
	const snapshot = await fetchCredits(ENV, { ...DEPS, fetchFn });
	assert.equal(snapshot.configured, true);
	assert.equal(snapshot.remaining, undefined);
	assert.equal(snapshot.total, undefined);
	assert.match(snapshot.message, /no subscription data/i);
});

test("a Success:false body renders the server Code without throwing", async () => {
	const { fetchFn } = recordingFetch({ Success: false, Code: "InvalidAccessKeyId.NotFound", Message: "The AccessKey does not exist" });
	const snapshot = await fetchCredits(ENV, { ...DEPS, fetchFn });
	assert.match(snapshot.message, /InvalidAccessKeyId\.NotFound/);
});

test("transport and server failures degrade into a one-line message that never leaks credentials", async () => {
	const failing = (async () => {
		throw new Error("connect ECONNREFUSED");
	}) as unknown as typeof fetch;
	const refused = await fetchCredits(ENV, { ...DEPS, fetchFn: failing });
	assert.match(refused.message, /query failed/);

	const { fetchFn: httpError } = recordingFetch({ Code: "SignatureDoesNotMatch" }, { status: 403 });
	const rejected = await fetchCredits(ENV, { ...DEPS, fetchFn: httpError });
	assert.match(rejected.message, /query failed|403/);

	const { fetchFn: garbage } = recordingFetch("<html>gateway timeout</html>", { status: 504 });
	const unparseable = await fetchCredits(ENV, { ...DEPS, fetchFn: garbage });
	assert.match(unparseable.message, /query failed|504/);

	for (const snapshot of [refused, rejected, unparseable]) {
		assert.ok(!snapshot.message.includes(SK), "the secret must never appear in any message");
		assert.ok(!snapshot.message.includes(AK), "the AccessKey id must never appear in any message");
	}
});

test("every returned message is credential-free no matter the outcome", async () => {
	const bodies: Array<[unknown, { status?: number } | undefined]> = [
		[{ Success: true, Data: { Items: [{ SeatType: "standard", SeatRefreshTime: 1, SeatCredits: 10, SeatRemainingCredits: 5 }] } }, undefined],
		[{ Success: true, Data: { Items: [] } }, undefined],
		[{ Success: false, Code: "X" }, undefined],
		[{ Code: "Y" }, { status: 400 }],
		["not json", undefined],
	];
	for (const [body, init] of bodies) {
		const { fetchFn } = recordingFetch(body, init);
		const snapshot: CreditsSnapshot = await fetchCredits(ENV, { ...DEPS, fetchFn });
		assert.ok(!snapshot.message.includes(SK));
		assert.ok(!snapshot.message.includes(AK));
	}
});
