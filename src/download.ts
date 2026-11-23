/** One request for one link: follows its redirects, reads what comes back and says what it was. */

import { blockReason, isPdf, isPublicUrl, isWholePdf } from "./check.ts";

export type Outcome =
	| "pdf"
	/** A page that linked to PDFs, which are tried next. */
	| "page"
	/** The host refused an automated request. */
	| "blocked"
	/** Any other HTTP error. */
	| "http"
	/** An answer that is neither a PDF nor a page with a PDF link. */
	| "not_pdf"
	/** A PDF that is not the paper. */
	| "rejected"
	| "too_large"
	| "timeout"
	| "network"
	/** An address outside the public internet. */
	| "unsafe"
	/** Not requested: its host refused automated requests recently. */
	| "skipped"
	/** Stopped because another copy arrived first. */
	| "cancelled"
	/** A service's answer about where copies are. */
	| "lookup";

export type Fetched =
	| { outcome: "pdf"; bytes: Uint8Array; url: URL }
	| { outcome: "page"; html: string; url: URL }
	| { outcome: Exclude<Outcome, "pdf" | "page">; status?: number; note: string; url: URL; hostRefused?: boolean; /** Seconds the host asked to be left alone. */ retryAfter?: number };

export type DownloadSettings = {
	fetch: typeof fetch;
	userAgent: string;
	maxBytes: number;
	/** Ends the request: the search is over or out of time. */
	signal: AbortSignal;
	/**
	 * When the time for this download runs out, as epoch milliseconds, asked again as it arrives. A PDF that cannot
	 * finish by then is dropped early.
	 */
	deadline?: () => number;
	/** How long the host may take to answer, when shorter than the usual limit. */
	answerMs?: number;
	/** Called once the first bytes show a PDF is arriving. */
	onPdf?: () => void;
	/**
	 * Waits for the host's turn before each request, redirects included, and returns what to call when the request is
	 * over. Returns why instead, when the host is being left alone.
	 */
	enter?: (host: string) => Promise<(() => void) | string>;
};

const MAX_REDIRECTS = 8;
// How long a host may take to answer, and how long a download may receive nothing.
const ANSWER_MS = 15_000;
const IDLE_MS = 15_000;
// A page is read this far for its links. ScienceDirect's refusal page alone is over a megabyte.
const PAGE_BYTES = 1_500_000;
const SNIFF_BYTES = 1_024;
// A download is judged for speed once it has run this long. Slower than this with no size given, it is dropped.
const PACE_AFTER_MS = 4_000;
const SLOWEST_BYTES_A_SECOND = 10_000;

const join = (chunks: Uint8Array[], size: number) => {
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
};

const errorNote = (error: unknown) => {
	const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
	if (typeof cause?.code === "string") return cause.code;
	if (typeof cause?.message === "string") return cause.message;
	return error instanceof Error ? error.message : String(error);
};

