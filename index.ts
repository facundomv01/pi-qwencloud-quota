// Pi package entry point. Pi discovers this through the `pi.extensions` manifest
// in package.json and calls the default export with its ExtensionAPI.
import { registerQuotaExtension } from "./src/extension.ts";
import type { PiApi } from "./src/types.ts";

export { registerQuotaExtension } from "./src/extension.ts";
export { aggregateSessions, parseSessionLine, providerBucket, resolveAgentDir, AGENT_DIR_ENV } from "./src/sessions.ts";
export { buildUsageSource, USAGE_PROVIDER, USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "./src/usage-source.ts";
export { createExhaustionTracker, UNKNOWN_RESET_TTL_MS } from "./src/exhaustion.ts";
export { renderExhaustion, renderStatusWidget, renderSummary, STATUS_ID } from "./src/summary.ts";
export { readCredits, readCreditsCredentials } from "./src/credits.ts";

export default function piQwenCloudQuota(pi: PiApi): void {
	registerQuotaExtension(pi);
}
