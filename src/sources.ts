/** Where a paper's copies are looked for. Each service is asked once per paper and answers with links to try. */

import { looksLikePdfUrl } from "./check.ts";

export type Source =
	| "given"
	| "doi"
	| "unpaywall"
	| "openalex"
	| "crossref"
	| "page"
	| "wayback"
	| "openalex-copy";

/** What the caller knows about a paper. Every field is optional, but a DOI or a link is needed to find anything. */
export type Paper = {
	doi?: string | undefined;
	/** OpenAlex's ID for the work, as "W123" or its address. */
	openalexId?: string | undefined;
	/** PubMed Central's ID, as "PMC123". */
	pmcid?: string | undefined;
	/** Links the caller already holds, best first. */
	urls?: readonly string[] | undefined;
	/** OpenAlex's `open_access.is_oa`. */
	openAccess?: boolean | undefined;
	/** OpenAlex's `has_content.pdf`: it keeps a copy, which costs money to download. */
	openAlexCopy?: boolean | undefined;
};

/** A link to try. A lower rank is tried first. */
export type Candidate = { url: URL; source: Source; rank: number; depth: number; referer?: URL; secret?: string };

export const RANK = { pdf: 0, rewrite: 1, found: 2, registered: 3, landing: 4, doi: 5, wayback: 6, paid: 9 } as const;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);

export const normalizeDoi = (value: string | undefined) =>
	value?.trim().toLowerCase().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/u, "") || undefined;

export const openAlexWork = (value: string | undefined) => /W\d+/iu.exec(value ?? "")?.[0]?.toUpperCase();

