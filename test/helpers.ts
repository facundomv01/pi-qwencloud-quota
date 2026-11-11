import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Fixtures live outside the worktree, in a fresh system temp directory, and
// never touch the real `~/.gentle-shell/agent` tree.
export interface AgentFixture {
	dir: string;
	write(relativePath: string, lines: string[] | string): void;
	cleanup(): void;
}

export function makeAgentFixture(): AgentFixture {
	const dir = mkdtempSync(join(tmpdir(), "pi-qwencloud-quota-"));
	return {
		dir,
		write(relativePath, lines) {
			const path = join(dir, relativePath);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, Array.isArray(lines) ? `${lines.join("\n")}\n` : lines, "utf8");
		},
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export interface TurnInput {
	timestamp: string;
	model?: string;
	provider?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
}

// The exact nested wire shape Pi writes: the usage lives under `message`, never
// at the top level, and `cost` is all zeros for every qwen-token-plan model.
export function nestedTurn(turn: TurnInput): string {
	return JSON.stringify({
		type: "message",
		id: `msg-${turn.input}-${turn.output}`,
		parentId: null,
		timestamp: turn.timestamp,
		message: {
			role: "assistant",
			provider: turn.provider ?? "qwen-token-plan",
			model: turn.model ?? "deepseek-v4-flash",
			usage: {
				input: turn.input,
				output: turn.output,
				cacheRead: turn.cacheRead,
				cacheWrite: turn.cacheWrite,
				reasoning: turn.reasoning,
				totalTokens: turn.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
			},
			timestamp: Date.parse(turn.timestamp),
		},
	});
}

// A record whose `message` carries no `provider` at all. Pi always writes the
// field today, but a missing one must bucket under `unknown` — never silently
// under the token plan this package is named after.
export function providerlessTurn(turn: TurnInput): string {
	const record = JSON.parse(nestedTurn(turn)) as { message: Record<string, unknown> };
	delete record.message.provider;
	return JSON.stringify(record);
}

export function sessionRecord(timestamp: string, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id: `session-${cwd}`, timestamp, cwd });
}

export function userRecord(timestamp: string): string {
	return JSON.stringify({
		type: "message",
		id: `user-${timestamp}`,
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "hola" }], timestamp: Date.parse(timestamp) },
	});
}

// The known-good fixture every rendering assertion uses: two roots, three
// assistant turns, one project per root.
//   totals  input 26779 · output 393 · cacheRead 50740 · cacheWrite 10 ·
//           reasoning 29 · totalTokens 77922 · cacheRead 65.1%
export const KNOWN_TOTALS = {
	input: 26779,
	output: 393,
	cacheRead: 50740,
	cacheWrite: 10,
	reasoning: 29,
	totalTokens: 77922,
};

// Fixed clock the rendering fixtures are read against: late enough in the day
// that a 7-day window starting 2026-11-03 holds every fixture turn.
export const KNOWN_NOW = Date.parse("2026-11-09T12:00:00.000Z");

export function seedKnownAgent(fixture: AgentFixture): void {
	fixture.write("sessions/--G--Proyectos-demo--/orchestrator.jsonl", [
		sessionRecord("2026-11-09T09:59:00.000Z", "G:\\Proyectos\\demo"),
		nestedTurn({
			timestamp: "2026-11-09T10:00:00.000Z",
			input: 20779,
			output: 93,
			cacheRead: 10240,
			cacheWrite: 0,
			reasoning: 9,
			totalTokens: 31112,
		}),
		userRecord("2026-11-09T10:05:00.000Z"),
		nestedTurn({
			timestamp: "2026-11-09T11:00:00.000Z",
			model: "glm5.3-flash",
			input: 1000,
			output: 200,
			cacheRead: 500,
			cacheWrite: 10,
			reasoning: 0,
			totalTokens: 1710,
		}),
	]);
	fixture.write("gentle-agents/sessions/subagent.jsonl", [
		sessionRecord("2026-11-08T09:00:00.000Z", "G:\\Proyectos\\agent 1"),
		nestedTurn({
			timestamp: "2026-11-08T10:00:00.000Z",
			input: 5000,
			output: 100,
			cacheRead: 40000,
			cacheWrite: 0,
			reasoning: 20,
			totalTokens: 45100,
		}),
	]);
}

export function toolResultRecord(timestamp: string): string {
	return JSON.stringify({
		type: "message",
		id: `tool-${timestamp}`,
		parentId: null,
		timestamp,
		message: { role: "toolResult", toolCallId: "call-1", content: [], timestamp: Date.parse(timestamp) },
	});
}
