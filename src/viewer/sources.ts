import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** One finalized thinking block in a transcript. `id` is stable across re-reads of the file. */
export type ThinkingBlock = { id: string; text: string };

/**
 * A harness whose on-disk transcripts the viewer can follow. `find` picks the
 * newest transcript for a working directory; `blocks` pulls the thinking out
 * of one parsed JSONL record.
 */
export type Source = {
	name: string;
	find(cwd: string, env: Record<string, string | undefined>): Promise<string | undefined>;
	blocks(record: unknown, line: number): ThinkingBlock[];
};

type Fields = Map<string, unknown>;

/** A record's own fields; empty for anything that is not a plain object. */
const fieldsOf = (value: unknown): Fields =>
	new Map(value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);

const contentArray = (message: Fields): unknown[] => {
	const content = message.get("content");
	return Array.isArray(content) ? content : [];
};

/** Non-empty `text` fields of `content` blocks of type `kind`, keyed by block index. */
const textBlocks = (content: unknown[], kind: string, textKey: string, idPrefix: string): ThinkingBlock[] =>
	content.flatMap((block, index) => {
		const fields = fieldsOf(block);
		const text = fields.get(textKey);
		return fields.get("type") === kind && typeof text === "string" && text.trim()
			? [{ id: `${idPrefix}:${index}`, text: text.trim() }]
			: [];
	});

/** Newest `*.jsonl` (by mtime) directly in `dir`, skipping names the filter rejects. */
const newestJsonl = async (dir: string, keep: (name: string) => boolean = () => true): Promise<string | undefined> => {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	let best: { path: string; mtime: number } | undefined;
	for (const name of names) {
		if (!name.endsWith(".jsonl") || !keep(name)) continue;
		const path = join(dir, name);
		const { mtimeMs } = await stat(path);
		if (!best || mtimeMs > best.mtime) best = { path, mtime: mtimeMs };
	}
	return best?.path;
};

const home = (env: Record<string, string | undefined>) => env.HOME || homedir();

/** Claude Code: `~/.claude/projects/<cwd, non-alphanumerics as ->/<session>.jsonl`. Thinking text needs `showThinkingSummaries`. */
const claude: Source = {
	name: "claude",
	find: (cwd, env) =>
		newestJsonl(
			join(env.CLAUDE_CONFIG_DIR || join(home(env), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")),
			(name) => !name.startsWith("."),
		),
	blocks: (record) => {
		const fields = fieldsOf(record);
		if (fields.get("type") !== "assistant") return [];
		return textBlocks(contentArray(fieldsOf(fields.get("message"))), "thinking", "thinking", String(fields.get("uuid")));
	},
};

/** Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; reasoning summaries in `response_item` records. */
const codex: Source = {
	name: "codex",
	find: async (cwd, env) => {
		const root = join(env.CODEX_HOME || join(home(env), ".codex"), "sessions");
		// Newest days first; the first rollout whose session_meta names this cwd wins.
		const descend = async (dir: string): Promise<string[]> => {
			try {
				return (await readdir(dir)).sort().reverse().map((name) => join(dir, name));
			} catch {
				return [];
			}
		};
		let checked = 0;
		for (const year of await descend(root)) {
			for (const month of await descend(year)) {
				for (const day of await descend(month)) {
					const files = (await descend(day)).filter((path) => path.endsWith(".jsonl"));
					const dated = await Promise.all(files.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
					for (const { path } of dated.sort((a, b) => b.mtime - a.mtime)) {
						if (++checked > 200) return undefined;
						const first = (await readFile(path, "utf8")).split("\n", 1)[0] ?? "";
						try {
							if (fieldsOf(fieldsOf(JSON.parse(first)).get("payload")).get("cwd") === cwd) return path;
						} catch { }
					}
				}
			}
		}
		return undefined;
	},
	blocks: (record) => {
		const fields = fieldsOf(record);
		const payload = fieldsOf(fields.get("payload"));
		if (fields.get("type") !== "response_item" || payload.get("type") !== "reasoning") return [];
		const parts = [payload.get("summary"), payload.get("content")].flatMap((list) =>
			Array.isArray(list) ? list.map((part) => fieldsOf(part).get("text")) : [],
		);
		const text = parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n\n").trim();
		return text ? [{ id: String(payload.get("id")), text }] : [];
	},
};

/** pi and oh-my-pi share a session record shape: assistant `message` entries with `thinking` blocks. */
const piBlocks = (record: unknown): ThinkingBlock[] => {
	const fields = fieldsOf(record);
	const message = fieldsOf(fields.get("message"));
	if (fields.get("type") !== "message" || message.get("role") !== "assistant") return [];
	return textBlocks(contentArray(message), "thinking", "thinking", String(fields.get("id")));
};

/** pi: `~/.pi/agent/sessions/--<cwd without leading slash, separators as ->--/*.jsonl`. */
const pi: Source = {
	name: "pi",
	find: (cwd, env) =>
		newestJsonl(
			join(
				env.PI_CODING_AGENT_DIR || join(home(env), ".pi", "agent"),
				"sessions",
				`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
			),
		),
	blocks: piBlocks,
};

/** oh-my-pi: `~/.omp/agent/sessions/-<cwd relative to home, / as ->/*.jsonl`. */
const omp: Source = {
	name: "omp",
	find: (cwd, env) => {
		const fromHome = relative(home(env), cwd);
		const key = fromHome.startsWith("..") ? cwd.replace(/\//g, "-") : `-${fromHome.replace(/\//g, "-")}`;
		return newestJsonl(join(env.PI_CODING_AGENT_DIR || join(home(env), ".omp", "agent"), "sessions", key));
	},
	blocks: piBlocks,
};

/**
 * DeepSeek Harness: `~/.dsh/sessions/--<cwd>--/<session>/session.vN.jsonl[.zstd]`,
 * reasoning blocks in settled `assistant/message` records.
 */
const dsh: Source = {
	name: "dsh",
	find: async (cwd, env) => {
		const dir = join(
			env.DSH_HOME || join(home(env), ".dsh"),
			"sessions",
			`--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		);
		let sessions: string[];
		try {
			sessions = await readdir(dir);
		} catch {
			return undefined;
		}
		let best: { path: string; mtime: number; generation: number } | undefined;
		for (const session of sessions) {
			let names: string[];
			try {
				names = await readdir(join(dir, session));
			} catch {
				continue;
			}
			// Highest generation of each session is the canonical log.
			for (const name of names) {
				const generation = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)?.[1];
				if (generation === undefined) continue;
				const path = join(dir, session, name);
				const { mtimeMs } = await stat(path);
				const g = Number(generation);
				if (!best || mtimeMs > best.mtime || (mtimeMs === best.mtime && g > best.generation)) {
					best = { path, mtime: mtimeMs, generation: g };
				}
			}
		}
		return best?.path;
	},
	blocks: (record, line) => {
		const fields = fieldsOf(record);
		if (fields.get("type") !== "assistant/message") return [];
		const message = fieldsOf(fieldsOf(fields.get("data")).get("message"));
		const id = String(message.get("id") ?? fields.get("seq") ?? line);
		return textBlocks(contentArray(message), "reasoning", "text", id);
	},
};

export const SOURCES: Record<string, Source> = { claude, codex, pi, omp, dsh };

/** A transcript's text: zstd-compressed logs (DSH) are decompressed whole. */
export const readTranscript = async (path: string): Promise<string> => {
	const bytes = await readFile(path);
	return path.endsWith(".zstd") ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
};
