import type { HttpPost } from "./translator.ts";

/** Deadline for one translation request. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** `HttpPost` over the global `fetch` (Node, Bun, browsers), with REQUEST_TIMEOUT_MS. */
export const fetchPost: HttpPost = async (url, body, signal) => {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	return { status: response.status, text: await response.text() };
};
