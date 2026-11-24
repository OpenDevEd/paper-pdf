/**
 * Finds one paper's PDF. The order is what keeps it fast:
 *
 *   1. what an earlier search remembered: a paper that had no copy is not searched again until its retry time
 *   2. what the caller already knows: a closed paper with no link costs no request
 *   3. the caller's own links, and nothing else while one of them is delivering a PDF
 *   4. only once a link fails or is slow: Unpaywall, OpenAlex and Crossref, asked at the same time
 *   5. PDFs that pages link to, and the Internet Archive's copy of a link whose host refused or lost the file
 *   6. OpenAlex's own copy, which costs money, when the caller allows it and every free copy failed
 *
 * It stops at the first file that is a PDF and the paper.
 *
 * Thousands of papers at once take two passes. Steps 4 to 6 lean on services every search shares, which refuse
 * bursts. A `quick` search stops after step 3 and the pages its links lead to, so an import runs at the speed of
 * the papers' own hosts. The papers it misses go through a full search afterwards, in which each shared service is
 * asked at a steady pace and a search waits its turn.
 */

import { isSupplementUrl, looksLikePdfUrl, pdfLinks } from "./check.ts";
import { download, type DownloadSettings, type Fetched, type Outcome } from "./download.ts";
import { archivedFrom, type Candidate, given, listedFiles, LOOKUPS, normalizeDoi, openAlexCopy, openAlexWork, type Paper, RANK, rewritten, type Source, waybackCopy } from "./sources.ts";

type Awaitable<T> = T | Promise<T>;

/**
 * Where misses and refusing hosts are remembered between searches. A `Map` works for one process. A product passes
 * its own store so every server and both products share what was learned. Values are plain JSON.
 */
export type Memory = { get(key: string): Awaitable<unknown>; set(key: string, value: unknown): Awaitable<unknown> };

export type Options = {
	/** Defaults to the global `fetch`. On Node pass `publicFetch` from `@opendeved/paper-pdf/node`, which also refuses names that resolve to private addresses. */
	fetch?: typeof fetch;
	/**
	 * How requests name the caller, such as "ExampleBot/1.0 (+https://example.org/bot)". Leave "Mozilla" out: Springer,
	 * BMC, HAL and sites behind Anubis challenge names that look like a browser and serve a plainly named bot.
	 */
	userAgent?: string;
	/** Unpaywall needs it and is skipped without it. Crossref answers faster with it. */
	contactEmail?: string;
	/** Reads the paper's OpenAlex record where Unpaywall can't be asked, and buys OpenAlex's copy with `buyOpenAlexCopy`. */
	openAlexKey?: string;
	/** With `openAlexKey`, downloads OpenAlex's own copy once every free copy has failed. OpenAlex charges for each. */
	buyOpenAlexCopy?: boolean;
	/** The longest one search may take. */
	budgetMs?: number;
	/** How long a link may go without delivering a PDF before the next one starts beside it. */
	hedgeMs?: number;
	maxBytes?: number;
	memory?: Memory;
	/** Says why a PDF is not the paper, so the search moves on. `articleProblem` judges extracted text. */
	accept?: (file: { bytes: Uint8Array; url: string; source: Source }) => Awaitable<string | undefined>;
	/** Refuses every address that is not HTTPS, for a caller whose rules allow no plain HTTP. Some open PDFs are served over HTTP only. */
	httpsOnly?: boolean;
	/** Searches a paper OpenAlex calls closed. Off, such a paper with no link costs no request. */
	searchClosed?: boolean;
	/**
	 * Tries only the caller's links, the DOI and the PDFs their pages lead to: no service, no archive, no paid copy.
	 * For the first pass over many papers. A quick miss is not remembered, so the full search can follow at once.
	 */
	quick?: boolean;
	signal?: AbortSignal;
};

export type Attempt = { url: string; source: Source; outcome: Outcome; status?: number; note?: string; ms: number };

