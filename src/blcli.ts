// Route B2: Individual-plan Token Plan quota via Alibaba Cloud's own open
// source Bailian CLI (`bailian-cli`, command `bl`). This is the sanctioned way
// for a plan without seats (the user's Individual plan) to expose its quota:
// the CLI performs the console-gateway call with its own browser-OAuth login
// (S11). This package only spawns it with a fixed argv array — never a shell,
// never with credentials of its own — and parses a strict allowlist of fields.
// Every failure (binary missing, not logged in, unknown shape) degrades into a
// one-line message and never throws into the session.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

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
	/** Override the Windows shim->entry lookup; tests pass a stub. */
	lookup?: (bin: string) => Promise<string | undefined>;
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

function defaultBlLookup(bin: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		// `where.exe` finds the npm shim (e.g. ...\npm\bl.cmd); the real entry is
		// the package's dist script beside its node_modules tree.
		execFile("where.exe", [bin], (error, stdout) => {
			if (error || typeof stdout !== "string") return resolve(undefined);
			const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
			if (!firstLine) return resolve(undefined);
			const { dirname, join } = nodePath;
			const entry = join(dirname(firstLine), "node_modules", "bailian-cli", "dist", "bailian.mjs");
			resolve(existsSync(entry) ? entry : undefined);
		});
	});
}

/**
 * Resolves the actual (cmd, args) pair to spawn. Windows npm shims are .cmd
 * files that execFile cannot launch (CreateProcess ignores PATHEXT), so the
 * underlying bailian.mjs entry is resolved and run under node — no shell, no
 * injection surface. A caller-pinned .mjs/.js binary runs the same way.
 */
export async function resolveBlCommand(
	bin: string,
	args: string[],
	platform: string = process.platform,
	lookup: (bin: string) => Promise<string | undefined> = defaultBlLookup,
): Promise<{ cmd: string; args: string[] }> {
	if (platform !== "win32") return { cmd: bin, args };
	if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, args: [bin, ...args] };
	const entry = await lookup(bin);
	if (!entry) return { cmd: bin, args };
	return { cmd: process.execPath, args: [entry, ...args] };
}

export async function fetchBlUsage(env: Record<string, string | undefined>, deps: BlDeps = {}): Promise<BlUsage> {
	const bin = env[BL_BIN_ENV]?.trim() || BL_DEFAULT_BIN;
	const region = env[BL_REGION_ENV]?.trim() || BL_DEFAULT_REGION;
	const site = env[BL_SITE_ENV]?.trim() || BL_DEFAULT_SITE;
	const runner = deps.runner ?? defaultRunner;
	const usageCommand = await resolveBlCommand(bin, ["usage", "token-plan", "--output", "json", "--console-region", region, "--console-site", site], process.platform, deps.lookup);
	const consoleCallCommand = await resolveBlCommand(bin, [
		"console",
		"call",
		"--api",
		USAGE_API,
		"--data",
		"{}",
		"--output",
		"json",
		"--console-region",
		region,
		"--console-site",
		site,
	], process.platform, deps.lookup);
	// The bare login goes to the China console; an international user following
	// that hint would land on a site that cannot even see their plan.
	const loginHint = `bl auth login --console --console-site ${site} --console-region ${region}`;

	let first: BlRunnerResult;
	try {
		first = await runner(usageCommand.cmd, usageCommand.args);
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
		fallback = await runner(consoleCallCommand.cmd, consoleCallCommand.args);
	} catch {
		return unavailable("bl: query failed (the CLI did not answer)");
	}
	if (fallback.ok) {
		const { windows } = parseBlPayload(fallback.stdout);
		if (windows.length > 0) {
			return { windows, source: "console-call", message: "bl: Individual plan windows (console gateway)" };
		}
	}
	return unavailable(`bl: no quota windows reported (is the CLI logged in? run "${loginHint}")`);
}
