// The usage-source contract gentle-shell validates, mirrored field for field
// from `gentle-pi/lib/shell-usage.ts` (UsageWindow/UsageLimit/ProviderUsage at
// lines 9-40, UsageSource at lines 145-153). Declared locally on purpose: this
// package ships with no runtime dependency and must not import gentle-pi.
export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
	used?: number;
	budget?: number;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
	scope?: "provider";
}

export interface ProviderUsage {
	provider: string;
	plan?: string;
	limits: UsageLimit[];
	fetchedAt: number;
}

// What `pi.events.emit("gentle-pi:usage-source/v1", payload)` carries.
export interface UsageSourcePayload {
	schema: "gentle-pi.usage-source/v1";
	provider: string;
	pendingNote?: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined>;
}

// The slices of Pi's ExtensionAPI this package uses. Structural and local, so
// the package loads under jiti without resolving pi's own types.
export interface PiTui {
	requestRender(): void;
}

/** Foreground color tokens, verified against `pi-coding-agent/dist/modes/interactive/theme/theme-tokens.d.ts` (THEME_TOKENS, foreground slot). Inventing a name outside this list is a defect. */
export type PiThemeColor =
	| "accent"
	| "borderAccent"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "dim"
	| "text";

/** Structural slice of Pi's real `Theme` (same file, class Theme): `fg(color, text)` and `bold(text)`. */
export interface PiTheme {
	fg(color: PiThemeColor, text: string): string;
	bold(text: string): string;
}

export interface PiKeybindings {
	matches(data: string, action: "tui.select.cancel" | "tui.select.up" | "tui.select.down"): boolean;
}

export interface PiUi {
	custom<T>(factory: (tui: PiTui, theme: PiTheme, keybindings: PiKeybindings, done: (result: T) => void) => { render(width: number): string[]; handleInput(data: string): void; invalidate(): void }, options: { overlay: true }): Promise<T>;
	setStatus(id: string, text: string | undefined): void;
	/** Persistent panel content; `undefined` clears it. Mirrors `setWidget` in `pi-coding-agent/dist/core/extensions/types.d.ts:112`. */
	setWidget(key: string, content: string[] | undefined, options?: unknown): void;
	notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
}

export interface PiActionContext {
	ui: PiUi;
	/** The event context also exposes the active model, so a 429 can be attributed. */
	model?: { provider?: string };
}

/** Fired after a provider HTTP response arrives, before its stream is consumed. */
export interface PiProviderResponseEvent {
	type?: string;
	status?: number;
	/** Normalized response headers; only `retry-after` is ever read here. */
	headers?: Record<string, unknown>;
	provider?: string;
	errorType?: string;
	error?: { type?: string; code?: string };
}

export interface PiSessionStartEvent {
	reason: "startup" | "reload" | "new" | "resume" | "fork" | string;
}

export interface PiCommandOptions {
	description: string;
	handler(args: string, ctx: PiActionContext): void | Promise<void>;
}

export interface PiApi {
	on(event: "session_start", handler: (event: PiSessionStartEvent, ctx: PiActionContext) => void | Promise<void>): void;
	on(
		event: "after_provider_response",
		handler: (event: PiProviderResponseEvent, ctx: PiActionContext) => void | Promise<void>,
	): void;
	registerCommand(name: string, options: PiCommandOptions): void;
	events?: { emit(event: string, payload: unknown): void };
}