export type MissReason =
	/** Not open access and no link to try. Only an upload or a paid copy can help. */
	| "closed"
	/** A copy exists and its host refuses automated requests. */
	| "blocked"
	/** Every link answered and none was the paper. */
	| "no_pdf"
	/** Hosts did not answer, or time ran out. */
	| "unreachable";

export type Found = { ok: true; bytes: Uint8Array; url: string; source: Source; ms: number; attempts: Attempt[] };
export type Missed = { ok: false; reason: MissReason; /** When a new search is worth it, as epoch milliseconds. */ retryAt: number; /** Answered from memory, with no request made. */ remembered: boolean; ms: number; attempts: Attempt[] };
export type Result = Found | Missed;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How long a miss stands before the paper is searched again. Each further miss doubles it, up to `RETRY_LIMIT`. */
const RETRY_AFTER: Record<MissReason, number> = { closed: 30 * DAY, blocked: 7 * DAY, no_pdf: 14 * DAY, unreachable: HOUR };
const RETRY_LIMIT = 60 * DAY;

/** A host gets this many requests at a time from one process, as the Evidence Community import has run with. */
const PER_HOST = 4;
/**
 * Services every search shares. They refuse bursts, so each is asked at a steady pace however many searches are
 * running. Checked on 2026-11-23: the Internet Archive answered 120 questions of 120 at 1.5 a second and refused
 * after 13 at 3 a second, and Crossref states 10 a second and 3 at once for a caller that gives an email.
 */
const PACED: Record<string, { everyMs: number; atOnce: number }> = {
	"archive.org": { everyMs: 700, atOnce: 2 },
	"api.crossref.org": { everyMs: 150, atOnce: 2 },
};
/** How long a paced service is left alone after a 429 that names no time. The archive answered again within 33 seconds. */
const BACKOFF_MS = 30_000;
/** A request waits out a service's hold up to this long. During a longer one the service is skipped. */
const LONGEST_HOLD_MS = 60_000;
/** What a quick search leaves out. */
const SLOW: ReadonlySet<Source> = new Set<Source>(["unpaywall", "openalex", "crossref", "wayback", "openalex-copy"]);
/** A host that showed a bot challenge is not asked again for this long. */
const REFUSAL_MS = 6 * HOUR;
/**
 * After this many refusals or failed connections in a row, a host is left alone: for a minute the first time, and
 * twice as long each time it fails again straight after, up to `STRIKE_MS`. A dead host soon costs nothing, and a
 * network that dropped for a moment does not silence a host every paper leads through, such as doi.org.
 */
const STRIKES = 3;
const STRIKE_MS = 30 * 60_000;
const MAX_PAGE_DEPTH = 2;
const MAX_WAYBACK = 3;
const LOOKUP_MS = 5_000;
/** While a PDF is arriving, another copy starts beside it only after this many hedge intervals: the download is slow. */
const SLOW_DELIVERY = 6;

type Host = { active: number; waiting: (() => void)[]; strikes: number; /** Times in a row it was left alone for striking out. */ outs: number; until: number; note: string; /** When a paced host may next be asked. */ next: number; /** Until when a paced host asked to be left alone. */ quiet: number; remembered?: Promise<void> };
// ponytail: one small record a host, kept for the life of the process. Prune the idle ones if a worker ever sees millions of hosts.
const hosts = new Map<string, Host>();

const hostOf = (name: string) => {
	let host = hosts.get(name);
	if (!host) hosts.set(name, (host = { active: 0, waiting: [], strikes: 0, outs: 0, until: 0, note: "", next: 0, quiet: 0 }));
	return host;
};

/** Forgets what this process learned about hosts. For tests. */
export const forgetHosts = () => hosts.clear();

/** The key a paper's miss is remembered under: write `null` to it when the paper's links change. */
export function paperKey(paper: Paper): string | undefined {
	const doi = normalizeDoi(paper.doi);
	if (doi) return `paper:doi:${doi}`;
	const work = openAlexWork(paper.openalexId);
	if (work) return `paper:openalex:${work}`;
	return paper.urls?.[0] ? `paper:url:${paper.urls[0]}` : undefined;
}

