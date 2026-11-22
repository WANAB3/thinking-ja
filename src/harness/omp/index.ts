import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { chunkPlan, translateChunk } from "../../core/block.ts";
import type { Config } from "../../core/config.ts";
import { requestStreamingTranslation } from "../../core/http.ts";
import { configPath, loadConfig } from "../../core/load.ts";
import { hashText, nextLiveUnit, plainText, shouldTranslate } from "../../core/text.ts";
import { createInlineTranslation, createTranslationReader } from "./panel.ts";

// Only explicit translator endpoints may receive visible thinking. The host's
// chat models are never translation fallbacks, including when config is absent.

/** Coalesce the final TUI frame when visible thinking differs from the raw event. */
const DEBOUNCE_MS = 500;
/** Cache also guards against re-billing for a historical redraw. */
const MAX_TRANSLATIONS = 2000;
/**
 * In-memory chunk translations, so a long block that grows re-buys only its
 * changed tail. Never persisted: the block-level entry is what resume reads.
 */
const MAX_CHUNKS = 512;
/** An unpunctuated paragraph still gets a first translation while the author is thinking. */
const UNIT_CHARS = 240;

/** Non-LLM cache entries written by `pi.appendEntry`. */
const CACHE_TYPE = "thinking-ja-cache";
/**
 * Marks a persisted translation as covering the block's full text. Entries
 * without it predate chunking, where a block longer than LEGACY_INPUT_CHARS was
 * translated from that prefix alone.
 */
const CACHE_VERSION = 2;
/** The pre-chunking per-request cap; see CACHE_VERSION. */
const LEGACY_INPUT_CHARS = 6000;
/** Custom *messages* left by the superseded message-delivery build; read-only. */
const LEGACY_MESSAGE_TYPE = "thinking-ja";

/* ------------------------------------------------------------------- state */

type Inline = ReturnType<typeof createInlineTranslation>;
/** null means all configured endpoints failed for this occurrence; never cache that draft. */
type Unit = { text: string; key: string; before: string; ja?: string | null };
type Job = { text: string; key: string; draft: string };
type Block = {
	order: number;
	text: string;
	hash: string;
	final: boolean;
	view: Inline;
	timestamp?: number;
	cursor: number;
	prefix: string;
	drawn: string;
	units: Unit[];
	shown: number;
	timer?: ReturnType<ExtensionContext["setTimeout"]>;
};

// The TUI restarts contentIndex after each tool call. Events, on the other
// hand, index the entire assistant message. Keep both on the same source slot.
type Slot = { order: number; local: number; raw: string; ended: boolean; block?: Block };
type Part = { type: string; thinking?: string };

// A TUI frame can trail the provider or omit fenced code and empty comments.
// Raw text is used only to identify the slot, never as translation input.
function matchesDisplay(raw: string, visible: string): boolean {
	if (raw.trimStart().startsWith(visible)) return true;
	if (!raw.includes("```") && !raw.includes("~~~") && !raw.includes("<!--")) return false;
	let from = 0;
	for (const line of visible.split("\n")) {
		const literal = line.trim().replace(/\.{1,3}$/, "");
		if (!literal) continue;
		const at = raw.indexOf(literal, from);
		if (at < 0) return false;
		from = at + literal.length;
	}
	return true;
}

/* --------------------------------------------------------- history seeding */

/**
 * Every payload shape this extension has ever persisted, flattened to an item
 * list: a cache entry's `data` and a pre-batch `details` are each already one
 * item; a batched message carries `details.items`.
 */
const payloadItems = (payload: unknown): unknown[] => {
	if (!payload || typeof payload !== "object") return [];
	if ("items" in payload) return Array.isArray(payload.items) ? payload.items : [];
	return [payload];
};

/** One string field off a stored item, or off one of its `pairs`. */
const stringField = (item: unknown, key: "hash" | "ja"): string => {
	if (!item || typeof item !== "object" || !(key in item)) return "";
	const value: unknown = key === "hash" && "hash" in item ? item.hash : "ja" in item ? item.ja : undefined;
	return typeof value === "string" ? value : "";
};

/**
 * The block length a cache hash was salted with — `hashText` writes
 * `${hash}.${text.length}` — or 0 when the hash carries no such suffix.
 */
