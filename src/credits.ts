// Route B: remaining QwenCloud Token Plan Credits via Alibaba Cloud's
// documented Model Studio OpenAPI `GetSubscriptionStats`
// (https://www.alibabacloud.com/help/en/model-studio/get-subscription-stats).
//
// This is the official, read-only, AccessKey-signed route the user explicitly
// chose (feature doc L10). It never scrapes the console, never touches the
// plan's inference key, and keeps the two promises this module has always
// kept: credentials come from the environment only, and their absence — or any
// failure — degrades into a one-line message that never throws and never
// prints, logs, stores, or returns a credential value.
import { createHash, createHmac, randomUUID } from "node:crypto";

export const CREDITS_ACCESS_KEY_ID_ENV = "ALIBABA_CLOUD_ACCESS_KEY_ID";
export const CREDITS_ACCESS_KEY_SECRET_ENV = "ALIBABA_CLOUD_ACCESS_KEY_SECRET";
export const CREDITS_REGION_ENV = "ALIBABA_CLOUD_REGION_ID";
export const CREDITS_DEFAULT_REGION = "ap-southeast-1";

// Frozen from the official doc: GET /tokenplan/subscription/stats,
// x-acs-action: GetSubscriptionStats, x-acs-version: 2026-02-10.
export const CREDITS_ENDPOINT_PATH = "/tokenplan/subscription/stats";
export const CREDITS_ACS_ACTION = "GetSubscriptionStats";
export const CREDITS_ACS_VERSION = "2026-02-10";
export const CREDITS_SIGNATURE_METHOD = "ACS3-HMAC-SHA256";
// The exact SignedHeaders set the doc's example pins, sorted byte-wise.
export const CREDITS_SIGNED_HEADERS =
	"host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version";

export interface CreditsCredentials {
	accessKeyId: string;
	accessKeySecret: string;
	regionId: string;
}

export interface CreditsStatus {
	configured: boolean;
	/** One line, ready to print. Never contains a credential value. */
	message: string;
}

/** Route B's parsed outcome; `remaining`/`total` exist only when the API reported them. */
export interface CreditsSnapshot extends CreditsStatus {
	/** Summed SeatRemainingCredits across seat groups, when any were reported. */
	remaining?: number;
	/** Summed SeatCredits across seat groups, when any were reported. */
	total?: number;
	/** Subscription start, epoch ms, when the API reported it. */
	subscriptionStart?: number;
	/** Subscription end, epoch ms, when the API reported it. */
	subscriptionEnd?: number;
	/**
	 * Cycle refresh time in epoch ms, only when every seat group's cycle end
	 * agrees (the same honesty rule CodexBar applies); `null` when the groups
	 * disagree, absent when the API reported nothing.
	 */
	resetAt?: number | null;
}

/** Injectable clock, nonce and transport so tests never touch the network. */
export interface CreditsDeps {
	fetchFn?: typeof fetch;
	now?: () => number;
	nonce?: () => string;
}

interface SeatItem {
	SeatCredits?: unknown;
	SeatRemainingCredits?: unknown;
	SeatRefreshTime?: unknown;
}

export function readCreditsCredentials(env: Record<string, string | undefined>): CreditsCredentials | undefined {
	const accessKeyId = env[CREDITS_ACCESS_KEY_ID_ENV]?.trim();
	const accessKeySecret = env[CREDITS_ACCESS_KEY_SECRET_ENV]?.trim();
	if (!accessKeyId || !accessKeySecret) return undefined;
	const regionId = env[CREDITS_REGION_ENV]?.trim() || CREDITS_DEFAULT_REGION;
	return { accessKeyId, accessKeySecret, regionId };
}

