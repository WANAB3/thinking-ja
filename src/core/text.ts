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

/**
 * A block cut into translation units as it streams: every paragraph already
 * closed by a blank line, cut with `splitChunks` when longer than `max`, and of
 * the paragraph still being written every piece but its growing last one.
 * `final` closes that paragraph too. A unit, once returned, comes back
 * byte-identical however the block grows, so each is translated exactly once,
 * as soon as it closes.
 */
export const paragraphUnits = (text: string, max: number, final: boolean): string[] => {
	const cut = final ? text.length : text.lastIndexOf("\n\n");
	const units: string[] = [];
	for (const paragraph of cut > 0 ? text.slice(0, cut).split("\n\n") : []) {
		const trimmed = paragraph.trim();
		if (trimmed) units.push(...splitChunks(trimmed, max));
	}
	const open = final ? "" : text.slice(cut < 0 ? 0 : cut + 2).trim();
	if (open.length > max) units.push(...splitChunks(open, max).slice(0, -1));
	return units;
};

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