type Miss = { reason: MissReason; retryAt: number; tries: number };
const asMiss = (value: unknown): Miss | undefined => {
	const miss = value as Partial<Miss> | null;
	return miss && typeof miss === "object" && typeof miss.reason === "string" && miss.reason in RETRY_AFTER && typeof miss.retryAt === "number"
		? { reason: miss.reason, retryAt: miss.retryAt, tries: typeof miss.tries === "number" ? miss.tries : 1 }
		: undefined;
};

export async function findPdf(paper: Paper, options: Options = {}): Promise<Result> {
	const started = Date.now();
	const key = paperKey(paper);
	const before = key ? asMiss(await options.memory?.get(key)) : undefined;
	if (before && before.retryAt > started) return { ok: false, reason: before.reason, retryAt: before.retryAt, remembered: true, ms: 0, attempts: [] };
	const result = await new Promise<Result>((resolve) => new Search(paper, options, started, resolve).start());
	// A search the caller stopped, or one that tried only the quick steps, says nothing final about the paper.
	if (key && options.memory && !options.signal?.aborted && !options.quick) {
		if (result.ok) {
			if (before) await options.memory.set(key, null);
		} else {
			const tries = (before?.tries ?? 0) + 1;
			result.retryAt = Date.now() + Math.min(RETRY_AFTER[result.reason] * 2 ** (tries - 1), RETRY_LIMIT);
			await options.memory.set(key, { reason: result.reason, retryAt: result.retryAt, tries } satisfies Miss);
		}
	}
	return result;
}

class Search {
	private readonly queue: Candidate[] = [];
	private readonly seen = new Set<string>();
	private readonly attempts: Attempt[] = [];
	private readonly ended = new AbortController();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	/** Moves later by the time the search spends waiting for a host's turn. */
	private deadline: number;
	/** Requests waiting for a host's turn, and since when at least one has been. */
	private inLine = 0;
	private lineSince = 0;
	private readonly inFlight = new Map<Candidate, number>();
	private readonly paper: Paper;
	private readonly fetch: typeof fetch;
	private readonly userAgent: string;
	private readonly hedgeMs: number;
	private readonly maxBytes: number;
	private running = 0;
	/** Downloads whose first bytes are a PDF. While there is one, new copies start far more slowly. */
	private delivering = 0;
	private lastStart = 0;
	private failed = false;
	private lookups: "waiting" | "running" | "done" = "waiting";
	private waybacks = 0;
	private outOfTime = false;
	private looking = false;
	private done = false;
	private readonly options: Options;
	private readonly started: number;
	private readonly resolve: (result: Result) => void;

	constructor(paper: Paper, options: Options, started: number, resolve: (result: Result) => void) {
		this.options = options;
		this.started = started;
		this.resolve = resolve;
		this.paper = { ...paper };
		this.fetch = options.fetch ?? fetch;
		this.userAgent = options.userAgent ?? "paper-pdf/0.1";
		this.hedgeMs = options.hedgeMs ?? 1_500;
		this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
		this.deadline = started + (options.budgetMs ?? 45_000);
	}

	start() {
		const { paper, options } = this;
		if (options.signal?.aborted) return this.finish();
		options.signal?.addEventListener("abort", this.stopped, { once: true });
		for (const candidate of given(paper)) this.add(candidate);
		const closed = paper.openAccess === false && !options.searchClosed && !paper.urls?.length && !paper.pmcid;
		if (closed) {
			// The DOI link of a closed paper leads to a paywall, and the services list no open copy of it.
			this.queue.length = 0;
			this.lookups = "done";
		}
		this.addPaidCopy();
		this.armBudget();
		this.pump();
	}

	private armBudget() {
		this.after(Math.max(100, this.deadline - Date.now()), () => {
			// Time given back for waiting in line moved the deadline, and a request still in line will move it again.
			if (Date.now() < this.deadline || this.inLine > 0) return this.armBudget();
			this.outOfTime = true;
			this.finish();
		});
	}

