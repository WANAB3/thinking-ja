import type { Translator } from "./config.ts";
import { hashText, splitChunks } from "./text.ts";
import { type HttpPost, requestTranslation } from "./translator.ts";

/**
 * Split plan when the first translator sets none. A single request for a
 * whole long block runs into the request timeout and lands long after the
 * block scrolled away, so long blocks are cut and translated in parallel.
 */
export const DEFAULT_CHUNK_CHARS = 4000;
export const DEFAULT_CONCURRENCY = 3;

/** One way to translate a chunk. Adapters may append their own, e.g. a harness LLM role. */
export type ChunkAttempt = (chunk: string, signal: AbortSignal) => Promise<string>;

/** Per-chunk results keyed by chunk hash, so a block that grows re-buys only its changed tail. */
export type ChunkCache = {
	get(key: string): string | undefined;
	set(key: string, value: string): void;
};

/** How one chunk is translated: `attempts` in order, results cached by chunk hash. */
export type ChunkOptions = {
	attempts: readonly ChunkAttempt[];
	signal: AbortSignal;
	/** Checked before every attempt; false abandons the chunk. */
	active?: () => boolean;
	cache?: ChunkCache;
	onAttemptError?: (error: unknown, attempt: number) => void;
};

export type BlockOptions = ChunkOptions & {
	chunkChars: number;
	concurrency: number;
};

export const translatorAttempts = (translators: readonly Translator[], post: HttpPost): ChunkAttempt[] =>
	translators.map((translator) => (chunk, signal) => requestTranslation(chunk, translator, post, signal));

/** The first translator's split plan, else the defaults. */
export const chunkPlan = (translators: readonly Translator[]): { chunkChars: number; concurrency: number } => ({
	chunkChars: translators[0]?.chunkChars ?? DEFAULT_CHUNK_CHARS,
	concurrency: translators[0]?.concurrency ?? DEFAULT_CONCURRENCY,
});

/**
 * One chunk's translation, from the cache or from the first attempt that
 * answers. Resolves undefined when abandoned (aborted, or `active()` turned
 * false before an attempt); rejects with the last error once every attempt
 * failed.
 */
export const translateChunk = async (chunk: string, options: ChunkOptions): Promise<string | undefined> => {
	const key = hashText(chunk);
	const cached = options.cache?.get(key);
	if (cached !== undefined) return cached;
	let lastError: unknown = new Error("no translator configured");
	for (const [index, attempt] of options.attempts.entries()) {
		if (options.signal.aborted || options.active?.() === false) return undefined;
		try {
			const ja = (await attempt(chunk, options.signal)).trim();
			if (!ja) throw new Error("empty translation");
			options.cache?.set(key, ja);
			return ja;
		} catch (error) {
			lastError = error;
			options.onAttemptError?.(error, index + 1);
		}
	}
	throw lastError;
};

/**
 * A whole block's translation: split into chunks, up to `concurrency` chunks
 * at a time, each through `translateChunk`, then joined in order. Resolves
 * undefined when abandoned; rejects with the last error once a chunk failed
 * every attempt, so a caller never shows a translation with a hole in it.
 * Chunks still in flight at that point finish into the cache, so a retry
 * re-buys only what failed.
 */
export const translateBlock = async (text: string, options: BlockOptions): Promise<string | undefined> => {
	const chunks = splitChunks(text, options.chunkChars);
	const parts: string[] = [];
	let next = 0;
	let abandoned = false;
	let failure: { error: unknown } | undefined;

	const worker = async () => {
		while (!abandoned && !failure && next < chunks.length) {
			const index = next++;
			const chunk = chunks[index];
			if (chunk === undefined) break;
			try {
				const ja = await translateChunk(chunk, options);
				if (ja === undefined) abandoned = true;
				else parts[index] = ja;
			} catch (error) {
				failure = { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(options.concurrency, chunks.length) }, worker));

	if (abandoned) return undefined;
	if (failure) throw failure.error;
	return parts.join("\n");
};