export async function download(start: URL, settings: DownloadSettings, referer?: URL): Promise<Fetched> {
	const stop = new AbortController();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const allow = (ms: number) => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			stop.abort();
		}, ms);
	};
	const ended = () => stop.abort();
	settings.signal.addEventListener("abort", ended, { once: true });
	if (settings.signal.aborted) stop.abort();

	let url = start;
	let leave: (() => void) | undefined;
	try {
		let response: Response;
		for (let hop = 0; ; hop++) {
			if (!isPublicUrl(url)) return { outcome: "unsafe", note: "Not a public address", url };
			if (hop > MAX_REDIRECTS) return { outcome: "http", note: "Too many redirects", url };
			leave?.();
			leave = undefined;
			const entered = await settings.enter?.(url.hostname);
			if (typeof entered === "string") return { outcome: "skipped", note: entered, url };
			leave = entered;
			allow(settings.answerMs ?? ANSWER_MS);
			response = await settings.fetch(url, {
				// Some servers answer 404 or 406 to a strict Accept, though they serve the file to */*.
				headers: { Accept: "application/pdf, text/html;q=0.9, */*;q=0.8", "User-Agent": settings.userAgent, ...(referer ? { Referer: referer.href } : {}) },
				redirect: "manual",
				signal: stop.signal,
			});
			const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
			if (!location) break;
			// Release the connection: an unread body holds it open.
			await response.body?.cancel().catch(() => undefined);
			try {
				url = new URL(location, url);
			} catch {
				return { outcome: "http", status: response.status, note: "Redirect to an unreadable address", url };
			}
		}

		// The length of a compressed answer is not the length of the file, so it is not used to judge one.
		const declared = response.headers.get("content-encoding") ? 0 : Number(response.headers.get("content-length")) || 0;
		if (response.ok && declared > settings.maxBytes) {
			await response.body?.cancel().catch(() => undefined);
			return { outcome: "too_large", status: response.status, note: `${declared} bytes`, url };
		}

		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		type Kind = "unknown" | "pdf" | "page" | "other";
		let kind = "unknown" as Kind;
		const type = response.headers.get("content-type") ?? "";
		const decide = (): Kind => {
			const head = chunks.length === 1 ? chunks[0]! : join(chunks, size);
			if (isPdf(head)) {
				if (response.ok) settings.onPdf?.();
				return "pdf";
			}
			// A listing of a paper's files, as XML or JSON, is read like a page.
			return /html|xml|json/iu.test(type) || /^\s*</u.test(new TextDecoder().decode(head.subarray(0, 512))) ? "page" : "other";
		};
		const began = Date.now();
		while (reader) {
			allow(IDLE_MS);
			const part = await reader.read();
			if (part.done) break;
			chunks.push(part.value);
			size += part.value.byteLength;
			if (kind === "unknown" && size >= SNIFF_BYTES) kind = decide();
			if (kind === "pdf" && size > settings.maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { outcome: "too_large", status: response.status, note: `More than ${settings.maxBytes} bytes`, url };
			}
			const spent = Date.now() - began;
			if (kind === "pdf" && spent > PACE_AFTER_MS) {
				// At this pace the rest needs twice the time the search has left, so the time goes to another copy. A
				// download that is only a little behind is kept: the Internet Archive starts slowly and speeds up.
				const left = (settings.deadline?.() ?? Infinity) - Date.now();
				const late = declared ? ((declared - size) * spent) / size > 2 * left : left !== Infinity && (size * 1_000) / spent < SLOWEST_BYTES_A_SECOND;
				if (late) {
					await reader.cancel().catch(() => undefined);
					return { outcome: "timeout", status: response.status, note: "Too slow to finish in time", url };
				}
			}
			if (kind === "other" || (kind === "page" && size >= PAGE_BYTES) || (kind === "pdf" && !response.ok)) {
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
		if (kind === "unknown") kind = decide();
		const bytes = join(chunks, size);

		if (kind === "pdf" && response.ok) {
			// A connection that closes early leaves a file that starts like a PDF and does not open.
			if (declared && size < declared) return { outcome: "network", status: response.status, note: `Got ${size} of ${declared} bytes`, url };
			// The Internet Archive holds copies that were cut short when it saved them.
			if (!isWholePdf(bytes)) return { outcome: "not_pdf", status: response.status, note: "A PDF cut short", url };
			return { outcome: "pdf", bytes, url };
		}
		const html = kind === "page" ? new TextDecoder().decode(bytes) : "";
		const refusal = kind === "page" ? blockReason(response.headers, html) : undefined;
		if (refusal) return { outcome: "blocked", status: response.status, note: refusal, url, hostRefused: true };
		if (!response.ok) {
			const refused = response.status === 401 || response.status === 403 || response.status === 429;
			// Retry-After is a number of seconds or a date.
			const header = response.headers.get("retry-after")?.trim() ?? "";
			const wait = /^\d+$/u.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1_000;
			return { outcome: refused ? "blocked" : "http", status: response.status, note: `HTTP ${response.status}`, url, ...(wait > 0 ? { retryAfter: wait } : {}) };
		}
		if (kind === "page") return { outcome: "page", html, url };
		return { outcome: "not_pdf", status: response.status, note: size ? `Not a PDF: ${type || "no content type"}` : "Empty answer", url };
	} catch (error) {
		if (timedOut) return { outcome: "timeout", note: "No answer in time", url };
		if (settings.signal.aborted) return { outcome: "cancelled", note: "Stopped", url };
		return { outcome: "network", note: errorNote(error), url };
	} finally {
		leave?.();
		clearTimeout(timer);
		settings.signal.removeEventListener("abort", ended);
	}
}