	private readonly stopped = () => this.finish();

	private skips(source: Source) {
		return Boolean(this.options.quick) && SLOW.has(source);
	}

	private after(ms: number, run: () => void) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			run();
		}, ms);
		this.timers.add(timer);
	}

	private add(candidate: Candidate) {
		// The services write a DOI's link in several ways, and each leads to the same page.
		const key = candidate.url.href.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "https://doi.org/");
		if (this.done || this.skips(candidate.source) || this.seen.has(key)) return;
		this.seen.add(key);
		if (isSupplementUrl(candidate.url)) return;
		const better = rewritten(candidate.url);
		// Just ahead of the link it stands in for.
		if (better) this.add({ ...candidate, url: better, rank: candidate.rank - 0.5 });
		this.queue.push(candidate);
		// Stable, so links of one rank keep the order they were found in.
		this.queue.sort((a, b) => a.rank - b.rank);
	}

	private addPaidCopy() {
		const { openAlexKey, buyOpenAlexCopy } = this.options;
		const work = openAlexWork(this.paper.openalexId);
		if (!openAlexKey || !buyOpenAlexCopy || !work || this.paper.openAlexCopy === false) return;
		this.add({ url: openAlexCopy(work, openAlexKey), source: "openalex-copy", rank: RANK.paid, depth: 0, secret: openAlexKey });
	}

	/** Starts what may start now, and ends the search when nothing is left. */
	private pump() {
		if (this.done) return;
		const now = Date.now();
		// The caller's own links and the PDFs their pages declare, waiting or under way, get their chance before the services are asked.
		const promising = [...this.queue, ...this.inFlight.keys()].some((candidate) => candidate.source === "given" || candidate.rank < RANK.found);
		// The wait before something starts beside what is running. It is long while a PDF is arriving: most searches end there.
		const wait = this.delivering ? this.hedgeMs * SLOW_DELIVERY : this.hedgeMs;
		if (this.lookups === "waiting" && (this.failed || !promising || now - this.started >= wait)) this.startLookups();
		while (this.running < 3 && (this.running === 0 || now - this.lastStart >= wait)) {
			const next = this.queue[0];
			// The paid copy waits until every free one has had its turn.
			if (!next || (next.rank === RANK.paid && (this.running > 0 || this.lookups !== "done"))) break;
			this.queue.shift();
			this.running++;
			this.lastStart = Date.now();
			this.inFlight.set(next, this.lastStart);
			const settle = () => {
				this.inFlight.delete(next);
				this.running--;
				this.pump();
			};
			// The caller's `accept` or `memory` threw. The search goes on with the next link.
			const broke = (error: unknown) => {
				if (!this.done) this.note(next.url.href, next.source, { outcome: "rejected", note: `Failed: ${error instanceof Error ? error.message : String(error)}` }, this.inFlight.get(next) ?? Date.now(), next.secret);
				settle();
			};
			void this.attempt(next).then(settle, broke);
		}
		if (this.running === 0 && this.queue.length === 0 && this.lookups === "done") return this.finish();
		// Looks again once the wait is over, at a link that is slow to answer or to deliver.
		if (!this.looking) {
			this.looking = true;
			this.after(wait, () => {
				this.looking = false;
				this.pump();
			});
		}
	}

	private startLookups() {
		const settings = { contactEmail: this.options.contactEmail, openAlexKey: this.options.openAlexKey };
		const lookups = LOOKUPS.filter((lookup) => !this.skips(lookup.source) && lookup.applies(this.paper, settings));
		this.lookups = "running";
		void Promise.all(
			lookups.map(async (lookup) => {
				const began = Date.now();
				let asked = "";
				try {
					const { candidates, learned } = await lookup.run(this.paper, settings, async (url) => {
						asked = url.href;
						// Read like any link: within the host's turn, each redirect checked, and no further than a page is read.
						// A service that is slow to answer once its turn has come is not waited for.
						const answer = await this.ask(url, { signal: this.ended.signal, answerMs: LOOKUP_MS });
						if (answer.outcome !== "page") throw new Error("note" in answer ? answer.note : "Not JSON");
						return JSON.parse(answer.html) as unknown;
					});
					Object.assign(this.paper, learned);
					for (const candidate of candidates) this.add(candidate);
					this.note(asked, lookup.source, { outcome: "lookup", note: `${candidates.length} links` }, began, settings.openAlexKey);
				} catch (error) {
					if (!this.done) this.note(asked, lookup.source, { outcome: "lookup", note: `No answer: ${error instanceof Error ? error.message : String(error)}` }, began, settings.openAlexKey);
				}
			}),
		).then(() => {
			this.lookups = "done";
			this.addPaidCopy();
			this.pump();
		});
	}

	private note(url: string, source: Source, result: { outcome: Outcome; status?: number; note?: string }, began: number, secret?: string) {
		// An error may quote the address it failed on, so the key is cut from the note as well.
		const cut = (text: string) => (secret ? text.replaceAll(encodeURIComponent(secret), "…").replaceAll(secret, "…") : text);
		this.attempts.push({ url: cut(url), source, outcome: result.outcome, ...(result.status ? { status: result.status } : {}), ...(result.note ? { note: cut(result.note) } : {}), ms: Date.now() - began });
	}

	private async attempt(candidate: Candidate) {
		const began = Date.now();
		const fetched = await this.fetchFromHost(candidate);
		if (this.done) return;
		const record = (result: { outcome: Outcome; status?: number; note?: string }) => this.note(candidate.url.href, candidate.source, result, began, candidate.secret);

		if (fetched.outcome === "pdf") {
			const problem = isSupplementUrl(fetched.url) ? "A supplement, not the paper" : await this.options.accept?.({ bytes: fetched.bytes, url: fetched.url.href, source: candidate.source });
			if (this.done) return;
			if (!problem) {
				record({ outcome: "pdf" });
				return this.finish({ bytes: fetched.bytes, url: candidate.secret ? candidate.url.origin + candidate.url.pathname : fetched.url.href, source: candidate.source });
			}
			return record({ outcome: "rejected", note: problem });
		}
		if (fetched.outcome === "page") {
			const listed = listedFiles(fetched.html, fetched.url);
			const archived = candidate.source === "wayback";
			// A DOI or a handle may have led to a host that is better asked another way.
			const better = listed ? undefined : rewritten(fetched.url);
			if (better) this.add({ ...candidate, url: better, rank: RANK.rewrite });
			// A saved page's links are read against the site it was saved from, and their saved copies are asked for.
			// A closed paper's page has no link to the paper, so a link that only reads as a PDF there is something else.
			const links = listed ?? (candidate.depth < MAX_PAGE_DEPTH ? pdfLinks(fetched.html, (archived && archivedFrom(fetched.url)) || fetched.url, this.paper.openAccess === false) : []);
			// What a page or a listing leads to takes its place in the order.
			const next = { rank: Math.min(candidate.rank, RANK.rewrite), depth: candidate.depth + (listed ? 0 : 1) };
			for (const url of links) {
				if (listed) this.add({ ...next, url, source: candidate.source, rank: candidate.rank });
				else if (archived) this.addWayback({ ...next, url, source: "page" }, candidate.rank, true);
				else this.add({ ...next, url, source: "page", referer: fetched.url });
			}
			// A listing is a question about where copies are. Only a page that should have led to the paper counts as a failed copy.
			record({ outcome: listed ? "lookup" : links.length ? "page" : "not_pdf", note: links.length ? `${links.length} links` : "No PDF link" });
			// A PDF's own address that now serves a page: the archive may hold the file it used to serve.
			if (!links.length && looksLikePdfUrl(candidate.url)) this.addWayback(candidate);
			return;
		}
		record(fetched);
		if (fetched.outcome === "cancelled" || fetched.outcome === "unsafe" || fetched.outcome === "too_large") return;
		this.failed = true;
		this.addWayback(candidate);
	}

	/**
	 * Asks the archive for its copy of a link that failed. A PDF's own address is worth more than a page's. At most
	 * `MAX_WAYBACK` failed links are asked about. A link found on a saved page is always asked about: it is where a
	 * copy that the archive does hold leads.
	 */
	private addWayback(candidate: Candidate, rank = RANK.wayback + Math.max(candidate.rank, 0) / 10, found = false) {
		if (candidate.source === "wayback" || candidate.secret || (!found && this.waybacks >= MAX_WAYBACK) || this.skips("wayback")) return;
		// The archive keeps a DOI link's redirect, not a paper: in two benchmark runs no find came from asking about one.
		if (/^(?:dx\.)?doi\.org$/iu.test(candidate.url.hostname)) return;
		const index = waybackCopy(candidate.url);
		if (this.seen.has(index.href)) return;
		if (!found) this.waybacks++;
		this.add({ url: index, source: "wayback", rank, depth: candidate.depth });
	}

	/** One request. A paced service that says it is getting too many is left alone by every search for a while, then asked once more. */
	private async ask(url: URL, settings: Pick<DownloadSettings, "signal" | "deadline" | "answerMs" | "onPdf">, referer?: URL): Promise<Fetched> {
		const all = { ...settings, fetch: this.fetch, userAgent: this.userAgent, maxBytes: this.maxBytes, enter: (host: string) => this.enter(host), httpsOnly: this.options.httpsOnly ?? false };
		// Whether a paced service said it is getting too many, which every search then heeds.
		const held = (fetched: Fetched) => {
			if (!(fetched.url.hostname in PACED) || fetched.outcome !== "blocked" || fetched.status !== 429) return false;
			hostOf(fetched.url.hostname).quiet = Date.now() + (fetched.retryAfter ? fetched.retryAfter * 1_000 : BACKOFF_MS);
			return true;
		};
		const fetched = await download(url, all, referer);
		if (!held(fetched)) return fetched;
		// Waits in `enter` for the hold to end, or is skipped there when the hold is long.
		const again = await download(url, all, referer);
		held(again);
		return again;
	}

	/** Waits until a time, or until the search ends. */
	private sleepUntil(time: number) {
		return new Promise<void>((resolve) => {
			const over = () => {
				clearTimeout(timer);
				this.ended.signal.removeEventListener("abort", over);
				resolve();
			};
			const timer = setTimeout(over, Math.max(0, time - Date.now()));
			this.ended.signal.addEventListener("abort", over, { once: true });
			if (this.ended.signal.aborted) over();
		});
	}

	/**
	 * Waits for a host's turn: a few requests at a time in this process, and for a paced service a steady pace as
	 * well. Says why instead when the host is being left alone, by what this process saw or by what the shared
	 * memory holds.
	 */
	private async enter(name: string): Promise<(() => void) | string> {
		const host = hostOf(name);
		const paced = PACED[name];
		const { memory } = this.options;
		if (memory) {
			// Read once a process, and waited for by every search that asks meanwhile. A memory that fails is read as empty.
			host.remembered ??= Promise.resolve(memory.get(`host:${name}`)).then(
				(value) => {
					const kept = value as { until?: unknown; note?: unknown } | null | undefined;
					if (typeof kept?.until === "number" && kept.until > host.until) Object.assign(host, { until: kept.until, note: typeof kept.note === "string" ? kept.note : "" });
				},
				() => undefined,
			);
			await host.remembered;
		}
		const leave = () => {
			host.active--;
			host.waiting.shift()?.();
		};
		// Reading the memory above counts against the budget. Waiting for a turn does not: it is the host's limit and
		// not the paper's slowness. The search gets that time back, counted once however many of its requests wait.
		if (this.inLine++ === 0) this.lineSince = Date.now();
		try {
			while (host.active >= (paced?.atOnce ?? PER_HOST)) await new Promise<void>((wake) => host.waiting.push(wake));
			host.active++;
			// A search that ended while it waited takes no turn from the others.
			if (paced && !this.done) {
				const turn = Math.max(host.next, Date.now());
				host.next = turn + paced.everyMs;
				await this.sleepUntil(turn);
				// A 429 that came meanwhile asks every search to hold off.
				while (!this.done && host.quiet > Date.now() && host.quiet - Date.now() <= LONGEST_HOLD_MS) await this.sleepUntil(host.quiet);
			}
		} finally {
			if (--this.inLine === 0) this.deadline += Date.now() - this.lineSince;
		}
		// Checked after the wait: the host may have refused another paper meanwhile.
		const refusal = this.done ? "Stopped" : host.until > Date.now() ? `Host left alone: ${host.note}` : host.quiet > Date.now() ? "Host left alone: it asked for fewer requests" : undefined;
		if (!refusal) return leave;
		leave();
		return refusal;
	}

	/** One download, and what its answer says about the host. */
	private async fetchFromHost(candidate: Candidate): Promise<Fetched> {
		const { memory } = this.options;
		let delivering = false;
		try {
			const fetched = await this.ask(
				candidate.url,
				{
					signal: this.ended.signal,
					// A slow download is dropped only for the sake of another free copy. With none left to try, it runs until time is up.
					deadline: () => (this.lookups !== "done" || this.queue.some((waiting) => waiting.rank < RANK.paid) ? this.deadline : Infinity),
					onPdf: () => {
						delivering = true;
						this.delivering++;
					},
				},
				candidate.referer,
			);
			// What a host is judged by is where the redirects ended, which may be another host.
			const answered = hostOf(fetched.url.hostname);
			// A saved copy of a refusal says nothing about the archive that serves it. Only the archive asking for fewer requests does.
			const refused = (fetched.outcome === "blocked" && (candidate.source !== "wayback" || fetched.status === 429)) || (fetched.outcome === "network" && /^(?:UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)$/u.test(fetched.note));
			if (refused && fetched.outcome === "blocked" && fetched.hostRefused) {
				Object.assign(answered, { until: Date.now() + REFUSAL_MS, note: fetched.note });
				await memory?.set(`host:${fetched.url.hostname}`, { until: answered.until, note: answered.note });
			} else if (refused) {
				if (++answered.strikes >= STRIKES) Object.assign(answered, { strikes: 0, until: Date.now() + Math.min(STRIKE_MS, 60_000 * 2 ** answered.outs++), note: fetched.note });
			} else if (fetched.outcome !== "cancelled" && fetched.outcome !== "timeout" && fetched.outcome !== "skipped") {
				Object.assign(answered, { strikes: 0, outs: 0 });
			}
			return fetched;
		} finally {
			if (delivering) this.delivering--;
		}
	}

	private finish(found?: { bytes: Uint8Array; url: string; source: Source }) {
		if (this.done) return;
		this.done = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.options.signal?.removeEventListener("abort", this.stopped);
		this.ended.abort();
		const ms = Date.now() - this.started;
		const { attempts } = this;
		if (found) return this.resolve({ ok: true, ...found, ms, attempts });
		for (const [candidate, began] of this.inFlight) this.note(candidate.url.href, candidate.source, { outcome: "timeout", note: "Still running when the search ended" }, began, candidate.secret);

		const tried = attempts.filter((attempt) => attempt.outcome !== "lookup");
		let reason: MissReason = "no_pdf";
		if (this.outOfTime || this.options.signal?.aborted) reason = "unreachable";
		else if (tried.some((attempt) => attempt.outcome === "blocked" || attempt.outcome === "skipped")) reason = "blocked";
		else if (tried.length === 0) reason = this.paper.openAccess === false ? "closed" : "no_pdf";
		else if (tried.every((attempt) => attempt.outcome === "network" || attempt.outcome === "timeout")) reason = "unreachable";
		// A quick miss is worth the full search at once.
		this.resolve({ ok: false, reason, retryAt: Date.now() + (this.options.quick ? 0 : RETRY_AFTER[reason]), remembered: false, ms, attempts });
	}
}