const hashedLength = (hash: string): number => {
	const length = Number(hash.slice(hash.lastIndexOf(".") + 1));
	return Number.isInteger(length) ? length : 0;
};

/** An item's interleaved EN/JA pairs; every other shape reads as none. */
const itemPairs = (item: unknown): unknown[] => {
	if (!item || typeof item !== "object" || !("pairs" in item)) return [];
	return Array.isArray(item.pairs) ? item.pairs : [];
};

function openSession(pi: ExtensionAPI, context: ExtensionContext, config: Config | undefined) {
	const reader = createTranslationReader(context.ui, pi.pi);
	const sessionAbort = new AbortController();
	const translators = config?.translators ?? [];
	const plan = chunkPlan(translators);
	const unitChars = Math.min(UNIT_CHARS, plan.chunkChars);
	const translations = new Map<string, string>();
	const chunkTranslations = new Map<string, string>();
	const history = new Map<number, string>();
	const historyViews = new Map<string, Inline>();
	const active = new Set<Block>();
	const slots = new Map<number, Slot>();
	// A frame may arrive before the stream event that identifies it.
	const unbound = new Map<number, { text: string; view: Inline }>();
	const unitQueue: Job[] = [];
	const unitsPending = new Map<string, Job>();
	const replay = new Set<number>();
	let unitsActive = 0;
	let order = 0;
	let replyTimestamp: number | undefined;
	let redraw: (() => void) | undefined;
	let dim = (text: string) => text;
	let streaming = false;
	let enabled = true;

	function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number) {
		map.set(key, value);
		if (map.size > cap) map.delete(map.keys().next().value!);
	}

	function makeView(text: string): Inline {
		return createInlineTranslation(pi.pi, text, line => dim(line), () => enabled && !sessionAbort.signal.aborted);
	}

	function draw(block: Block, ja: string, complete: boolean) {
		if (!complete && block.drawn === ja) return;
		block.drawn = ja;
		block.view.setTranslation(plainText(ja), complete);
		redraw?.();
	}

	function settle(block: Block) {
		const ja = plainText(block.prefix);
		remember(translations, block.hash, ja, MAX_TRANSLATIONS);
		try {
			pi.appendEntry(CACHE_TYPE, { hash: block.hash, ja, v: CACHE_VERSION, order: block.order });
		} catch (error) {
			pi.logger.warn(`thinking-ja: cache persist failed (${block.hash}): ${String(error)}`);
		}
		finish(block, ja);
	}

	// On failure keep the confirmed prefix on screen, but never persist it as a full translation.
	function finish(block: Block, ja?: string) {
		clearTimer(block);
		active.delete(block);
		block.units = [];
		remember(historyViews, block.hash, block.view, 200);
		if (ja === undefined) block.view.setSource("");
		else remember(history, block.order, ja, MAX_TRANSLATIONS);
		draw(block, ja ?? block.prefix, true);
		// Only a complete translation can replay retired scrollback; never replay for a draft.
		const stamp = block.timestamp;
		if (ja !== undefined && stamp !== undefined && !replay.has(stamp)) {
			replay.add(stamp);
			queueMicrotask(() => {
				replay.delete(stamp);
				if (enabled && !sessionAbort.signal.aborted) context.ui.rerenderMessage(stamp);
			});
		}
	}

	function clearTimer(block: Block) {
		if (block.timer !== undefined) context.clearTimer(block.timer);
		block.timer = undefined;
	}

	function setUnits(block: Block, source = block.text) {
		if (block.units[block.shown]?.ja === null) return;
		for (; ;) {
			const span = nextLiveUnit(source, block.cursor, unitChars, block.final);
			if (!span) return;
			block.cursor = span.end;
			block.units.push({ text: span.text, before: span.before, key: hashText(span.text) });
		}
	}

	// Only the first unfinished unit is visible. Faster later requests and
	// their drafts cannot jump ahead of it or move already readable sentences.
	function drawDraft(block: Block) {
		const next = block.units[block.shown];
		const draft = next && next.ja !== null && unitsPending.get(next.key)?.draft;
		draw(block, draft ? block.prefix + next.before + draft : block.prefix, false);
	}

	function refresh(block: Block) {
		if (sessionAbort.signal.aborted) return;
		if (block.final) {
			const cached = translations.get(block.hash);
			if (cached !== undefined) return finish(block, cached);
		}
		if (!enabled) return;
		for (let i = block.shown; i < block.units.length; i++) {
			const unit = block.units[i]!;
			if (unit.ja === null) {
				// An earlier request can still finish out of order. Never show text after a gap.
				if (block.final && i === block.shown) return finish(block);
				break;
			}
			unit.ja ??= chunkTranslations.get(unit.key);
			if (unit.ja !== undefined) {
				if (i === block.shown) {
					block.prefix += unit.before + unit.ja;
					block.shown++;
				}
			} else if (!unitsPending.has(unit.key)) {
				const job = { text: unit.text, key: unit.key, draft: "" };
				unitsPending.set(unit.key, job);
				unitQueue.push(job);
			}
		}
		pumpUnits();
		if (block.final && block.shown && block.shown === block.units.length) {
			settle(block);
		} else drawDraft(block);
	}

	function pumpUnits() {
		while (enabled && unitsActive < plan.concurrency && unitQueue.length) {
			const job = unitQueue.shift()!;
			unitsActive++;
			const publish = (delta: string) => {
				job.draft += delta;
				if (!enabled || sessionAbort.signal.aborted) return;
				for (const block of active) {
					if (block.units[block.shown]?.key === job.key) drawDraft(block);
				}
			};
			void translateChunk(job.text, {
				attempts: translators.map((translator) => (chunk, signal) => {
					if (job.draft) { job.draft = ""; publish(""); }
					return requestStreamingTranslation(chunk, translator, signal, publish);
				}),
				signal: sessionAbort.signal,
				active: () => enabled,
				onAttemptError: (error, attempt) =>
					pi.logger.debug(`thinking-ja: live attempt ${attempt} failed: ${String(error)}`),
			}).then((ja) => {
				if (ja !== undefined) remember(chunkTranslations, job.key, ja, MAX_CHUNKS);
			}, (error: unknown) => {
				if (sessionAbort.signal.aborted) return;
				for (const block of active) {
					for (const unit of block.units) {
						if (unit.key === job.key && unit.ja === undefined) unit.ja = null;
					}
				}
				pi.logger.debug(`thinking-ja: live translation gave up: ${String(error)}`);
			}).finally(() => {
				unitsActive--;
				unitsPending.delete(job.key);
				if (sessionAbort.signal.aborted) return;
				for (const waiting of active) refresh(waiting);
				pumpUnits();
			});
		}
	}

	function newBlock(text: string, rank: number, view = makeView(text)): Block {
		const block: Block = {
			order: rank, text, hash: hashText(text), final: false, view,
			cursor: 0, units: [], shown: 0, prefix: "", drawn: "",
		};
		active.add(block);
		return block;
	}

	function seal(slot: Slot) {
		const block = slot.block;
		if (!block || !slot.ended || block.final) return;
		const close = () => {
			clearTimer(block);
			block.final = true;
			setUnits(block);
			refresh(block);
		};
		if (slot.raw.trim() === block.text) close();
		// A delayed reveal of plain text still owes us a visible suffix. Don't
		// persist a translation of its prefix as if the block had finished.
		else if ((!slot.raw.trimStart().startsWith(block.text) || /```|~~~|<!--/.test(slot.raw)) && block.timer === undefined) {
			block.timer = context.setTimeout(close, DEBOUNCE_MS);
		}
	}

	function identify(local: number, text: string): Slot | undefined {
		let exact: Slot | undefined;
		let seen: Slot | undefined;
		let candidate: Slot | undefined;
		let matches = 0;
		for (const slot of slots.values()) {
			if (slot.local !== local) continue;
			if (slot.raw.trim() === text) exact = slot;
			else if (slot.block?.text === text) seen = slot;
			else if (matchesDisplay(slot.raw, text)) {
				candidate = slot;
				matches++;
			}
		}
		// Equal prefixes on opposite sides of a tool are not block identities.
		// Wait for a distinguishing frame rather than sealing the wrong paragraph.
		return exact ?? seen ?? (matches === 1 ? candidate : undefined);
	}

	function observe(slot: Slot, text: string, previousView?: Inline): Inline {
		let block = slot.block;
		// The UI may already have mounted the newer frame before its event
		// identifies the slot. Move both existing Japanese and future deltas to it.
		if (block && previousView && previousView !== block.view) {
			block.view = previousView;
			if (block.drawn && text.startsWith(block.text)) {
				const complete = block.final && block.text === text && !active.has(block);
				previousView.setTranslation(plainText(block.drawn), complete);
				if (complete) remember(historyViews, block.hash, previousView, 200);
				redraw?.();
			}
		}
		if (!block || block.text !== text) {
			if (!block) {
				block = slot.block = newBlock(text, slot.order, previousView);
				block.timestamp = replyTimestamp;
			} else {
				clearTimer(block);
				if (block.final || !text.startsWith(block.text)) {
					if (historyViews.get(block.hash) === block.view) historyViews.delete(block.hash);
					block.cursor = block.shown = 0;
					block.units.length = 0;
					block.prefix = "";
					draw(block, "", false);
				}
				block.view.setSource(text);
				block.text = text;
				block.hash = hashText(text);
				block.final = false;
				active.add(block);
			}
			setUnits(block, slot.raw.trim() === text ? slot.raw.trimStart() : text);
			if (!slot.ended || slot.raw.trim() !== text) refresh(block);
		}
		seal(slot);
		return block.view;
	}

	function snapshot(parts: readonly Part[], index: number, ended: boolean) {
		if (!translators.length) return;
		const part = parts[index];
		if (part?.type !== "thinking" || typeof part.thinking !== "string") return;
		let slot = slots.get(index);
		if (!slot) {
			let offset = index;
			while (offset > 0 && parts[offset - 1]?.type !== "toolCall") offset--;
			slot = { order: ++order, local: index - offset, raw: "", ended: false };
			slots.set(index, slot);
		}
		slot.raw = part.thinking;
		slot.ended ||= ended;
		const pending = unbound.get(slot.local);
		if (pending) {
			const owner = identify(slot.local, pending.text);
			if (owner) {
				unbound.delete(slot.local);
				observe(owner, pending.text, pending.view);
			}
		}
		const block = slot.block;
		if (block && !slot.ended && /\s$/.test(slot.raw) && slot.raw.trim() === block.text) {
			// The renderer trims the space that seals a sentence ("Done. ").
			setUnits(block, slot.raw.trimStart());
			refresh(block);
		}
		seal(slot);
	}

	/* ---------------------------------------------------------------- events */

	/** Cache one persisted item; `true` when it was new to this session. */
	const seedTranslation = (item: unknown): boolean => {
		const hash = stringField(item, "hash");
		if (!hash || translations.has(hash)) return false;
		const version = item && typeof item === "object" && "v" in item ? item.v : undefined;
		const whole = typeof version === "number" && version >= CACHE_VERSION;
		// A pre-chunking entry for a block past the old cap holds only its head.
		if (!whole && hashedLength(hash) > LEGACY_INPUT_CHARS) return false;
		let ja = stringField(item, "ja");
		if (!ja) {
			// Interleave-era items keep the Japanese one level down, per EN/JA pair.
			const parts: string[] = [];
			for (const pair of itemPairs(item)) {
				const part = stringField(pair, "ja");
				if (part) parts.push(part);
			}
			ja = parts.join("\n");
		}
		if (!ja) return false;
		const text = plainText(ja);
		remember(translations, hash, text, MAX_TRANSLATIONS);
		const rank = item && typeof item === "object" && "order" in item ? item.order : undefined;
		const position = typeof rank === "number" && Number.isSafeInteger(rank) && rank > 0 && !history.has(rank)
			? rank : order + 1;
		order = Math.max(order, position);
		remember(history, position, text, MAX_TRANSLATIONS);
		return true;
	};

	{
		let seeded = 0;
		try {
			for (const entry of context.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === CACHE_TYPE) {
					if (seedTranslation(entry.data)) seeded++;
					continue;
				}
				if (entry.type !== "custom_message" || entry.customType !== LEGACY_MESSAGE_TYPE) continue;
				for (const item of payloadItems(entry.details)) {
					if (seedTranslation(item)) seeded++;
				}
			}
		} catch (error) {
			pi.logger.warn(`thinking-ja: history seed failed: ${String(error)}`);
		}
		if (seeded) pi.logger.debug(`thinking-ja: restored ${seeded} translation(s)`);
	}

	return {
		start(parts: readonly Part[], timestamp: number) {
			streaming = true;
			replyTimestamp = timestamp;
			slots.clear();
			unbound.clear();
			for (let i = 0; i < parts.length; i++) snapshot(parts, i, false);
		},
		update: snapshot,
		end(parts: readonly Part[]) {
			for (let i = 0; i < parts.length; i++) snapshot(parts, i, true);
			for (const slot of slots.values()) {
				if (!slot.ended) { slot.ended = true; seal(slot); }
			}
			streaming = false;
			unbound.clear();
		},
		render(local: number, text: string, requestRender: () => void, style: (line: string) => string) {
			redraw = requestRender;
			dim = style;
			if (!shouldTranslate(text)) return;
			const slot = identify(local, text);
			if (slot) return observe(slot, text);
			const hash = hashText(text);
			const mounted = historyViews.get(hash);
			if (mounted) return mounted;
			const cached = translations.get(hash);
			if (cached !== undefined) {
				const view = makeView(text);
				view.setTranslation(cached, true);
				remember(historyViews, hash, view, 200);
				return view;
			}
			if (!translators.length) return;
			if (streaming) {
				const pending = unbound.get(local);
				if (pending && text.startsWith(pending.text)) {
					pending.text = text;
					pending.view.setSource(text);
					return pending.view;
				}
				const view = makeView(text);
				unbound.set(local, { text, view });
				return view;
			}
			for (const block of active) if (block.hash === hash) return block.view;
			const block = newBlock(text, ++order);
			block.final = true;
			setUnits(block);
			refresh(block);
			return block.view;
		},
		toggle() {
			enabled = !enabled;
			if (enabled) for (const block of active) refresh(block);
			redraw?.();
		},
		show() {
			const entries = new Map(history);
			for (const block of active) if (block.drawn) entries.set(block.order, plainText(block.drawn));
			return reader.show([...entries].sort(([a], [b]) => a - b).map(([, ja]) => ja));
		},
		dispose() {
			sessionAbort.abort();
			for (const block of active) clearTimer(block);
			unitQueue.length = 0;
			reader.dispose();
			active.clear();
		},
	};
}

export default function thinkingJa(pi: ExtensionAPI) {
	let session: ReturnType<typeof openSession> | undefined;
	pi.on("session_start", async (_event, ctx) => {
		session?.dispose();
		session = undefined;
		if (ctx.mode !== "tui") return;
		let config: Config | undefined;
		try {
			config = await loadConfig();
		} catch (error) {
			pi.logger.warn(`thinking-ja: ignoring ${configPath()}: ${String(error)}`);
			ctx.ui.notify(`thinking-ja: ${configPath()} を読み込めないため、新しい思考は翻訳しません`, "warning");
		}
		session = openSession(pi, ctx, config);
	});
	pi.on("session_shutdown", () => { session?.dispose(); session = undefined; });
	pi.on("message_start", ({ message }) => {
		if (message.role === "assistant") session?.start(message.content, message.timestamp);
	});
	pi.on("message_update", ({ assistantMessageEvent: update }) => {
		if (update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end") {
			session?.update(update.partial.content, update.contentIndex, update.type === "thinking_end");
		}
	});
	pi.on("message_end", ({ message }) => {
		if (message.role === "assistant") session?.end(message.content);
	});

	// Sessions from the superseded message-delivery build still carry its
	// `[thinking-ja] (思考訳)` marker messages; keep them out of provider
	// context. New builds emit no messages, so this only touches old sessions.
	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === LEGACY_MESSAGE_TYPE),
		),
	}));

	pi.registerCommand("thinking-ja", {
		description: "思考の直下に日本語訳を表示／停止。/thinking-ja show で訳の履歴を読む",
		handler: async (args, ctx) => {
			if (args.trim() === "show") await session?.show();
			else if (!args.trim()) session?.toggle();
			else ctx.ui.notify("翻訳の切り替え: /thinking-ja　履歴: /thinking-ja show", "info");
		},
	});
	pi.registerAssistantThinkingRenderer(({ contentIndex, text, requestRender }, theme) =>
		session?.render(contentIndex, text.trim(), requestRender, line => theme.fg("dim", line)));
}