export function toUrl(value: unknown): URL | undefined {
	if (typeof value !== "string") return undefined;
	try {
		// Crossref passes on links whose ampersands a publisher wrote as HTML.
		const url = new URL(value.trim().replaceAll("&amp;", "&"));
		url.hash = "";
		return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
}

const candidates = (source: Source, pdfRank: number, values: unknown[]): Candidate[] =>
	values.flatMap((value) => {
		const url = toUrl(value);
		return url ? [{ url, source, rank: looksLikePdfUrl(url) ? pdfRank : RANK.landing, depth: 0 }] : [];
	});

/** The caller's own links, then the paper's DOI, which leads to the publisher's page. */
export function given(paper: Paper): Candidate[] {
	const doi = normalizeDoi(paper.doi);
	return [
		...candidates("given", RANK.pdf, [...(paper.urls ?? [])]),
		...(paper.pmcid ? [{ url: pmcListing(paper.pmcid), source: "given" as const, rank: RANK.rewrite, depth: 0 }] : []),
		...(doi ? [{ url: new URL(`https://doi.org/${encodeURI(doi)}`), source: "doi" as const, rank: RANK.doi, depth: 0 }] : []),
	];
}

const PMC_FILES = "https://pmc-oa-opendata.s3.amazonaws.com/";

/**
 * The files PubMed Central publishes for one article in its open data on Amazon S3, as the bucket's XML listing.
 * PubMed Central's site answers scripts with a proof-of-work page and Europe PMC with a Cloudflare challenge, and
 * this storage serves the same PDF plainly.
 */
const pmcListing = (pmcid: string) => new URL(`${PMC_FILES}?list-type=2&prefix=PMC${pmcid.replace(/\D/gu, "")}.`);

const ARCHIVE_HAS = "https://archive.org/wayback/available";

/**
 * The Internet Archive's answer on whether it holds a good copy of an address, and from when. It comes in under a
 * second. The archive's fuller index refuses more than a few questions a minute.
 */
export function waybackCopy(url: URL): URL {
	const question = new URL(ARCHIVE_HAS);
	question.searchParams.set("url", url.href);
	return question;
}

/** The address an archived copy was saved from, so a page's links are read against the site and not the archive. */
export const archivedFrom = (url: URL) => toUrl(/^https:\/\/web\.archive\.org\/web\/\d+id_\/(.+)$/u.exec(url.href)?.[1]);

const parsed = (body: string): unknown => {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
};

/**
 * The files an answer lists, when the address is one of the listings above and not a page: PubMed Central's storage
 * (the latest version of the article first), figshare's record of an item, the Internet Archive's answer. Nothing
 * for any other address.
 */
export function listedFiles(body: string, listing: URL): URL[] | undefined {
	if (listing.href.startsWith(`${PMC_FILES}?`)) {
		const keys = [...body.matchAll(/<Key>(PMC\d+\.(\d+)\/[^<]+\.pdf)<\/Key>/gu)].map((match) => ({ key: match[1]!, version: Number(match[2]) }));
		return keys.sort((a, b) => b.version - a.version).map(({ key }) => new URL(PMC_FILES + key));
	}
	if (listing.href.startsWith(FIGSHARE_ITEMS)) {
		const files = list(record(parsed(body))["files"]).filter((file) => file["mimetype"] === "application/pdf" || /\.pdf$/iu.test(String(file["name"])));
		return files.flatMap((file) => toUrl(file["download_url"]) ?? []);
	}
	if (listing.href.startsWith(`${ARCHIVE_HAS}?`)) {
		const copy = record(record(record(parsed(body))["archived_snapshots"])["closest"]);
		// `id_` after the time asks for the bytes the site served, without the archive's toolbar.
		const saved = copy["status"] === "200" && typeof copy["url"] === "string" ? toUrl(copy["url"].replace(/^http:/u, "https:").replace(/\/web\/(\d+)\//u, "/web/$1id_/")) : undefined;
		return saved ? [saved] : [];
	}
	return undefined;
}

const FIGSHARE_ITEMS = "https://api.figshare.com/v2/articles/";

/**
 * Another address for the same file where a host is known to serve it better: PubMed Central's open storage for
 * its articles, figshare's record of an item, whose page needs a browser, and the fixed path of an arXiv abstract's PDF.
 */
export function rewritten(url: URL): URL | undefined {
	const pmc = /(?:ncbi\.nlm\.nih\.gov\/pmc|pmc\.ncbi\.nlm\.nih\.gov|europepmc\.org)\/(?:articles|article\/PMC)\/(?:PMC)?(\d+)/iu.exec(url.href)?.[1];
	if (pmc) return pmcListing(pmc);
	const figshare = /(?:^|\.)figshare\.com$/iu.test(url.hostname) ? /^\/articles\/(?:[^/]+\/)*(\d+)(?:\/\d+)?\/?$/u.exec(url.pathname)?.[1] : undefined;
	if (figshare) return new URL(FIGSHARE_ITEMS + figshare);
	const arxiv = /^(?:www\.)?arxiv\.org$/iu.test(url.hostname) ? /^\/abs\/(.+)$/u.exec(url.pathname)?.[1] : undefined;
	if (arxiv) return new URL(`https://arxiv.org/pdf/${arxiv}`);
	return undefined;
}

export const openAlexCopy = (work: string, key: string) => new URL(`https://content.openalex.org/works/${work}.pdf?api_key=${encodeURIComponent(key)}`);

export type LookupSettings = { contactEmail?: string | undefined; openAlexKey?: string | undefined };

/** Reads a service's JSON answer, or nothing when it does not answer in time. */
export type ReadJson = (url: URL) => Promise<unknown>;

type Lookup = { source: Source; applies: (paper: Paper, settings: LookupSettings) => boolean; run: (paper: Paper, settings: LookupSettings, json: ReadJson) => Promise<{ candidates: Candidate[]; learned?: Partial<Paper> }> };


export const LOOKUPS: Lookup[] = [
	{
		// Unpaywall asks callers to name themselves by email and refuses placeholders. It is asked only for a paper that
		// came with no links: OpenAlex's links are Unpaywall's, and for 343 papers that had them it named no other copy.
		source: "unpaywall",
		applies: (paper, settings) => Boolean(normalizeDoi(paper.doi) && settings.contactEmail && !paper.urls?.length),
		async run(paper, settings, json) {
			const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(normalizeDoi(paper.doi)!)}`);
			url.searchParams.set("email", settings.contactEmail!);
			const locations = list(record(await json(url))["oa_locations"]);
			return {
				candidates: [
					...candidates("unpaywall", RANK.found, locations.map((location) => location["url_for_pdf"])),
					...candidates("unpaywall", RANK.found, locations.map((location) => location["url_for_landing_page"])),
				],
			};
		},
	},
	{
		// Only for a caller that holds no OpenAlex record: one that passed links got them from it already.
		source: "openalex",
		applies: (paper, settings) => Boolean(settings.openAlexKey && !paper.urls?.length && (openAlexWork(paper.openalexId) || normalizeDoi(paper.doi))),
		async run(paper, settings, json) {
			const work = openAlexWork(paper.openalexId);
			const url = new URL(`https://api.openalex.org/works/${work ?? `doi:${encodeURI(normalizeDoi(paper.doi)!)}`}`);
			url.searchParams.set("select", "id,open_access,locations,has_content");
			url.searchParams.set("api_key", settings.openAlexKey!);
			const answer = record(await json(url));
			const locations = list(answer["locations"]);
			const learned: Partial<Paper> = {};
			const id = openAlexWork(typeof answer["id"] === "string" ? answer["id"] : undefined);
			if (id) learned.openalexId = id;
			const copy = record(answer["has_content"])["pdf"];
			if (typeof copy === "boolean") learned.openAlexCopy = copy;
			return {
				candidates: [
					...candidates("openalex", RANK.found, locations.map((location) => location["pdf_url"])),
					...candidates("openalex", RANK.found, locations.map((location) => location["landing_page_url"])),
				],
				learned,
			};
		},
	},
	{
		// Publishers register full-text links with Crossref. Its text-mining links that need a publisher's key are left out.
		source: "crossref",
		applies: (paper) => Boolean(normalizeDoi(paper.doi)),
		async run(paper, settings, json) {
			const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(paper.doi)!)}`);
			if (settings.contactEmail) url.searchParams.set("mailto", settings.contactEmail);
			const work = record(record(await json(url))["message"]);
			if (normalizeDoi(typeof work["DOI"] === "string" ? work["DOI"] : undefined) !== normalizeDoi(paper.doi)) return { candidates: [] };
			const links = list(work["link"]).filter((link) => {
				const address = toUrl(link["URL"]);
				return address && !/^api\./iu.test(address.hostname) && (link["content-type"] === "application/pdf" || looksLikePdfUrl(address));
			});
			return { candidates: candidates("crossref", RANK.registered, links.map((link) => link["URL"])) };
		},
	},
];
