/**
 * Opencode GO usage status for pi's default footer.
 *
 * Instead of replacing pi's built-in footer, this extension adds an extension
 * status line below it using ctx.ui.setStatus(). The default footer stays
 * untouched, so everything (cwd, token stats, context %, model name, thinking
 * level) renders exactly as pi intends.
 *
 * The status line shows rolling/weekly/monthly usage from Opencode GO's
 * /usage endpoint:
 *   usage: 24/8/48%
 *
 * Configuration:
 *   PI_STATUSLINE_DEBUG - "1" to log raw usage responses to
 *                         ~/.pi/agent/custom-statusline-debug.log.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DEBUG = process.env.PI_STATUSLINE_DEBUG === "1";
const USAGE_CACHE_MS = 60_000;
const USAGE_TIMEOUT_MS = 15_000;
const PROXY_MANAGED_SENTINEL = "proxy-managed";
const STATUS_KEY = "opencode-go-usage";

const DEBUG_LOG_PATH = `${process.env.HOME || process.env.USERPROFILE || "/tmp"}/.pi/agent/custom-statusline-debug.log`;

interface UsageSnapshot {
	percents: [number | null, number | null, number | null];
	raw?: unknown;
	error?: string;
	fetchedAt: number;
}

let cachedUsage: UsageSnapshot = {
	percents: [null, null, null],
	fetchedAt: 0,
};

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function logDebug(message: string, payload?: unknown): Promise<void> {
	if (!DEBUG) return;
	try {
		await mkdir(dirname(DEBUG_LOG_PATH), { recursive: true });
		const line = `${new Date().toISOString()} ${message}${payload !== undefined ? ` ${JSON.stringify(payload)}` : ""}\n`;
		await appendFile(DEBUG_LOG_PATH, line);
	} catch {
		// ignore
	}
}

function parseWindowPercent(win: unknown): number | undefined {
	if (!win || typeof win !== "object" || Array.isArray(win)) return undefined;
	const percent = toNumber((win as Record<string, unknown>).percent);
	return percent === undefined ? undefined : clampPercent(percent);
}

function parseUsageResponse(data: unknown): [number | null, number | null, number | null] {
	const empty: [number | null, number | null, number | null] = [null, null, null];
	if (!data || typeof data !== "object") return empty;
	const obj = data as Record<string, unknown>;

	const usage = obj.usage;
	if (usage && typeof usage === "object" && !Array.isArray(usage)) {
		const usageObj = usage as Record<string, unknown>;
		const rolling = parseWindowPercent(usageObj.rolling);
		const weekly = parseWindowPercent(usageObj.weekly);
		const monthly = parseWindowPercent(usageObj.monthly);
		if (rolling !== undefined || weekly !== undefined || monthly !== undefined) {
			return [rolling ?? null, weekly ?? null, monthly ?? null];
		}
	}

	const percent = toNumber(obj.percent ?? obj.percentage);
	if (percent !== undefined) return [clampPercent(percent), null, null];

	return empty;
}

function formatPercents(percents: [number | null, number | null, number | null]): string {
	const parts = percents.map((p) => (p === null ? "?" : `${Math.round(p)}`));
	return `${parts.join("/")}%`;
}

function renderStatus(snapshot: UsageSnapshot): string | undefined {
	if (!snapshot.percents.some((p) => p !== null)) return undefined;
	return `usage: ${formatPercents(snapshot.percents)}`;
}

async function refreshUsage(ctx: ExtensionContext): Promise<UsageSnapshot> {
	const model = ctx.model;
	if (!model || model.provider !== "opencode-go") {
		return { percents: [null, null, null], fetchedAt: Date.now() };
	}

	const baseUrl = model.baseUrl.replace(/\/$/, "");
	const url = `${baseUrl}/usage`;

	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		await logDebug("failed to resolve API key", { error: msg });
		return { percents: [null, null, null], fetchedAt: Date.now(), error: msg };
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
		"Accept-Encoding": "identity",
	};
	if (apiKey && apiKey !== PROXY_MANAGED_SENTINEL) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	let response: Response;
	try {
		response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		await logDebug("usage fetch failed", { url, error: msg });
		return { percents: [null, null, null], fetchedAt: Date.now(), error: msg };
	}

	if (!response.ok) {
		await logDebug("usage HTTP error", { url, status: response.status });
		return { percents: [null, null, null], fetchedAt: Date.now(), error: `http${response.status}` };
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		await logDebug("usage JSON parse failed", { url });
		return { percents: [null, null, null], fetchedAt: Date.now(), error: "badjson" };
	}

	await logDebug("usage response", { url, data });
	const percents = parseUsageResponse(data);
	return { percents, raw: data, fetchedAt: Date.now() };
}

async function maybeRefreshUsage(ctx: ExtensionContext): Promise<void> {
	const now = Date.now();
	if (now - cachedUsage.fetchedAt < USAGE_CACHE_MS) return;
	cachedUsage = await refreshUsage(ctx);
	const status = renderStatus(cachedUsage);
	ctx.ui.setStatus(STATUS_KEY, status);
}

export default function (pi: ExtensionAPI): void {
	let enabled = true;

	pi.registerCommand("statusline", {
		description: "Toggle Opencode GO usage status line",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				ctx.ui.notify("Opencode GO usage status enabled", "info");
				maybeRefreshUsage(ctx).catch(() => {});
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Opencode GO usage status hidden", "info");
			}
		},
	});

	pi.registerCommand("statusline-debug", {
		description: "Show raw Opencode GO usage response",
		handler: async (_args, ctx) => {
			const snapshot = await refreshUsage(ctx);
			if (snapshot.raw) {
				ctx.ui.notify(`Usage: ${JSON.stringify(snapshot.raw).slice(0, 180)}`, "info");
			} else if (snapshot.error) {
				ctx.ui.notify(`Usage error: ${snapshot.error}`, "error");
			} else {
				ctx.ui.notify("No usage data available", "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!enabled) return;
		cachedUsage = { percents: [null, null, null], fetchedAt: 0 };
		maybeRefreshUsage(ctx).catch(() => {});
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!enabled) return;
		cachedUsage = { percents: [null, null, null], fetchedAt: 0 };
		maybeRefreshUsage(ctx).catch(() => {});
	});

	pi.on("message_end", async (_event, ctx) => {
		if (!enabled) return;
		maybeRefreshUsage(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		cachedUsage = { percents: [null, null, null], fetchedAt: 0 };
	});
}
