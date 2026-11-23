/**
 * Builds a list of papers for the benchmark from OpenAlex, with the links a product would hold for each.
 *
 *   node bench/sample.ts random gold 50 [seed]    50 random articles of one open-access status (or "closed")
 *   node bench/sample.ts list dois.txt            the papers behind a file's DOIs: one a line, or a CSV with a doi column
 *
 * Prints one paper a line as JSON. Needs OPENALEX_API_KEY.
 */

import { readFileSync } from "node:fs";

const key = process.env["OPENALEX_API_KEY"];
if (!key) throw new Error("Set OPENALEX_API_KEY");

type Location = { pdf_url?: string | null; landing_page_url?: string | null; is_oa?: boolean };
type Work = {
	id: string;
	doi?: string | null;
	title?: string | null;
	publication_year?: number;
	open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null };
	best_oa_location?: Location | null;
	locations?: Location[];
	has_content?: { pdf?: boolean };
};

async function works(filter: string, extra: Record<string, string> = {}): Promise<Work[]> {
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("filter", filter);
	url.searchParams.set("select", "id,doi,title,publication_year,open_access,best_oa_location,locations,has_content");
	url.searchParams.set("per-page", "100");
	for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
	url.searchParams.set("api_key", key!);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`OpenAlex answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
	return ((await response.json()) as { results: Work[] }).results;
}

/** The paper as a product holds it: the best open copy's PDF first, then other PDFs, then open landing pages. */
function paper(work: Work) {
	const locations = [work.best_oa_location, ...(work.locations ?? [])].filter((location) => location != null);
	const urls = [
		...locations.map((location) => location.pdf_url),
		work.open_access?.oa_url,
		...locations.filter((location) => location.is_oa).map((location) => location.landing_page_url),
	].filter((url): url is string => Boolean(url) && !/^https?:\/\/(?:dx\.)?doi\.org\//iu.test(url!));
	return {
		doi: work.doi?.replace(/^https:\/\/doi\.org\//u, ""),
		openalexId: work.id.replace("https://openalex.org/", ""),
		urls: [...new Set(urls)],
		openAccess: work.open_access?.is_oa ?? false,
		openAlexCopy: work.has_content?.pdf ?? false,
		status: work.open_access?.oa_status ?? "unknown",
		year: work.publication_year,
		title: work.title ?? "",
	};
}

const [command, ...rest] = process.argv.slice(2);
const out = (found: Work[]) => process.stdout.write(found.map((work) => `${JSON.stringify(paper(work))}\n`).join(""));

if (command === "random") {
	const [status = "gold", count = "50", seed = "7"] = rest;
	const access = status === "closed" ? "open_access.is_oa:false" : `open_access.oa_status:${status}`;
	out(await works(`${access},type:article,has_doi:true,publication_year:2010-2025`, { sample: count, seed }));
} else if (command === "list") {
	const lines = readFileSync(rest[0]!, "utf8").split(/\r?\n/u).filter(Boolean);
	const column = lines[0]!.split(",").indexOf("doi");
	const dois = (column < 0 ? lines : lines.slice(1).map((line) => line.split(",")[column] ?? "")).map((doi) => doi.trim().toLowerCase()).filter(Boolean);
	for (let at = 0; at < dois.length; at += 50) {
		const batch = dois.slice(at, at + 50);
		const found = await works(`doi:${batch.join("|")}`);
		// In the file's order, so two runs of one list compare line by line.
		out(batch.flatMap((doi) => found.find((work) => work.doi?.toLowerCase() === `https://doi.org/${doi}`) ?? []));
	}
} else {
	throw new Error("Use: random <status> <count> [seed], or list <file>");
}