// Sync presence check kept for sync callers: the values are never printed,
// logged, stored, or returned anywhere outside this module.
export function readCredits(env: Record<string, string | undefined>): CreditsStatus {
	const credentials = readCreditsCredentials(env);
	if (!credentials) {
		return {
			configured: false,
			message: `Credits: not configured · route B needs ${CREDITS_ACCESS_KEY_ID_ENV} + ${CREDITS_ACCESS_KEY_SECRET_ENV}`,
		};
	}
	return {
		configured: true,
		message: "Credits: query pending · /qwen-quota fetches route B (official GetSubscriptionStats API)",
	};
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

// Alibaba Cloud ACS3-HMAC-SHA256, exactly as the GetSubscriptionStats doc
// prescribes: canonical request over (method, path, query, canonical headers,
// signed headers, hashed body), hashed again into the string-to-sign, HMAC'd
// with the secret. Zero dependencies beyond node:crypto.
export function buildCreditsAuthorization(credentials: CreditsCredentials, headers: Record<string, string>): string {
	const canonicalHeaders = Object.keys(headers)
		.sort()
		.map((name) => `${name}:${headers[name].trim()}\n`)
		.join("");
	const canonicalRequest = [
		"GET",
		CREDITS_ENDPOINT_PATH,
		"",
		canonicalHeaders,
		CREDITS_SIGNED_HEADERS,
		sha256Hex(""),
	].join("\n");
	const stringToSign = `${CREDITS_SIGNATURE_METHOD}\n${sha256Hex(canonicalRequest)}`;
	const signature = createHmac("sha256", credentials.accessKeySecret).update(stringToSign, "utf8").digest("hex");
	return `${CREDITS_SIGNATURE_METHOD} Credential=${credentials.accessKeyId},SignedHeaders=${CREDITS_SIGNED_HEADERS},Signature=${signature}`;
}

function finiteNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function successSnapshot(items: SeatItem[], data: StatsBody["Data"]): CreditsSnapshot {
	const totals: Array<number | undefined> = [];
	const remainings: Array<number | undefined> = [];
	const refreshTimes: Array<number | undefined> = [];
	for (const item of items) {
		totals.push(finiteNumber(item.SeatCredits));
		remainings.push(finiteNumber(item.SeatRemainingCredits));
		refreshTimes.push(finiteNumber(item.SeatRefreshTime));
	}
	const total = totals.every((value) => value !== undefined) ? totals.reduce((a, b) => a! + b!, 0) : undefined;
	const remaining = remainings.every((value) => value !== undefined)
		? remainings.reduce((a, b) => a! + b!, 0)
		: undefined;
	if (total === undefined || remaining === undefined) {
		return { configured: true, message: "Credits: subscription reported no usable seat figures" };
	}
	// A reset time is only honest when every seat group's cycle end agrees.
	const resetAt = refreshTimes.every((value) => value !== undefined)
		? refreshTimes.every((value) => value === refreshTimes[0])
			? refreshTimes[0]
			: null
		: null;
	const share = total > 0 ? ((total - remaining) / total) * 100 : 0;
	const reset = resetAt ? ` · resets ${new Date(resetAt).toISOString().slice(0, 10)}` : resetAt === null ? " · reset unknown" : "";
	const subscriptionStart = finiteNumber(data?.SubscriptionStartTime);
	const subscriptionEnd = finiteNumber(data?.SubscriptionEndTime);
	return {
		configured: true,
		remaining,
		total,
		subscriptionStart,
		subscriptionEnd,
		resetAt,
		message: `Credits: ${remaining} of ${total} remaining (${share.toFixed(1)}% used)${reset}`,
	};
}

function failureSnapshot(detail: string): CreditsSnapshot {
	return { configured: true, message: `Credits: query failed (${detail})` };
}

interface StatsBody {
	Success?: unknown;
	Code?: unknown;
	Message?: unknown;
	Data?: { SubscriptionStartTime?: unknown; SubscriptionEndTime?: unknown; Items?: unknown } | null;
}

export async function fetchCredits(
	env: Record<string, string | undefined>,
	deps: CreditsDeps = {},
): Promise<CreditsSnapshot> {
	const credentials = readCreditsCredentials(env);
	if (!credentials) {
		return {
			configured: false,
			message: `Credits: not configured · route B needs ${CREDITS_ACCESS_KEY_ID_ENV} + ${CREDITS_ACCESS_KEY_SECRET_ENV}`,
		};
	}
	const now = deps.now ?? Date.now;
	const nonce = deps.nonce ?? randomUUID;
	const fetchFn = deps.fetchFn ?? fetch;
	const host = `modelstudio.${credentials.regionId}.aliyuncs.com`;
	const url = `https://${host}${CREDITS_ENDPOINT_PATH}`;
	// The canonical Host header: what the signature covers, not a header we set.
	const date = new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
	const contentSha256 = sha256Hex("");
	const headers: Record<string, string> = {
		host,
		"x-acs-action": CREDITS_ACS_ACTION,
		"x-acs-content-sha256": contentSha256,
		"x-acs-date": date,
		"x-acs-signature-nonce": nonce(),
		"x-acs-version": CREDITS_ACS_VERSION,
	};
	const requestHeaders: Record<string, string> = { ...headers };
	delete requestHeaders.host;
	requestHeaders.authorization = buildCreditsAuthorization(credentials, headers);
	let response: { ok: boolean; status: number; text: () => Promise<string> };
	try {
		response = (await fetchFn(url, { method: "GET", headers: requestHeaders })) as typeof response;
	} catch {
		// The error object could in principle carry request material; it is
		// dropped entirely. The one-line message carries no detail at all.
		return failureSnapshot("network error");
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return failureSnapshot(`HTTP ${response.status}`);
	}
	let body: StatsBody | undefined;
	try {
		body = JSON.parse(text) as StatsBody;
	} catch {
		return failureSnapshot(`HTTP ${response.status}`);
	}
	if (!response.ok || body?.Success === false) {
		const code = typeof body?.Code === "string" && body.Code.length > 0 ? ` ${body.Code}` : "";
		return failureSnapshot(`HTTP ${response.status}${code}`);
	}
	const items = Array.isArray(body?.Data?.Items) ? (body.Data.Items as SeatItem[]) : [];
	if (items.length === 0) {
		// An Individual plan reports no seats. This is a real state of the API,
		// never "zero remaining": the honest label says so explicitly.
		return {
			configured: true,
			message: "Credits: no subscription data returned (this API reports seat-based plans; an Individual plan may not appear here)",
		};
	}
	return successSnapshot(items, body?.Data ?? null);
}
