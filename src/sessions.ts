import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// Route D: aggregate token consumption out of Pi's own session JSONL.
// Read-only, credential-free, offline. Nothing here writes to the agent tree.

export const AGENT_DIR_ENV = "PI_QWENCLOUD_AGENT_DIR";
export const DAYS_ENV = "PI_QWENCLOUD_QUOTA_DAYS";
export const DEFAULT_DAYS = 7;

export type SourceClass = "orchestrator" | "subagent";

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
}

export interface Bucket {
	key: string;
	turns: number;
	totals: TokenTotals;
	cacheReadShare: number;
}

export interface Aggregate {
	turns: number;
	sessions: number;
	totals: TokenTotals;
	/** cacheRead tokens over total tokens: the single most decision-relevant ratio. */
	cacheReadShare: number;
	byDay: Bucket[];
	byModel: Bucket[];
	bySource: Bucket[];
	byProject: Bucket[];
	/**
	 * Bucketed by the `provider` the turn itself recorded — the only trustworthy
	 * attribution signal. A turn without one lands under `unknown`, never under
	 * the provider this package is about: the same model id can exist in several
	 * catalogues (e.g. `deepseek-v4-flash` in both `nan` and `qwen-token-plan`),
	 * so catalogue membership must never be used to attribute a turn.
	 */
	byProvider: Bucket[];
	from: string | null;
	to: string | null;
}

export interface AggregateOptions {
	agentDir?: string;
	/** 0 or omitted aggregates every session file on disk. */
	days?: number;
	now?: number;
	env?: Record<string, string | undefined>;
	/** Home override for agent-dir detection (tests; defaults to os.homedir()). */
	home?: string;
}

export interface ParsedTurn {
	timestamp: number;
	/** Local calendar day, or "unknown" when the record carries no timestamp. */
	day: string;
	model: string;
	provider: string;
	usage: TokenTotals;
}

const DAY_MS = 86_400_000;
const UNKNOWN = "unknown";

export function zeroTotals(): TokenTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
}

export function resolveAgentDir(options: AggregateOptions = {}): string {
	const env = options.env ?? process.env;
	const configured = options.agentDir ?? env[AGENT_DIR_ENV];
	if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
	// No explicit dir: this package targets Pi in general, not only gentle-shell.
	// gentle-shell keeps sessions under ~/.gentle-shell/agent, plain Pi under
	// ~/.pi/agent. Prefer whichever exists (gentle-shell wins a tie, because
	// the usage-source hook and the tuned panel live there); when neither
	// exists yet, fall back to the plain-Pi standard location.
	const home = options.home ?? homedir();
	const gentleShell = join(home, ".gentle-shell", "agent");
	const plainPi = join(home, ".pi", "agent");
	if (existsSync(gentleShell)) return gentleShell;
	if (existsSync(plainPi)) return plainPi;
	return plainPi;
}

export function resolveDays(options: { days?: number; env?: Record<string, string | undefined> } = {}): number {
	if (typeof options.days === "number" && Number.isFinite(options.days) && options.days >= 0) return Math.floor(options.days);
	const raw = options.env?.[DAYS_ENV];
	if (typeof raw === "string") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_DAYS;
}

function finiteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function localDay(timestamp: number): string {
	const date = new Date(timestamp);
	if (!Number.isFinite(timestamp)) return UNKNOWN;
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(timestamp: number): number {
	const date = new Date(timestamp);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// One session line. Pi nests the interesting part: the usage lives under
// `message`, and reading `record.role` / `record.usage` at the top level yields
// nothing at all (a real defect measured during investigation). A flat record
// is still accepted defensively, since it costs one branch to tolerate.
export function parseSessionLine(line: string): ParsedTurn | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let record: unknown;
	try {
		record = JSON.parse(trimmed);
	} catch {
		// Truncated or malformed line: skip it and keep reading the file.
		return undefined;
	}
	if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
	const raw = record as Record<string, unknown>;
	const nested = raw.message && typeof raw.message === "object" && !Array.isArray(raw.message);
	const message = nested ? (raw.message as Record<string, unknown>) : raw.type === "message" || raw.type === undefined ? raw : undefined;
	if (!message) return undefined;
	if (message.role !== "assistant") return undefined;
	const usage = message.usage;
	if (!usage || typeof usage !== "object") return undefined;

	const totals = usage as Record<string, unknown>;
	const input = finiteCount(totals.input);
	const output = finiteCount(totals.output);
	const cacheRead = finiteCount(totals.cacheRead);
	const cacheWrite = finiteCount(totals.cacheWrite);
	const reasoning = finiteCount(totals.reasoning);
	const reportedTotal = totals.totalTokens;
	const totalTokens =
		typeof reportedTotal === "number" && Number.isFinite(reportedTotal) && reportedTotal >= 0
			? reportedTotal
			: // Only a defensive fallback for a record without the field: the sum of
				// the four components it reports, never a guess at missing ones.
				input + output + cacheRead + cacheWrite;

	const timestamp = timestampOf(raw, message);
	return {
		timestamp,
		day: localDay(timestamp),
		model: nonEmptyString(message.model) ?? UNKNOWN,
		provider: nonEmptyString(message.provider) ?? nonEmptyString(raw.provider) ?? UNKNOWN,
		usage: { input, output, cacheRead, cacheWrite, reasoning, totalTokens },
	};
}

function timestampOf(raw: Record<string, unknown>, message: Record<string, unknown>): number {
	const line = raw.timestamp;
	if (typeof line === "string") {
		const parsed = Date.parse(line);
		if (Number.isFinite(parsed)) return parsed;
	}
	const inner = message.timestamp;
	if (typeof inner === "number" && Number.isFinite(inner)) return inner;
	if (typeof line === "number" && Number.isFinite(line)) return line;
	return Number.NaN;
}

interface SessionFile {
	path: string;
	source: SourceClass;
	/** Fallback project label, used when the file carries no session cwd. */
	project: string;
}

function isJsonl(name: string): boolean {
	return name.endsWith(".jsonl");
}

function filesIn(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && isJsonl(entry.name))
			.map((entry) => join(dir, entry.name))
			.sort();
	} catch {
		// A missing root is not an error: no sessions simply means no data.
		return [];
	}
}

