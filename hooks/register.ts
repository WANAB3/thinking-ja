import type { Register } from "claude-code";
import { chunkPlan, translateBlock, translatorAttempts } from "../src/core/block.ts";
import { type Config, parseConfig } from "../src/core/config.ts";
import { hashText, plainText, shouldTranslate } from "../src/core/text.ts";
import type { HttpPost } from "../src/core/translator.ts";

/*
 * Claude Code adapter (a mod): when a thinking block is kept in the main
 * conversation, places a display-only row right under it and fills the row
 * with the Japanese translation once the configured translator answers.
 * Placed rows are never read by Claude or written to the transcript file.
 *
 * Claude Code records thinking text only with `"showThinkingSummaries": true`
 * in its settings; otherwise the blocks are empty and nothing is placed.
 *
 * The mod runtime has no Node.js, fetch or timers: the config comes through
 * `$.fs`, requests through `$.http.fetch`, and the translation runs from
 * `$.clock.after` so the conversation never waits for it.
 */

/** Rows placed this session: row id -> translation, "" while pending. */
const rows = new Map<string, string>();
let config: Config | undefined;
let failureLogged = false;

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		rows.clear();
		failureLogged = false;
		config = undefined;
		const path =
			(await $.env.get("THINKING_JA_CONFIG")) ||
			`${(await $.env.get("XDG_CONFIG_HOME")) || `${await $.env.get("HOME")}/.config`}/thinking-ja/config.json`;
		try {
			if (await $.fs.exists(path)) config = parseConfig(JSON.parse(await $.fs.read(path)));
			else $.ui.log(`thinking-ja: ${path} がないため翻訳しません`);
		} catch (error) {
			$.ui.log(`thinking-ja: ${path} を使えません (${String(error)})`);
		}
		if (config && (await $.settings.read({ key: "showThinkingSummaries" })) !== true) {
			$.ui.log('thinking-ja: 思考の本文が記録されません。settings.json に "showThinkingSummaries": true を設定してください');
		}
		return next(e);
	});

	on("session.append", { door: "response" }, async ($, e, next) => {
		const kept = await next(e);
		const translators = config?.translators;
		if (!translators?.length || e.agentId !== undefined || e.message.type !== "assistant") return kept;
		const text = e.message.content
			.flatMap((block) => (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() ? [block.thinking.trim()] : []))
			.join("\n\n");
		if (!shouldTranslate(text)) return kept;
		// Row ids allow letters, digits, `_` and `-`; one row per distinct text.
		const id = `t${hashText(text).replace(".", "-")}`;
		if (rows.has(id)) return kept;
		rows.set(id, "");
		// Placed now, before the reply's next block is appended, so it sits under the thinking.
		const placed = await $.ui.place({ id });
		const post: HttpPost = async (url, body) => {
			const reply = await $.http.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
			return { status: reply.status, text: reply.text };
		};
		$.clock.after(0, async () => {
			try {
				const ja = await translateBlock(text, {
					attempts: translatorAttempts(translators, post),
					...chunkPlan(translators),
					signal: new AbortController().signal,
				});
				if (ja === undefined) return;
				rows.set(id, ja);
				if (placed.isPlaced) $.ui.invalidate("ui.render");
				else $.ui.log(ja);
			} catch (error) {
				rows.delete(id);
				if (failureLogged) return;
				failureLogged = true;
				$.ui.log(`thinking-ja: 翻訳に失敗しました (${String(error)})`);
			}
		});
		return kept;
	});

	on("ui.render", { component: "Placed" }, async ($, e, next) => {
		const ja = e.props.plugin === $.plugin.name ? rows.get(e.props.id) : undefined;
		// Pending or not ours: passing draws nothing.
		if (!ja) return next(e);
		const { Text } = $.ui.resolve(e);
		return Text({ children: [plainText(ja)], dimColor: true });
	});
};
