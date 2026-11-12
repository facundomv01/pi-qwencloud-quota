import assert from "node:assert/strict";
import { test } from "node:test";
import { registerQuotaExtension } from "../src/extension.ts";
import { USAGE_PROVIDER, USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "../src/usage-source.ts";
import { KNOWN_NOW, makeAgentFixture, seedKnownAgent } from "./helpers.ts";
// Deterministic bl stub: unavailable, so the pinned summaries stay exact.
const BL_STUB = async () => ({ ok: false, code: "ENOENT", stdout: "", stderr: "" });


interface FakePi {
	commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	emitted: Array<{ event: string; payload: unknown }>;
	pi: {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void;
		registerCommand(name: string, options: { description: string; handler: (args: string, ctx: unknown) => unknown }): void;
		events: { emit(event: string, payload: unknown): void };
	};
	ui: {
		statuses: Array<{ id: string; text: string | undefined }>;
		notifications: Array<{ message: string; level: string | undefined }>;
		widgets: Array<{ id: string; content: string[] | undefined }>;
		modalLines: string[];
	};
	/** Every ui call in the order the extension made it. */
	calls: string[];
	ctx: unknown;
}

// S12: the modal now opens instantly and loads its data asynchronously, with a
// themed loading state. The fake ui passes a pass-through theme, waits for the
// loader to settle, then collects the content rows of BOTH tabs (Overview and
// Breakdown) after stripping ANSI codes.
const ANSI = /\x1b\[[0-9;]*m/gu;
const visible = (line: string) => line.replace(ANSI, "");

function fakePi(): FakePi {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => unknown }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const statuses: Array<{ id: string; text: string | undefined }> = [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const widgets: Array<{ id: string; content: string[] | undefined }> = [];
	const calls: string[] = [];
	const modalLines: string[] = [];
	const ui = {
		modalLines,
		async custom(factory: Function, options: unknown) {
			assert.deepEqual(options, { overlay: true });
			const modal = factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				{ matches: (data: string, action: string) => data === action },
				() => {},
			);
			// The modal opens before its data; wait until the loading state clears.
			for (let i = 0; i < 200; i++) {
				if (!modal.render(300).map(visible).join("\n").includes("Loading")) break;
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			const collect = () => {
				for (const line of modal.render(300)) {
					if (!line.startsWith("│ ")) continue;
					const content = visible(line.slice(2).replace(/\s*│$/u, "")).replace(/\s+$/u, "");
					const trimmed = content.trim();
					if (!trimmed) continue;
					if (trimmed.startsWith("Overview") || trimmed.startsWith("←/→")) continue;
					if (!modalLines.includes(content)) modalLines.push(content);
				}
			};
			collect(); // Overview tab
			modal.handleInput("\x1b[C"); // switch to Breakdown
			collect();
		},
		statuses,
		notifications,
		widgets,
		setStatus(id: string, text: string | undefined) {
			calls.push(`setStatus ${id}`);
			statuses.push({ id, text });
		},
		setWidget(id: string, content: string[] | undefined) {
			calls.push(`setWidget ${id}`);
			widgets.push({ id, content });
		},
		notify(message: string, level: string | undefined) {
			calls.push(`notify ${level ?? "info"}`);
			notifications.push({ message, level });
		},
	};
	return {
		commands,
		handlers,
		emitted,
		ui,
		calls,
		ctx: { ui },
		pi: {
			on(name, handler) {
				handlers.set(name, handler);
			},
			registerCommand(name, options) {
				commands.set(name, options);
			},
			events: {
				emit(event, payload) {
					calls.push(`emit ${event}`);
					emitted.push({ event, payload });
				},
			},
		},
	};
}

test("registers /qwen-quota and renders the themed tabbed summary in a modal",  async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 0, env: {}, now: () => KNOWN_NOW, blRunner: BL_STUB });

	const command = fake.commands.get("qwen-quota");
	assert.ok(command, "the /qwen-quota command is registered");
	assert.match(command.description, /QwenCloud/);

	await command.handler("", fake.ctx);

	assert.deepEqual(fake.ui.widgets, [{ id: "qwen-quota", content: undefined }]);
	// Deliberate S12 redesign of the modal surface: the plan quota lines (bl,
	// Credits) now lead the Overview tab, the local-usage block follows, and the
	// per-dimension tables moved to the Breakdown tab. renderSummary (the widget
	// surface) is unchanged and stays pinned by test/summary.test.ts.
	assert.deepEqual(
		fake.ui.modalLines,
		[
			// Overview tab: plan quota first, prominently.
			'bl CLI not found · install bailian-cli and run "bl auth login --console" once',
			"Credits: not configured · route B needs ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET",
			"Local session usage",
			"window: 2026-11-08 → 2026-11-09 · 2 sessions · 3 assistant turns (all providers)",
			"qwen-token-plan: 77.9k tok · cacheRead 50.7k (65.1%) · fresh input 26.8k · output 393 · cacheWrite 10 · reasoning 29",
			"all providers: 77.9k tok · cacheRead 50.7k (65.1%) · local context only, not Qwen quota",
			// Breakdown tab.
			"By provider",
			"  qwen-token-plan 3 turns · 77.9k tok · cacheRead 65.1%",
			"By source",
			"  subagent     1 turn  · 45.1k tok · cacheRead 88.7%",
			"  orchestrator 2 turns · 32.8k tok · cacheRead 32.7%",
			"By model",
			"  deepseek-v4-flash 2 turns · 76.2k tok · cacheRead 65.9%",
			"  glm5.3-flash      1 turn  · 1.7k tok · cacheRead 29.2%",
			"By day",
			"  2026-11-08 1 turn  · 45.1k tok · cacheRead 88.7%",
			"  2026-11-09 2 turns · 32.8k tok · cacheRead 32.7%",
			"By project",
			"  agent 1 1 turn  · 45.1k tok · cacheRead 88.7%",
			"  demo    2 turns · 32.8k tok · cacheRead 32.7%",
		],
	);

	assert.equal(fake.ui.notifications.length, 0);
});

