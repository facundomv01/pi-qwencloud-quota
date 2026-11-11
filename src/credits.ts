// Route B seam: remaining QwenCloud Token Plan Credits.
//
// Not implemented in this unit on purpose. Credits live behind Alibaba Cloud
// BssOpenAPI `GetSubscriptionStats`, which needs a RAM AccessKey ID + Secret —
// a different credential from the Token Plan API key Pi already holds (see the
// spec's S4). Unit 2 replaces `readCredits` with the OpenAPI call without
// changing any caller, and it must keep the same two promises this stub keeps:
// credentials come from the environment only, and their absence never throws
// and never prints a value.

export const CREDITS_ACCESS_KEY_ID_ENV = "ALIBABA_CLOUD_ACCESS_KEY_ID";
export const CREDITS_ACCESS_KEY_SECRET_ENV = "ALIBABA_CLOUD_ACCESS_KEY_SECRET";
export const CREDITS_REGION_ENV = "ALIBABA_CLOUD_REGION_ID";
export const CREDITS_DEFAULT_REGION = "ap-southeast-1";

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

export function readCreditsCredentials(env: Record<string, string | undefined>): CreditsCredentials | undefined {
	const accessKeyId = env[CREDITS_ACCESS_KEY_ID_ENV]?.trim();
	const accessKeySecret = env[CREDITS_ACCESS_KEY_SECRET_ENV]?.trim();
	if (!accessKeyId || !accessKeySecret) return undefined;
	const regionId = env[CREDITS_REGION_ENV]?.trim() || CREDITS_DEFAULT_REGION;
	return { accessKeyId, accessKeySecret, regionId };
}

// Presence is all this unit checks: the values are never printed, logged,
// stored, or returned anywhere outside this module.
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
		message: "Credits: route B recognised the credentials but is not implemented yet",
	};
}
