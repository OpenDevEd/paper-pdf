/**
 * Writes `src/mdpi.ts`: the name MDPI's file host uses for each journal, by ISSN. The name is the last part of the
 * journal's home page (`mdpi.com/journal/<name>`), which OpenAlex records. Run it again when MDPI adds journals:
 *
 *   OPENALEX_API_KEY=... node bench/mdpi-journals.ts
 */

import { writeFileSync } from "node:fs";

// OpenAlex's ID for MDPI as a publisher.
const MDPI = "P4310310987";

type Page = { results: { issn: string[] | null; homepage_url: string | null; works_count: number }[]; meta: { next_cursor: string | null } };

const names = new Map<string, string>();
let journals = 0;
let named = 0;
let papers = 0;
let covered = 0;
for (let cursor: string | null = "*"; cursor; ) {
	const url = new URL("https://api.openalex.org/sources");
	url.search = new URLSearchParams({ filter: `host_organization_lineage:${MDPI}`, select: "issn,homepage_url,works_count", "per-page": "200", cursor, api_key: process.env["OPENALEX_API_KEY"] ?? "" }).toString();
	const response = await fetch(url);
	if (!response.ok) throw new Error(`OpenAlex answered ${response.status}`);
	const page = (await response.json()) as Page;
	for (const source of page.results) {
		if (!source.issn?.length) continue;
		journals++;
		papers += source.works_count;
		const name = /mdpi\.com\/journal\/([a-z0-9-]+)/iu.exec(source.homepage_url ?? "")?.[1]?.toLowerCase();
		if (!name) continue;
		named++;
		covered += source.works_count;
		for (const issn of source.issn) names.set(issn.toUpperCase(), name);
	}
	cursor = page.results.length ? page.meta.next_cursor : null;
}

const rows = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([issn, name]) => `${issn} ${name}`);
writeFileSync(
	new URL("../src/mdpi.ts", import.meta.url),
	`/**
 * The name MDPI's file host uses for each journal, by ISSN. Written by \`bench/mdpi-journals.ts\` from the journals'
 * home pages in OpenAlex on ${new Date().toISOString().slice(0, 10)}: ${named} of MDPI's ${journals} journals, which published ${Math.round((100 * covered) / papers)}% of its papers. A
 * newer journal's name is the one its DOIs start with.
 */
export const MDPI_JOURNALS: ReadonlyMap<string, string> = new Map(
	\`
${rows.join("\n")}
\`
		.trim()
		.split("\\n")
		.map((row): [string, string] => [row.slice(0, 9), row.slice(10)]),
);
`,
);
console.log(`${names.size} ISSNs of ${named} journals`);
