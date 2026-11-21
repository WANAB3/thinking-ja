import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { chunkPlan, translateBlock, translatorAttempts } from "../../core/block.ts";
import type { Config } from "../../core/config.ts";
import { fetchPost } from "../../core/http.ts";
import { configPath, loadConfig } from "../../core/load.ts";
import { hashText, shouldTranslate, toLines } from "../../core/text.ts";

/**
 * pi adapter: translates each finalized run of assistant thinking in the
 * background and shows the result as a display-only card once it lands
 * (`appendEntry` + `registerEntryRenderer`). Cards are custom session
 * entries, never messages: pi does not send them to the model, and a resumed
 * session renders them again without translating again.
 *
 * Why cards and not text under the thinking block: pi's markdown transformer
 * is synchronous and has no per-message redraw, so a translation finished in
 * the background could not appear under its block until something else
 * rebuilt that message, and awaiting it inside `message_end` would stall the
 * agent for the whole translation.
 *
 * Only the configured translators are used (`configPath()`); there is no LLM
 * fallback, so nothing here spends model tokens.
 */

/** Custom entry type of a translation card. */
const ENTRY_TYPE = "thinking-ja";

type CardData = { hash: string; ja: string };

/**
 * Thinking text as pi displays it: each consecutive run of non-redacted
 * thinking blocks, trimmed and joined with a blank line.
 */
const thinkingRuns = (content: readonly unknown[]): string[] => {
	const runs: string[] = [];
	let run: string[] = [];
	for (const block of [...content, undefined]) {
		const isThinking = !!block && typeof block === "object" && "type" in block && block.type === "thinking";
		if (isThinking) {
			const text = "thinking" in block && typeof block.thinking === "string" ? block.thinking.trim() : "";
			const redacted = "redacted" in block && block.redacted === true;
			if (text && !redacted) run.push(text);
			continue;
		}
		if (run.length) runs.push(run.join("\n\n"));
		run = [];
	}
	return runs;
};

export default function thinkingJa(pi: ExtensionAPI) {
	let config: Config | undefined;
	let enabled = true;
	/** Hashes translated (or in flight) in this session, so no block is bought twice. */
	const seen = new Set<string>();
	/** Card appends chained in thinking order; translations themselves run concurrently. */
	let cards: Promise<void> = Promise.resolve();
	/** Aborted when the session ends, so nothing lands in the next one. */
	let sessionAbort = new AbortController();
	let failureNoticed = false;

	pi.registerEntryRenderer<CardData>(ENTRY_TYPE, (entry, _options, theme) => {
		if (!enabled || !entry.data?.ja) return undefined;
		const lines = toLines(entry.data.ja).map((line) => theme.fg("dim", line));
		return new Text([theme.fg("accent", "思考訳"), ...lines].join("\n"), 1, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionAbort = new AbortController();
		seen.clear();
		cards = Promise.resolve();
		failureNoticed = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data: unknown = entry.data;
			if (data && typeof data === "object" && "hash" in data && typeof data.hash === "string") seen.add(data.hash);
		}
		try {
			config = await loadConfig();
		} catch (error) {
			config = undefined;
			ctx.ui.notify(`thinking-ja: ${configPath()} を読めません (${String(error)})`, "warning");
			return;
		}
		if (!config?.translators.length) {
			ctx.ui.notify(`thinking-ja: ${configPath()} に translators がないため翻訳しません`, "warning");
		}
	});

	pi.on("session_shutdown", () => {
		sessionAbort.abort();
	});

	pi.on("message_end", (event, ctx) => {
		const translators = config?.translators;
		if (!enabled || !translators?.length || event.message.role !== "assistant") return;
		const signal = sessionAbort.signal;
		for (const text of thinkingRuns(event.message.content)) {
			if (!shouldTranslate(text)) continue;
			const hash = hashText(text);
			if (seen.has(hash)) continue;
			seen.add(hash);
			// Started now so blocks translate in parallel; appended in order below.
			const translation = translateBlock(text, {
				attempts: translatorAttempts(translators, fetchPost),
				...chunkPlan(translators),
				signal,
				active: () => enabled,
			}).catch((error: unknown) => {
				seen.delete(hash);
				if (!failureNoticed && !signal.aborted) {
					failureNoticed = true;
					ctx.ui.notify(`thinking-ja: 翻訳に失敗しました (${String(error)})`, "warning");
				}
				return undefined;
			});
			cards = cards.then(async () => {
				const ja = await translation;
				if (ja === undefined || signal.aborted) {
					seen.delete(hash);
					return;
				}
				pi.appendEntry<CardData>(ENTRY_TYPE, { hash, ja });
			});
		}
	});

	pi.registerCommand("thinking-ja", {
		description: "Toggle the Japanese translation cards for thinking blocks",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(
				enabled ? "thinking-ja: 思考の日本語訳を表示します" : "thinking-ja: 思考の日本語訳を停止しました",
				"info",
			);
		},
	});
}
