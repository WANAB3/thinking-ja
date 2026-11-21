import type { IncomingMessage, ServerResponse } from "node:http";
import { chunkPlan, translateBlock, translatorAttempts } from "../../core/block.ts";
import { fetchPost } from "../../core/http.ts";
import { configPath, loadConfig } from "../../core/load.ts";
import { hashText } from "../../core/text.ts";

/*
 * DeepSeek Harness, Host half: one same-origin route the browser half posts
 * expanded reasoning to. It reads the shared config on every request, so
 * edits apply without a restart, and answers from an in-memory cache when the
 * same reasoning is expanded again. Nothing is written to the Session: the
 * translation never reaches the model or the session log.
 */

/** The route the browser half posts `{ text }` to; it answers `{ ja }`. */
export const TRANSLATE_PATH = "/_thinking-ja/translate";
/** Reasoning is prose; a body past this is not a reasoning block. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CACHED = 500;

/** Cordis plugin name; equals the package name, as the bundle patch inserts it. */
export const name = "thinking-ja";
/** webServer carries the route; connection is the Host/Origin trust fence. */
export const inject = ["webServer", "connection"];

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** The parts of the Host context this plugin uses. */
type HostContext = {
	webServer: { register(route: { kind: "exact"; path: string; handler: Handler }): () => void };
	connection: { requestRejection(request: IncomingMessage): number | undefined };
	effect(callback: () => (() => void) | undefined, label?: string): unknown;
	logger: { warn(message: string): void };
};

const send = (response: ServerResponse, status: number, body: Record<string, string>) => {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(body));
};

/** The request body as text, or undefined once it passes MAX_BODY_BYTES. */
const readBody = async (request: IncomingMessage): Promise<string | undefined> => {
	const parts: Buffer[] = [];
	let size = 0;
	for await (const part of request) {
		const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return undefined;
		parts.push(buffer);
	}
	return Buffer.concat(parts).toString("utf8");
};

export function apply(ctx: HostContext) {
	const lifetime = new AbortController();
	/** hash(reasoning) -> its translation, shared by concurrent and repeated requests. */
	const cache = new Map<string, Promise<string | undefined>>();

	const translate = (text: string): Promise<string | undefined> => {
		const key = hashText(text);
		const cached = cache.get(key);
		if (cached) return cached;
		const pending = loadConfig().then((config) => {
			const translators = config?.translators ?? [];
			if (!translators.length) throw new Error(`${configPath()} has no translators`);
			return translateBlock(text, {
				attempts: translatorAttempts(translators, fetchPost),
				...chunkPlan(translators),
				signal: lifetime.signal,
			});
		});
		cache.set(key, pending);
		// A failure is not remembered, so the next expansion asks again.
		pending.catch(() => cache.delete(key));
		if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value ?? key);
		return pending;
	};

	const handler: Handler = async (request, response) => {
		const rejection = ctx.connection.requestRejection(request);
		if (rejection !== undefined) {
			response.statusCode = rejection;
			response.end();
			return;
		}
		if (request.method !== "POST") {
			response.setHeader("allow", "POST");
			send(response, 405, { error: "POST only" });
			return;
		}
		const raw = await readBody(request);
		let text: unknown;
		try {
			const body: unknown = raw === undefined ? undefined : JSON.parse(raw);
			text = body && typeof body === "object" && "text" in body ? body.text : undefined;
		} catch {
			text = undefined;
		}
		if (typeof text !== "string" || !text.trim()) {
			send(response, 400, { error: "expected a JSON body with non-empty text" });
			return;
		}
		try {
			const ja = await translate(text.trim());
			if (ja === undefined) send(response, 503, { error: "translation abandoned" });
			else send(response, 200, { ja });
		} catch (error) {
			ctx.logger.warn(`thinking-ja: translation failed: ${String(error)}`);
			send(response, 502, { error: String(error) });
		}
	};

	ctx.effect(() => () => lifetime.abort(), "thinking-ja: in-flight translations");
	ctx.effect(() => ctx.webServer.register({ kind: "exact", path: TRANSLATE_PATH, handler }), "thinking-ja: route");
}
