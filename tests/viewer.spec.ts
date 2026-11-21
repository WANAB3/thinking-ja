import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { SOURCES, type Source } from "../src/viewer/sources.ts";
import { createFollower } from "../src/viewer/watch.ts";

const dir = mkdtempSync(join(tmpdir(), "thinking-ja-viewer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const THINKING = "I should read the config file first, then run the tests.";

/** One transcript line per harness, in each harness's own record shape, carrying THINKING. */
const RECORDS: Record<string, unknown> = {
	claude: { type: "assistant", uuid: "row-1", message: { content: [{ type: "thinking", thinking: THINKING, signature: "sig" }] } },
	codex: {
		type: "response_item",
		payload: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: THINKING }], encrypted_content: "opaque" },
	},
	pi: { type: "message", id: "e1", message: { role: "assistant", content: [{ type: "thinking", thinking: THINKING }] } },
	omp: { type: "message", id: "e1", message: { role: "assistant", content: [{ type: "thinking", thinking: THINKING }] } },
	dsh: {
		type: "assistant/message",
		data: { message: { id: "m1", role: "assistant", content: [{ type: "reasoning", text: THINKING }, { type: "text", text: "Done." }] } },
	},
};

describe("sources", () => {
	test.each(Object.keys(RECORDS))("%s: reads the thinking text out of its record", (name) => {
		const source = SOURCES[name]!;
		expect(source.blocks(RECORDS[name], 0).map((block) => block.text)).toEqual([THINKING]);
	});

	test("records that carry no readable thinking yield nothing", () => {
		expect(SOURCES.claude!.blocks({ type: "assistant", uuid: "r", message: { content: [{ type: "thinking", thinking: "", signature: "s" }] } }, 0)).toEqual([]);
		expect(SOURCES.codex!.blocks({ type: "response_item", payload: { type: "reasoning", id: "r", summary: [], encrypted_content: "x" } }, 0)).toEqual([]);
		expect(SOURCES.pi!.blocks({ type: "message", id: "e", message: { role: "user", content: [{ type: "thinking", thinking: THINKING }] } }, 0)).toEqual([]);
	});

	test("claude: finds the newest transcript of the working directory's project", async () => {
		const project = join(dir, "claude-home", ".claude", "projects", "-work-my-app");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "old.jsonl"), "");
		const newest = join(project, "new.jsonl");
		writeFileSync(newest, "");
		const later = new Date(Date.now() + 1000);
		utimesSync(newest, later, later);
		expect(await SOURCES.claude!.find("/work/my_app", { HOME: join(dir, "claude-home") })).toBe(newest);
	});
});

/** A follower over `file` whose translator answers `訳:<chunk>`, collecting what it prints. */
const follower = (source: Source, file: string, backlog = 0) => {
	const printed: string[] = [];
	const step = createFollower({
		source,
		attempts: [async (chunk) => `訳:${chunk}`],
		chunkChars: 4000,
		concurrency: 2,
		file,
		cwd: dir,
		env: {},
		backlog,
		original: false,
		write: (line) => printed.push(line),
		signal: new AbortController().signal,
	}).step;
	return { step, translations: () => printed.filter((line) => line.startsWith("訳:")) };
};

const line = (text: string, id: string) =>
	`${JSON.stringify({ type: "message", id, message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } })}\n`;

describe("follower", () => {
	test("skips what the transcript already holds, beyond the backlog, then translates each new block once", async () => {
		const file = join(dir, "session.jsonl");
		writeFileSync(file, line("First existing block of reasoning.", "a") + line("Second existing block of reasoning.", "b"));
		const f = follower(SOURCES.pi!, file, 1);
		await f.step();
		expect(f.translations()).toEqual(["訳:Second existing block of reasoning."]);
		appendFileSync(file, line("A new block arrives after start.", "c"));
		await f.step();
		await f.step();
		expect(f.translations()).toEqual(["訳:Second existing block of reasoning.", "訳:A new block arrives after start."]);
	});

	test("a line written in two parts is translated once it is complete", async () => {
		const file = join(dir, "partial.jsonl");
		writeFileSync(file, "");
		const f = follower(SOURCES.pi!, file);
		await f.step();
		const whole = line("This block is flushed in two writes.", "p");
		appendFileSync(file, whole.slice(0, 40));
		await f.step();
		expect(f.translations()).toEqual([]);
		appendFileSync(file, whole.slice(40));
		await f.step();
		expect(f.translations()).toEqual(["訳:This block is flushed in two writes."]);
	});

	test("dsh: a zstd-compressed log is re-read whole and repeats are dropped", async () => {
		const file = join(dir, "session.v4.jsonl.zstd");
		const record = (id: string, text: string) =>
			`${JSON.stringify({ type: "assistant/message", data: { message: { id, content: [{ type: "reasoning", text }] } } })}\n`;
		writeFileSync(file, zstdCompressSync(Buffer.from(record("m1", "Reasoning already on disk at start."))));
		const f = follower(SOURCES.dsh!, file);
		await f.step();
		writeFileSync(
			file,
			zstdCompressSync(Buffer.from(record("m1", "Reasoning already on disk at start.") + record("m2", "Reasoning settled after start."))),
		);
		await f.step();
		expect(f.translations()).toEqual(["訳:Reasoning settled after start."]);
	});
});