test("renders an empty agent dir in the modal",  async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, {
	blRunner: BL_STUB,
		days: 7,
		env: { PI_QWENCLOUD_AGENT_DIR: `${fixture.dir}/missing` },
		now: () => KNOWN_NOW,
	});

	const command = fake.commands.get("qwen-quota");
	assert.ok(command);
	await command.handler("", fake.ctx);

	assert.ok(fake.ui.modalLines.some((line) => /no local session data yet/.test(line)));
	assert.equal(fake.ui.notifications.length, 0);
});

test("activation emits the usage source without waiting for session_start", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 7, env: {}, now: () => KNOWN_NOW, blRunner: BL_STUB });

	// The mock never fires session_start. A `/reload` re-activates this module
	// without replaying that event, so activation alone must announce the source;
	// otherwise the previously registered closure from the old module stays in
	// charge and the panel never updates.
	const sources = fake.emitted.filter((entry) => entry.event === USAGE_SOURCE_EVENT);
	assert.equal(sources.length, 1);
	const payload = sources[0].payload as Record<string, unknown>;
	assert.equal(payload.schema, USAGE_SOURCE_SCHEMA);
	assert.equal(payload.provider, USAGE_PROVIDER);
	// The factory receives no ui, so there is nothing to refresh and nothing is invented.
	assert.deepEqual(fake.calls, [`emit ${USAGE_SOURCE_EVENT}`]);
});

test("activation refreshes the status row when a ui is reachable", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension({ ...fake.pi, ui: fake.ui } as never, {
		agentDir: fixture.dir,
		days: 0,
		env: {},
		now: () => KNOWN_NOW,
	});

	assert.deepEqual(fake.calls, [`emit ${USAGE_SOURCE_EVENT}`, "setStatus qwen-quota"]);
	assert.deepEqual(fake.ui.statuses, [{ id: "qwen-quota", text: "qwen 77.9k tok · cacheRead 65.1%" }]);
});

test("a failing setWidget never rejects the command handler", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 0, env: {}, now: () => KNOWN_NOW, blRunner: BL_STUB });
	const command = fake.commands.get("qwen-quota");
	assert.ok(command);

	const notifications: string[] = [];
	const failingCtx = {
		ui: {
			setStatus() {},
			setWidget() {
				throw new Error("widget unavailable");
			},
			async custom() { throw new Error("modal unavailable"); },
			notify(message: string) {
				notifications.push(message);
			},
		},
	};

	await assert.doesNotReject(async () => command.handler("", failingCtx));
	// The pointer still reaches the user, and it never claims a widget that failed.
	assert.equal(notifications.length, 1);
	assert.ok(!notifications[0].includes("\n"));
	assert.ok(notifications[0].length <= 80);
});

test("session_start re-emits the usage source and sets the compact status", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 7, env: {}, now: () => KNOWN_NOW, blRunner: BL_STUB });

	const onSessionStart = fake.handlers.get("session_start");
	assert.ok(onSessionStart, "session_start is handled");
	// Activation already emitted once; the event emits again on session_start so a
	// reloaded session rebinds against the current module's closure.
	await onSessionStart({ reason: "startup" }, fake.ctx);

	assert.equal(fake.emitted.length, 2);
	for (const entry of fake.emitted) {
		assert.equal(entry.event, USAGE_SOURCE_EVENT);
		const payload = entry.payload as Record<string, unknown>;
		assert.equal(payload.schema, USAGE_SOURCE_SCHEMA);
		assert.equal(payload.provider, USAGE_PROVIDER);
	}

	assert.deepEqual(fake.ui.statuses, [{ id: "qwen-quota", text: "qwen 77.9k tok · cacheRead 65.1%" }]);
});

test("degrades silently with no credentials and no session data", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, {
	blRunner: BL_STUB,
		days: 7,
		// The env override is what a real install uses, and the path does not exist.
		env: { PI_QWENCLOUD_AGENT_DIR: `${fixture.dir}/missing` },
		now: () => KNOWN_NOW,
	});

	const command = fake.commands.get("qwen-quota");
	assert.ok(command);
	await command.handler("", fake.ctx);
	assert.equal(fake.ui.notifications.length, 0);
	assert.ok(fake.ui.modalLines.some((line) => /no local session data yet/.test(line)));

	const onSessionStart = fake.handlers.get("session_start");
	assert.ok(onSessionStart);
	await onSessionStart({ reason: "startup" }, fake.ctx);
	// No data: the status is cleared, never a stale or invented figure.
	assert.deepEqual(fake.ui.statuses, [{ id: "qwen-quota", text: undefined }]);
	assert.equal(fake.emitted.length, 2);
});

