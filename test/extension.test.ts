import assert from "node:assert/strict";
import { test } from "node:test";
import { registerQuotaExtension } from "../src/extension.ts";
import { USAGE_PROVIDER, USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "../src/usage-source.ts";
import { KNOWN_NOW, makeAgentFixture, seedKnownAgent } from "./helpers.ts";

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
			const modal = factory({ requestRender() {} }, {}, { matches: (data: string, action: string) => data === action }, () => {});
			for (let i = 0; i < 100; i++) {
				for (const line of modal.render(300)) {
					if (!line.startsWith("│ ")) continue;
					const content = line.slice(2, -2).trimEnd();
					if (content === "QwenCloud" || content.startsWith("↑/↓")) continue;
					if (!modalLines.includes(content)) modalLines.push(content);
				}
				modal.handleInput("tui.select.down");
			}
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

test("registers /qwen-quota and renders the exact summary in a modal",  async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());
	seedKnownAgent(fixture);

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 0, env: {}, now: () => KNOWN_NOW });

	const command = fake.commands.get("qwen-quota");
	assert.ok(command, "the /qwen-quota command is registered");
	assert.match(command.description, /QwenCloud/);

	await command.handler("", fake.ctx);

	assert.deepEqual(fake.ui.widgets, [{ id: "qwen-quota", content: undefined }]);
	assert.deepEqual(
		fake.ui.modalLines.filter((line) => !line.startsWith("──") && !line.startsWith("↑/↓")),
		[
			"QwenCloud Token Plan · local token usage",
			"window: 2026-11-08 → 2026-11-09 · 2 sessions · 3 assistant turns (all providers)",
			"qwen-token-plan: 77.9k tok · cacheRead 50.7k (65.1%) · fresh input 26.8k · output 393 · cacheWrite 10 · reasoning 29",
			"all providers: 77.9k tok · cacheRead 50.7k (65.1%) · local context only, not Qwen quota",
			"by provider:",
			"  qwen-token-plan 3 turns · 77.9k tok · cacheRead 65.1%",
			"by source:",
			"  subagent     1 turn  · 45.1k tok · cacheRead 88.7%",
			"  orchestrator 2 turns · 32.8k tok · cacheRead 32.7%",
			"by model:",
			"  deepseek-v4-flash 2 turns · 76.2k tok · cacheRead 65.9%",
			"  glm5.3-flash      1 turn  · 1.7k tok · cacheRead 29.2%",
			"by day:",
			"  2026-11-08 1 turn  · 45.1k tok · cacheRead 88.7%",
			"  2026-11-09 2 turns · 32.8k tok · cacheRead 32.7%",
			"by project:",
			"  agent 1 1 turn  · 45.1k tok · cacheRead 88.7%",
			"  demo    2 turns · 32.8k tok · cacheRead 32.7%",
			"Credits: not configured · route B needs ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET",
		],
	);

	assert.equal(fake.ui.notifications.length, 0);
});

test("renders an empty agent dir in the modal",  async (t) => {
	const fixture = makeAgentFixture();
	t.after(() => fixture.cleanup());

	const fake = fakePi();
	registerQuotaExtension(fake.pi as never, {
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
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 7, env: {}, now: () => KNOWN_NOW });

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
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 0, env: {}, now: () => KNOWN_NOW });
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
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 7, env: {}, now: () => KNOWN_NOW });

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
	registerQuotaExtension(fake.pi as never, { agentDir: fixture.dir, days: 0, env: {}, now: () => KNOWN_NOW });

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
