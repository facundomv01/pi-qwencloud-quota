import { USAGE_PROVIDER } from "./usage-source.ts";
import type { PiProviderResponseEvent } from "./types.ts";

// Change B: the only quota signal that exists without credentials.
//
// The `qwen-token-plan` inference endpoint exposes no quota or rate-limit
// response headers (a live read-only `/v1/models` probe returned only
// content-type, date, x-request-id and `server: istio-envoy`). The one real
// signal is the exhaustion response itself: HTTP 429 with
// `Retry-After: <seconds>` and body
// `{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}`.
//
// So this module reads exactly two things off a response: the status and the
// `Retry-After` header — plus an error type when the event exposes one instead
// of a body. It keeps them in memory only: no disk, no request body, no
// response body, no credential. Nothing here may throw, because the hook runs
// inside someone's live session.

/** How long an exhaustion with no usable reset time stays visible. */
export const UNKNOWN_RESET_TTL_MS = 3_600_000;

const INSUFFICIENT_QUOTA = "insufficient_quota";

export interface ExhaustionRecord {
	/** The provider that reported it, when the event could name one. */
	provider?: string;
	/** Epoch ms of the response that reported it. */
	observedAt: number;
	/** Reset time derived from `Retry-After`, or null when absent or unparseable. */
	resetAt: number | null;
}

export interface ExhaustionTracker {
	/**
	 * Feed one provider response. A non-429 response never touches the state;
	 * a 429 records the exhaustion and returns the resulting record (or
	 * undefined when the record was already expired).
	 */
	observe(event: PiProviderResponseEvent | undefined, provider?: string): ExhaustionRecord | undefined;
	/** The current record, or undefined once its reset time (or TTL) has passed. */
	current(): ExhaustionRecord | undefined;
}

function headerValue(headers: PiProviderResponseEvent["headers"], name: string): string | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== target) continue;
		if (typeof value === "string") return value.trim();
		// A transport may hand back a repeated header as an array.
		if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
	}
	return undefined;
}

// `Retry-After` is seconds in the Token Plan exhaustion response. A missing,
// malformed or negative value yields an unknown reset instead of a guess.
function resetAtFrom(headers: PiProviderResponseEvent["headers"], observedAt: number): number | null {
	const raw = headerValue(headers, "retry-after");
	if (!raw) return null;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return observedAt + seconds * 1000;
	// The other RFC form is an HTTP date; accept it rather than discarding a
	// signal that is merely formatted differently.
	const date = Date.parse(raw);
	return Number.isFinite(date) ? date : null;
}

function isExhaustion(event: PiProviderResponseEvent | undefined): boolean {
	if (!event || typeof event !== "object") return false;
	if (event.status === 429) return true;
	const candidates: unknown[] = [event.errorType, event.type, event.error?.type, event.error?.code];
	return candidates.some((value) => typeof value === "string" && value.trim() === INSUFFICIENT_QUOTA);
}

function providerOf(explicit: string | undefined, event: PiProviderResponseEvent | undefined): string | undefined {
	const raw =
		typeof explicit === "string" && explicit.trim().length > 0
			? explicit.trim()
			: typeof event?.provider === "string" && event.provider.trim().length > 0
				? event.provider.trim()
				: "";
	return raw.length > 0 ? raw : undefined;
}

export function createExhaustionTracker(
	now: () => number,
	unknownResetTtlMs = UNKNOWN_RESET_TTL_MS,
): ExhaustionTracker {
	let record: ExhaustionRecord | undefined;

	const current = (): ExhaustionRecord | undefined => {
		if (!record) return undefined;
		const at = now();
		const expired = record.resetAt !== null ? at >= record.resetAt : at - record.observedAt >= unknownResetTtlMs;
		if (expired) record = undefined;
		return record;
	};

	return {
		observe(event, provider) {
			try {
				if (!isExhaustion(event)) return current();
				const owner = providerOf(provider, event);
				// The hook fires for every provider. A 429 from another one says
				// nothing about Qwen quota, and recording it as such would repeat the
				// misattribution the provider buckets exist to prevent. With no
				// provider at all the signal itself is still worth showing.
				if (owner !== undefined && owner !== USAGE_PROVIDER) return current();
				const observedAt = now();
				const resetAt = resetAtFrom(event?.headers, observedAt);
				record = owner === undefined ? { observedAt, resetAt } : { provider: owner, observedAt, resetAt };
				return current();
			} catch {
				// A hook must never reject into the session.
				return current();
			}
		},
		current,
	};
}