function dirsIn(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function collectSessionFiles(agentDir: string): SessionFile[] {
	const files: SessionFile[] = [];
	const orchestratorRoot = join(agentDir, "sessions");
	for (const file of filesIn(orchestratorRoot)) files.push({ path: file, source: "orchestrator", project: "sessions" });
	for (const dir of dirsIn(orchestratorRoot)) {
		const slug = basename(dir);
		for (const file of filesIn(dir)) files.push({ path: file, source: "orchestrator", project: slug });
	}
	const subagentRoot = join(agentDir, "gentle-agents", "sessions");
	for (const file of filesIn(subagentRoot)) files.push({ path: file, source: "subagent", project: "subagents" });
	return files;
}

function projectFromCwd(cwd: unknown): string | undefined {
	const value = nonEmptyString(cwd);
	if (!value) return undefined;
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return base.length > 0 ? base : undefined;
}

function readLines(path: string): string[] | undefined {
	try {
		return readFileSync(path, "utf8").split(/\r?\n/);
	} catch {
		return undefined;
	}
}

// The session record is written first, so the first few lines are enough to
// learn the working directory the file belongs to.
function sessionCwd(lines: readonly string[]): string | undefined {
	const limit = Math.min(lines.length, 20);
	for (let index = 0; index < limit; index += 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{") || !line.includes('"session"')) continue;
		try {
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.type === "session") return projectFromCwd(record.cwd);
		} catch {
			// Keep looking: a broken first line must not hide the rest of the file.
		}
	}
	return undefined;
}

function addTo(map: Map<string, Bucket>, key: string, usage: TokenTotals): void {
	const existing = map.get(key);
	if (existing) {
		accumulate(existing.totals, usage);
		existing.turns += 1;
		return;
	}
	const totals = zeroTotals();
	accumulate(totals, usage);
	map.set(key, { key, turns: 1, totals, cacheReadShare: 0 });
}

// The single place totals grow, so every bucket keeps the same shape.
function accumulate(target: TokenTotals, usage: TokenTotals): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.reasoning += usage.reasoning;
	target.totalTokens += usage.totalTokens;
}

function shareOf(totals: TokenTotals): number {
	return totals.totalTokens > 0 ? totals.cacheRead / totals.totalTokens : 0;
}

function finalize(map: Map<string, Bucket>): Bucket[] {
	return [...map.values()].map((bucket) => ({ ...bucket, cacheReadShare: shareOf(bucket.totals) }));
}

function byTokensThenKey(a: Bucket, b: Bucket): number {
	if (b.totals.totalTokens !== a.totals.totalTokens) return b.totals.totalTokens - a.totals.totalTokens;
	return a.key.localeCompare(b.key);
}

/**
 * The single turn bucket for one provider, or undefined when that provider has
 * no turn in the window. Callers that report a provider-specific figure (the
 * usage-source plan, the status row, the qwen totals) must go through this
 * instead of `aggregate.totals`, which counts every provider on disk.
 */
export function providerBucket(aggregate: Aggregate, provider: string): Bucket | undefined {
	return aggregate.byProvider.find((bucket) => bucket.key === provider);
}

export function aggregateSessions(options: AggregateOptions = {}): Aggregate {
	const agentDir = resolveAgentDir(options);
	const days = options.days ?? 0;
	const now = options.now ?? Date.now();
	const since = days > 0 ? startOfLocalDay(now) - (days - 1) * DAY_MS : undefined;

	const totals = zeroTotals();
	const byDay = new Map<string, Bucket>();
	const byModel = new Map<string, Bucket>();
	const bySource = new Map<string, Bucket>();
	const byProject = new Map<string, Bucket>();
	const byProvider = new Map<string, Bucket>();
	let turns = 0;
	let sessions = 0;

	for (const file of collectSessionFiles(agentDir)) {
		const lines = readLines(file.path);
		if (!lines) continue;
		const project = sessionCwd(lines) ?? file.project;
		let countedInFile = 0;
		for (const line of lines) {
			const turn = parseSessionLine(line);
			if (!turn) continue;
			if (since !== undefined && !(turn.timestamp >= since)) continue;
			countedInFile += 1;
			turns += 1;
			accumulate(totals, turn.usage);
			addTo(byDay, turn.day, turn.usage);
			addTo(byModel, turn.model, turn.usage);
			addTo(bySource, file.source, turn.usage);
			addTo(byProject, project, turn.usage);
			addTo(byProvider, turn.provider, turn.usage);
		}
		if (countedInFile > 0) sessions += 1;
	}

	const dayBuckets = finalize(byDay).sort((a, b) => a.key.localeCompare(b.key));
	const named = dayBuckets.filter((bucket) => bucket.key !== UNKNOWN);

	return {
		turns,
		sessions,
		totals,
		cacheReadShare: shareOf(totals),
		byDay: dayBuckets,
		byModel: finalize(byModel).sort(byTokensThenKey),
		bySource: finalize(bySource).sort(byTokensThenKey),
		byProject: finalize(byProject).sort(byTokensThenKey),
		byProvider: finalize(byProvider).sort(byTokensThenKey),
		from: named.length > 0 ? named[0].key : null,
		to: named.length > 0 ? named[named.length - 1].key : null,
	};
}
