// Route B2: Individual-plan Token Plan quota via Alibaba Cloud's own open
// source Bailian CLI (`bailian-cli`, command `bl`). This is the sanctioned way
// for a plan without seats (the user's Individual plan) to expose its quota:
// the CLI performs the console-gateway call with its own browser-OAuth login
// (S11). This package only spawns it with a fixed argv array — never a shell,
// never with credentials of its own — and parses a strict allowlist of fields.
// Every failure (binary missing, not logged in, unknown shape) degrades into a
// one-line message and never throws into the session.
import { execFile } from "node:child_process";

export const BL_BIN_ENV = "PI_QWENCLOUD_BL_BIN";
export const BL_REGION_ENV = "PI_QWENCLOUD_BL_REGION";
export const BL_SITE_ENV = "PI_QWENCLOUD_BL_SITE";
export const BL_DEFAULT_BIN = "bl";
export const BL_DEFAULT_REGION = "ap-southeast-1";
export const BL_DEFAULT_SITE = "international";
// Bounded: a hung CLI must never stall the panel or the command handler.
export const BL_TIMEOUT_MS = 15_000;

const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";

export interface BlWindow {
	/** Human label: "5-hour", "weekly" or "monthly". */
	key: "5-hour" | "weekly" | "monthly";
	/** Used percentage, 0..100. */
	usedPercent: number;
	/** Epoch ms when the window resets, when the CLI reported it. */
	resetAt: number | null;
}

export interface BlUsage {
	windows: BlWindow[];
	/** Which command produced the data, or why nothing was parsed. */
	source: "usage" | "console-call" | "unavailable";
	/** One line, ready to print. Never contains CLI internals or auth state. */
	message: string;
}

/** Injectable transport so tests never spawn a real process. */
export type BlRunner = (cmd: string, args: string[]) => Promise<BlRunnerResult>;

export interface BlRunnerResult {
	ok: boolean;
	/** Process exit code, or "ENOENT" when the binary itself is missing. */
	code: number | string | undefined;
	stdout: string;
	stderr: string;
}

export interface BlDeps {
	runner?: BlRunner;
}

const WINDOW_ORDER: Array<BlWindow["key"]> = ["5-hour", "weekly", "monthly"];

// The allowlist pinned from live verified output (S11): fractional used ratios
// with epoch-ms resets. Deep-walked because the console call nests its payload.
const PERCENTAGE_PATTERN = /^per(5Hour|1Week|1Month)Percentage$/;
const RESET_PATTERN = /^per(5Hour|1Week|1Month)ResetTime$/;

const KEY_BY_MATCH: Record<string, BlWindow["key"]> = {
	"5Hour": "5-hour",
	"1Week": "weekly",
	"1Month": "monthly",
};

function walk(node: unknown, percentages: Map<string, number>, resets: Map<string, number>): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, percentages, resets);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		const percentageMatch = PERCENTAGE_PATTERN.exec(key);
		if (percentageMatch && typeof value === "number" && Number.isFinite(value)) {
			// 0..1 is a fractional used ratio (verified shape); 1..100 is already
			// a percent — defending against either server-side convention.
			percentages.set(percentageMatch[1], Math.round((value <= 1 ? value * 100 : value) * 10) / 10);
		}
		const resetMatch = RESET_PATTERN.exec(key);
		if (resetMatch && typeof value === "number" && Number.isFinite(value) && value >= 0) {
			resets.set(resetMatch[1], value);
		}
		walk(value, percentages, resets);
	}
}

/** Parses one command's stdout into windows; tolerant of unknown shapes. */
export function parseBlPayload(stdout: string): { windows: BlWindow[] } {
	let body: unknown;
	try {
		body = JSON.parse(stdout);
	} catch {
		return { windows: [] };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { windows: [] };
	const percentages = new Map<string, number>();
	const resets = new Map<string, number>();
	walk(body, percentages, resets);
	const windows = WINDOW_ORDER.filter((key) => {
		const match = Object.entries(KEY_BY_MATCH).find(([, label]) => label === key);
		return match && percentages.has(match[0]);
	}).map((key) => {
		const match = Object.entries(KEY_BY_MATCH).find(([, label]) => label === key)![0];
		return { key, usedPercent: Math.min(100, Math.max(0, percentages.get(match)!)), resetAt: resets.get(match) ?? null };
	});
	return { windows };
}

function defaultRunner(cmd: string, args: string[]): Promise<BlRunnerResult> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: BL_TIMEOUT_MS, windowsHide: true, shell: false },
			(error, stdout, stderr) => {
				if (error) {
					resolve({
						ok: false,
						code: (error as NodeJS.ErrnoException).code ?? 1,
						stdout: typeof stdout === "string" ? stdout : "",
						stderr: typeof stderr === "string" ? stderr : "",
					});
					return;
				}
				resolve({ ok: true, code: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" });
			},
		);
	});
}

function unavailable(message: string): BlUsage {
	return { windows: [], source: "unavailable", message };
}

export async function fetchBlUsage(env: Record<string, string | undefined>, deps: BlDeps = {}): Promise<BlUsage> {
	const bin = env[BL_BIN_ENV]?.trim() || BL_DEFAULT_BIN;
	const region = env[BL_REGION_ENV]?.trim() || BL_DEFAULT_REGION;
	const site = env[BL_SITE_ENV]?.trim() || BL_DEFAULT_SITE;
	const runner = deps.runner ?? defaultRunner;
	const sharedArgs = ["--console-region", region, "--console-site", site];

	let first: BlRunnerResult;
	try {
		first = await runner(bin, ["usage", "token-plan", "--output", "json", ...sharedArgs]);
	} catch {
		// Runner internals (timeout detail, spawn crash) never reach the message.
		return unavailable("bl: query failed (the CLI did not answer)");
	}
	if (first.code === "ENOENT") {
		return unavailable(`bl CLI not found · install bailian-cli and run "bl auth login --console" once`);
	}
	if (first.ok) {
		const { windows } = parseBlPayload(first.stdout);
		if (windows.length > 0) {
			return { windows, source: "usage", message: "bl: Individual plan windows (console login)" };
		}
	}

	// Issue #231: monthly-only accounts get an empty usage JSON because the CLI
	// table reads only the 5-hour/weekly fields. The documented fallback asks
	// the console gateway for the raw personal usage payload.
	let fallback: BlRunnerResult;
	try {
		fallback = await runner(bin, [
			"console",
			"call",
			"--api",
			USAGE_API,
			"--data",
			"{}",
			"--output",
			"json",
			...sharedArgs,
		]);
	} catch {
		return unavailable("bl: query failed (the CLI did not answer)");
	}
	if (fallback.ok) {
		const { windows } = parseBlPayload(fallback.stdout);
		if (windows.length > 0) {
			return { windows, source: "console-call", message: "bl: Individual plan windows (console gateway)" };
		}
	}
	return unavailable("bl: no quota windows reported (is the CLI logged in? run \"bl auth login --console\")");
}
