import { aggregateSessions, resolveAgentDir, resolveDays } from "./sessions.ts";
import type { Aggregate } from "./sessions.ts";
import { createExhaustionTracker } from "./exhaustion.ts";
import { fetchCredits } from "./credits.ts";
import { STATUS_ID, renderStatusWidget, renderSummary } from "./summary.ts";
import type { PiApi, PiProviderResponseEvent, PiUi, PiActionContext } from "./types.ts";
import { USAGE_SOURCE_EVENT, buildUsageSource } from "./usage-source.ts";
import { createQuotaModal } from "./quota-modal.ts";

// A host-provided ui is only trusted when it actually carries the one method used
// at activation time; anything else is treated as "no ui reachable".
function isPiUi(value: unknown): value is PiUi {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PiUi).setStatus === "function" &&
		typeof (value as PiUi).setWidget === "function"
	);
}

export const COMMAND_NAME = "qwen-quota";
export const COMMAND_DESCRIPTION = "Show local QwenCloud Token Plan token usage";
// Clear the widget left by older versions when opening the modal.
export const QUOTA_WIDGET_ID = "qwen-quota";

export interface QuotaOptions {
	agentDir?: string;
	days?: number;
	env?: Record<string, string | undefined>;
	now?: () => number;
	/** Injectable transport for route B, so tests never touch the network. */
	fetchFn?: typeof fetch;
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
	const exhaustion = createExhaustionTracker(clock);

	const aggregate = (): Aggregate => aggregateSessions({ agentDir, days, now: clock() });

	const refreshStatus = (ui: PiUi): void => {
		try {
			ui.setStatus(STATUS_ID, renderStatusWidget(aggregate(), exhaustion.current()));
		} catch {
			// A status row is never worth an error in someone's session.
		}
	};

	// Announcing the source is best-effort and self-contained: a failure here must
	// never block activation, the hooks or the command registration below.
	const announceUsageSource = (): void => {
		try {
			// Re-registering is a no-op in effect: gentle-shell replaces the source
			// for the same provider, so emitting more than once is safe.
			pi.events?.emit(USAGE_SOURCE_EVENT, buildUsageSource({ agentDir, days, env }));
		} catch {
			// The command below still works without the hook.
		}
	};

	// Defect fix 1: emit once at ACTIVATION, not only on `session_start`. A
	// `/reload` re-activates this module without replaying `session_start`, so a
	// start-only emit left the previously registered closure (built from the old
	// module) in charge and the panel never updated.
	announceUsageSource();

	// The factory receives no `ctx`, and Pi's ExtensionAPI exposes no `ui`, so the
	// status row can only be painted here when some host happens to expose one.
	// When it does not, we skip in silence: never invent a ui object.
	const activationUi = (pi as { ui?: unknown }).ui;
	if (isPiUi(activationUi)) refreshStatus(activationUi);

	pi.on("session_start", (_event, ctx) => {
		announceUsageSource();
		refreshStatus(ctx.ui);
	});

	// Change B: the 429 the provider returns is the only quota signal available
	// without credentials, so it is the only thing this hook looks at. Nothing is
	// written to disk, no body or credential is read, and a failure here can
	// never reach the session.
	pi.on("after_provider_response", (event: PiProviderResponseEvent, ctx: PiActionContext) => {
		try {
			const before = exhaustion.current();
			const after = exhaustion.observe(event, ctx?.model?.provider);
			if (after && after !== before) refreshStatus(ctx.ui);
		} catch {
			// Never reject into the shell.
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: PiActionContext) => {
			let message: string;
			try {
				// Route B runs here, where an await is allowed: fetchCredits never
				// throws, and the `.catch` keeps that guarantee explicit.
				const credits = await fetchCredits(env, { fetchFn: options.fetchFn }).catch(() => undefined);
				message = renderSummary(aggregate(), {
					agentDir,
					days,
					env,
					exhaustion: exhaustion.current(),
					credits,
				});
			} catch (error) {
				message = `qwen-quota: could not read local sessions (${error instanceof Error ? error.message : "unknown error"})`;
			}

			try {
				ctx.ui.setWidget(QUOTA_WIDGET_ID, undefined);
			} catch {
				// A stale widget must not prevent opening the modal.
			}
			try {
				await ctx.ui.custom<void>((tui, _theme, keys, done) => createQuotaModal(tui, keys, () => done(), message), { overlay: true });
			} catch {
				try { ctx.ui.notify("qwen-quota: could not open the quota modal", "error"); } catch { /* best effort */ }
			}
		},
	});
}
