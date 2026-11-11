import { aggregateSessions, resolveAgentDir, resolveDays } from "./sessions.ts";
import { STATUS_ID, renderStatusWidget, renderSummary } from "./summary.ts";
import type { PiApi, PiUi, PiActionContext } from "./types.ts";
import { USAGE_SOURCE_EVENT, buildUsageSource } from "./usage-source.ts";

export const COMMAND_NAME = "qwen-quota";
export const COMMAND_DESCRIPTION = "Show local QwenCloud Token Plan token usage";

export interface QuotaOptions {
	agentDir?: string;
	days?: number;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

// Wires the three surfaces this package owns: the usage-source event gentle-shell
// already knows how to render, a `/qwen-quota` summary, and a one-line status.
// Everything is best-effort: no credential and no session data must never break
// a session, so every path swallows its own failures.
export function registerQuotaExtension(pi: PiApi, options: QuotaOptions = {}): void {
	const env = options.env ?? process.env;
	const agentDir = resolveAgentDir({ agentDir: options.agentDir, env });
	const days = resolveDays({ days: options.days, env });
	const clock = options.now ?? (() => Date.now());

	const refreshStatus = (ui: PiUi): void => {
		try {
			const aggregate = aggregateSessions({ agentDir, days, now: clock() });
			ui.setStatus(STATUS_ID, renderStatusWidget(aggregate));
		} catch {
			// A status row is never worth an error in someone's session.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			// Re-registering is a no-op in effect: gentle-shell replaces the source
			// for the same provider, so emitting on every start is safe.
			pi.events?.emit(USAGE_SOURCE_EVENT, buildUsageSource({ agentDir, days, env }));
		} catch {
			// The command below still works without the hook.
		}
		refreshStatus(ctx.ui);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: PiActionContext) => {
			let message: string;
			try {
				const aggregate = aggregateSessions({ agentDir, days, now: clock() });
				message = renderSummary(aggregate, { agentDir, days, env });
			} catch (error) {
				message = `qwen-quota: could not read local sessions (${error instanceof Error ? error.message : "unknown error"})`;
			}
			ctx.ui.notify(message, "info");
		},
	});
}