test("the package entry exports a Pi factory that registers the extension", async () => {	const entry = await import("../index.ts");
	assert.equal(typeof entry.default, "function");

	const fake = fakePi();
	entry.default(fake.pi as never);

	assert.ok(fake.commands.has("qwen-quota"));
	assert.ok(fake.handlers.has("session_start"));
});

// Change B: the 429 the provider itself returns is the only credential-free
// quota signal, so it is recorded in memory and surfaced on both surfaces.
test("records a provider 429 and surfaces the exhaustion without throwing", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 0, env: {}, now: () => KNOWN_NOW, blRunner: BL_STUB });

	const onResponse = fake.handlers.get("after_provider_response");
	assert.ok(onResponse, "after_provider_response is handled");
	const qwenCtx = { ui: fake.ui, model: { provider: "qwen-token-plan" } };

	// A healthy response creates no exhaustion and refreshes nothing.
	await onResponse({ status: 200, headers: {} }, qwenCtx);
	assert.equal(fake.ui.statuses.length, 0);

	// Another provider's 429 is not Qwen quota exhaustion.
	await onResponse({ status: 429, headers: { "retry-after": "3600" } }, { ui: fake.ui, model: { provider: "nan" } });
	assert.equal(fake.ui.statuses.length, 0);

	// The qwen 429 refreshes the status row with the derived reset time.
	await onResponse({ status: 429, headers: { "retry-after": "3600" } }, qwenCtx);
	assert.equal(fake.ui.statuses.length, 1);
	const status = fake.ui.statuses[0].text ?? "";
	assert.match(status, /^qwen 77\.9k tok · cacheRead 65\.1% · exhausted · resets \d{2}:\d{2}$/);
	assert.ok(status.length <= 60);

	// /qwen-quota shows the same state on its own line in the widget.
	const command = fake.commands.get("qwen-quota");
	assert.ok(command);
	await command.handler("", fake.ctx);
	assert.ok(fake.ui.modalLines.some((line) => /^exhausted · resets \d{2}:\d{2}$/.test(line)));

	// A later healthy response does not clear it or rewrite the status row.
	await onResponse({ status: 200, headers: {} }, qwenCtx);
	assert.equal(fake.ui.statuses.length, 1);
	assert.equal(fake.ui.statuses[0].text, status);

	// A malformed event is tolerated, never rejected into the session.
	await assert.doesNotReject(async () => onResponse(undefined, { ui: fake.ui }));
});

// Route B wired into the command: with credentials and an injected transport,
// the modal must show the fetched Credits figure, not the pending line.
test("the command fetches route B credits through the injected transport", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, {
	blRunner: BL_STUB,
		agentDir: fixture.dir,
		days: 0,
		env: { ALIBABA_CLOUD_ACCESS_KEY_ID: "ak", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "sk" },
		now: () => KNOWN_NOW,
		fetchFn: (async () => ({
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					Success: true,
					Data: {
						SubscriptionStartTime: KNOWN_NOW - 15 * 24 * 3600 * 1000,
						SubscriptionEndTime: KNOWN_NOW + 15 * 24 * 3600 * 1000,
						Items: [
							{ SeatType: "standard", SeatRefreshTime: KNOWN_NOW + 15 * 24 * 3600 * 1000, TotalSeats: 1, AssignedSeats: 1, SeatCredits: 45000, SeatRemainingCredits: 43740 },
						],
					},
				}),
		})) as unknown as typeof fetch,
	});

	const command = fake.commands.get("qwen-quota");
	assert.ok(command);
	await command.handler("", fake.ctx);
	assert.ok(fake.ui.modalLines.some((line) => line.startsWith("Credits: 43740 of 45000 remaining")));
	// No credential value may ever reach a rendered surface.
	for (const line of fake.ui.modalLines) {
		assert.ok(!line.includes("sk"), "the secret must never be rendered");
		assert.ok(!/\bak\b/.test(line), "the AccessKey id must never be rendered");
	}
});

// A route B failure must degrade into the pending line, never break the command.
test("a route B failure keeps the command working with a pending Credits line", async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, {
	blRunner: BL_STUB,
		agentDir: fixture.dir,
		days: 0,
		env: { ALIBABA_CLOUD_ACCESS_KEY_ID: "ak", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "sk" },
		now: () => KNOWN_NOW,
		fetchFn: (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch,
	});

	const command = fake.commands.get("qwen-quota");
	assert.ok(command);
	await command.handler("", fake.ctx);
	assert.ok(fake.ui.modalLines.some((line) => line.startsWith("Credits: ")));
	assert.ok(!fake.ui.modalLines.some((line) => line.includes("boom")));
});
