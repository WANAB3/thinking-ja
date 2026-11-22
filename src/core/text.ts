/** Blocks shorter than this are left untranslated. */
export const MIN_TRANSLATABLE_CHARS = 16;

/**
 * Kana-dominance gate: a block counts as already Japanese only when it has at
 * least MIN_KANA_CHARS kana AND kana are more than KANA_LETTER_RATIO of its
 * letters (kana + Han + Latin). Kana, not Han, is the signal: Japanese prose
 * is always kana-laced through particles and inflections, while a Chinese
 * block is Han-only and must still be translated. An English block quoting a
 * short Japanese phrase stays far below both bars.
 */
const MIN_KANA_CHARS = 10;
const KANA_LETTER_RATIO = 0.2;

/** Kana, Han and Latin letter counts. */
export const letterCounts = (text: string): { kana: number; han: number; latin: number } => {
	let kana = 0;
	let han = 0;
	let latin = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) kana++;
		else if (code >= 0x4e00 && code <= 0x9fff) han++;
		else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
	}
	return { kana, han, latin };
};

/** True when a block is worth translating: long enough and not already Japanese. */
export const shouldTranslate = (text: string): boolean => {
	if (text.trim().length < MIN_TRANSLATABLE_CHARS) return false;
	const { kana, han, latin } = letterCounts(text);
	const letters = kana + han + latin;
	return !(kana >= MIN_KANA_CHARS && letters > 0 && kana / letters > KANA_LETTER_RATIO);
};

/** `zh` when Han outnumbers Latin letters, else `en`; Japanese never gets this far. */
export const sourceLang = (text: string): "zh" | "en" => {
	const { han, latin } = letterCounts(text);
	return han > latin ? "zh" : "en";
};

/**
 * Cut points tried in order when a piece is too long: paragraph, line, sentence
 * (Latin, then CJK — a Chinese block has no spaces to fall back on), word.
 */
const CHUNK_SEPARATORS = ["\n\n", "\n", ". ", "。", " "];

/**
 * Splits a block into pieces of at most `max` chars, cutting at the coarsest
 * boundary that fits and hard-cutting only a run with no separator at all.
 * Packing is greedy from the start, so when a block grows by appending, every
 * chunk except its previous last one comes back byte-identical, which lets a
 * chunk cache reuse them.
 */
export const splitChunks = (text: string, max: number, level = 0): string[] => {
	if (text.length <= max) return [text];
	const separator = CHUNK_SEPARATORS[level];
	if (separator === undefined) {
		const pieces: string[] = [];
		for (let at = 0; at < text.length; at += max) pieces.push(text.slice(at, at + max));
		return pieces;
	}
	const chunks: string[] = [];
	let current = "";
	for (const part of text.split(separator)) {
		if (!part.trim()) continue;
		const joined = current ? current + separator + part : part;
		if (joined.length <= max) {
			current = joined;
			continue;
		}
		if (current) chunks.push(current);
		current = "";
		if (part.length <= max) current = part;
		else chunks.push(...splitChunks(part, max, level + 1));
	}
	if (current) chunks.push(current);
	return chunks;
};

const SPACE = /\s/u;
const SENTENCE_END = /[.!?。！？]/u;
const CJK_END = /[。！？]/u;
const CLOSING_QUOTE = /["'”’」』)\]]/u;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|mr|mrs|ms|dr|vs)|\b[A-Z])\.$/i;

/** Return only a sealed source span. Keep `end` as the next cursor, before its whitespace. */
export function nextLiveUnit(source: string, from: number, max: number, final: boolean) {
	let start = from;
	let breaks = 0;
	while (start < source.length && SPACE.test(source[start]!)) {
		if (source[start] === "\n") breaks++;
		start++;
	}
	if (start >= source.length) return;
	const before = from === 0 ? "" : breaks > 1 ? "\n\n" : breaks ? "\n" : "";
	const span = (bound: number) => {
		const text = source.slice(start, bound).trimEnd();
		return { text, before, end: start + text.length };
	};
	const limit = Math.min(start + max, source.length);
	let wordEnd = start;
	for (let i = start; i < limit; i++) {
		const c = source[i]!;
		if (c === "\n" || c === "\r") return span(i);
		if (SPACE.test(c)) {
			if (!SPACE.test(source[i - 1]!)) wordEnd = i;
			continue;
		}
		if (!SENTENCE_END.test(c)) continue;
		let end = i + 1;
		while (end < limit && (SENTENCE_END.test(source[end]!) || CLOSING_QUOTE.test(source[end]!))) end++;
		// Wait for lookahead: a dot may still become part of a filename, a
		// decimal, or an ellipsis. A newline always seals the preceding line.
		if (end < source.length && (CJK_END.test(c) || SPACE.test(source[end]!)) &&
			!(c === "." && ABBREVIATION.test(source.slice(Math.max(start, i - 5), i + 1)))) return span(end);
		i = end - 1;
	}
	if (limit === source.length) return final ? span(limit) : undefined;
	if (SPACE.test(source[limit]!)) return span(limit);
	if (wordEnd > start) return span(wordEnd);
	// A single astral character is indivisible even when the configured cap is one.
	const surrogate = source.charCodeAt(limit) >= 0xdc00 && source.charCodeAt(limit) <= 0xdfff;
	return span(surrogate ? (limit - start > 1 ? limit - 1 : limit + 1) : limit);
}

/** FNV-1a over the text, salted with its length: a stable cache key. */
export const hashText = (text: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${(h >>> 0).toString(36)}.${text.length}`;
};

/** A whole line in bold with no other `**` inside: how thinking summaries title a step. */
const BOLD_LINE = /^(\s*)\*\*((?:(?!\*\*).)+)\*\*\s*$/;

/**
 * A translation for views that show plain text: a whole-line `**heading**`
 * outside code fences loses its markers. Every other `**` stays, so
 * `**kwargs`, `a ** b` and `**` glob segments are shown as the model wrote them.
 */
export const plainText = (ja: string): string => {
	let fenced = false;
	return ja
		.split("\n")
		.map((line) => {
			if (line.trimStart().startsWith("```")) fenced = !fenced;
			else if (!fenced) return line.replace(BOLD_LINE, "$1$2");
			return line;
		})
		.join("\n");
};

/** Renderable lines of a translation: plain text, blank lines dropped. */
export const toLines = (ja: string): string[] => {
	const lines: string[] = [];
	for (const raw of plainText(ja).split("\n")) {
		const line = raw.trimEnd();
		if (line.length > 0) lines.push(line);
	}
	return lines;
};
