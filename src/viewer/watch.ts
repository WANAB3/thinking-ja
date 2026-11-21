import { open, stat } from "node:fs/promises";
import { type ChunkAttempt, translateBlock } from "../core/block.ts";
import { plainText, shouldTranslate } from "../core/text.ts";
import type { Source, ThinkingBlock } from "./sources.ts";
import { readTranscript } from "./sources.ts";

export type FollowerOptions = {
	source: Source;
	attempts: readonly ChunkAttempt[];
	chunkChars: number;
	concurrency: number;
	/** Fixed transcript; otherwise the source's newest one for `cwd`, picked again as sessions change. */
	file?: string;
	cwd: string;
	env: Record<string, string | undefined>;
	/** Existing blocks to translate when a transcript is first opened; later blocks are always translated. */
	backlog: number;
	/** Print the original text above each translation. */
	original: boolean;
	write: (line: string) => void;
	signal: AbortSignal;
};

/** Plain JSONL is read incrementally from `offset`; compressed logs are re-read whole. */
type Cursor = { path: string; offset: number; partial: string; size: number };

/** How often the newest transcript is looked up again, to follow a new session. */
const FIND_INTERVAL_MS = 5000;

/**
 * Follows one harness's transcript and prints a translation for every new
 * thinking block, in transcript order. `step()` does one poll: pick the
 * transcript, read what was appended, translate what is new.
 */
export const createFollower = (options: FollowerOptions) => {
	const seen = new Set<string>();
	let cursor: Cursor | undefined;
	let foundAt = Number.NEGATIVE_INFINITY;
	const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

	const show = async (block: ThinkingBlock) => {
		const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
		options.write(dim(`── ${time} ${options.source.name} ──`));
		if (options.original) options.write(dim(block.text));
		try {
			const ja = await translateBlock(block.text, {
				attempts: options.attempts,
				chunkChars: options.chunkChars,
				concurrency: options.concurrency,
				signal: options.signal,
			});
			if (ja !== undefined) options.write(plainText(ja));
		} catch (error) {
			options.write(`(翻訳に失敗しました: ${String(error)})`);
		}
	};

	/** New complete lines of the transcript since the last read. */
	const readNew = async (): Promise<string[]> => {
		if (!cursor) return [];
		const size = (await stat(cursor.path).catch(() => undefined))?.size;
		if (size === undefined || size === cursor.size) return [];
		if (cursor.path.endsWith(".zstd") || size < cursor.offset) {
			// Compressed or truncated: read everything again; `seen` drops repeats.
			cursor = { ...cursor, offset: 0, partial: "" };
			const text = await readTranscript(cursor.path);
			cursor.size = size;
			return text.split("\n").filter((line) => line.trim());
		}
		const handle = await open(cursor.path, "r");
		try {
			const buffer = Buffer.alloc(size - cursor.offset);
			await handle.read(buffer, 0, buffer.length, cursor.offset);
			const text = cursor.partial + buffer.toString("utf8");
			const lines = text.split("\n");
			cursor.partial = lines.pop() ?? "";
			cursor.offset = size;
			cursor.size = size;
			return lines.filter((line) => line.trim());
		} finally {
			await handle.close();
		}
	};

	const step = async (): Promise<void> => {
		let path = options.file ?? cursor?.path;
		if (!options.file && Date.now() - foundAt >= FIND_INTERVAL_MS) {
			path = (await options.source.find(options.cwd, options.env)) ?? path;
			foundAt = Date.now();
		}
		const opened = path !== undefined && path !== cursor?.path;
		if (path !== undefined && opened) {
			cursor = { path, offset: 0, partial: "", size: -1 };
			options.write(dim(`── ${options.source.name}: ${path} ──`));
		}
		const fresh: ThinkingBlock[] = [];
		for (const [index, line] of (await readNew()).entries()) {
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			for (const block of options.source.blocks(record, index)) {
				if (seen.has(block.id)) continue;
				seen.add(block.id);
				if (shouldTranslate(block.text)) fresh.push(block);
			}
		}
		const todo = opened ? fresh.slice(fresh.length - Math.min(options.backlog, fresh.length)) : fresh;
		for (const block of todo) {
			if (options.signal.aborted) return;
			await show(block);
		}
	};

	return { step };
};

/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal.addEventListener("abort", done, { once: true });
	return promise;
};

/** Runs a follower until `signal` aborts, polling every `intervalMs`. */
export const follow = async (options: FollowerOptions, intervalMs = 500): Promise<void> => {
	const follower = createFollower(options);
	while (!options.signal.aborted) {
		await follower.step();
		await sleep(intervalMs, options.signal);
	}
};
