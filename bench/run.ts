/**
 * Runs `findPdf` over a list of papers against the live web and reports how many it found, where and how fast.
 *
 *   node bench/run.ts bench/lists/open.jsonl [--parallel 6] [--limit 50] [--buy] [--closed] [--keep]
 *
 * The list is what `bench/sample.ts` prints. Every file found is opened with pdf.js: one that does not open is
 * refused, and its first pages are compared with the paper's title. Set PAPER_PDF_EMAIL so Unpaywall answers.
 * `--buy` also downloads OpenAlex's paid copies (OPENALEX_API_KEY). `--keep` saves the PDFs under bench/pdfs.
 * Each paper's full record goes to bench/results as one JSON line.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { articleProblem, findPdf, type Found, type Missed, type Paper } from "../src/index.ts";
import { publicFetch } from "../src/node.ts";

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	options: { parallel: { type: "string", default: "6" }, limit: { type: "string" }, buy: { type: "boolean" }, closed: { type: "boolean" }, keep: { type: "boolean" }, without: { type: "string" } },
});
const file = positionals[0];
if (!file) throw new Error("Pass a list from bench/sample.ts");

type Listed = Paper & { status?: string; title?: string; year?: number };
const papers = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Listed).slice(0, flags.limit ? Number(flags.limit) : undefined);

async function open(bytes: Uint8Array) {
	// pdf.js takes the buffer it is given, so it gets a copy.
	const task = getDocument({ data: bytes.slice(), verbosity: 0 });
	try {
		const document = await task.promise;
		let text = "";
		for (let number = 1; number <= Math.min(document.numPages, 3); number++) {
			const content = await (await document.getPage(number)).getTextContent();
			text += `${content.items.map((item) => ("str" in item ? item.str : "")).join(" ")} `;
		}
		return { pages: document.numPages, text };
	} finally {
		await task.destroy();
	}
}

const words = (text: string) => text.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((word) => word.length >= 4);

/** The share of the title's words on the first pages, or nothing for a scan, which has no text to compare. */
function titleMatch(title: string, text: string) {
	const wanted = [...new Set(words(title))];
	const present = new Set(words(text));
	if (present.size < 40 || wanted.length < 3) return undefined;
	return wanted.filter((word) => present.has(word)).length / wanted.length;
}

type Row = { paper: Listed; result: Omit<Found, "bytes"> | Missed; pages?: number; title?: number | undefined; bytes?: number };

/** Whether a file ends the way a whole PDF does, beside whether pdf.js opens it: the two should agree. */
const endings: Record<string, number> = {};
const ends = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(-4_096).includes("%%EOF");

const memory = new Map<string, unknown>();
const rows: Row[] = [];
if (flags.keep) mkdirSync("bench/pdfs", { recursive: true });

async function run(paper: Listed): Promise<Row> {
	let opened: { pages: number; text: string } | undefined;
	const result = await findPdf(paper, {
		fetch: publicFetch,
		userAgent: "OpenscholarBot/0.1 (+https://openscholar.ai)",
		memory,
		...(process.env["PAPER_PDF_EMAIL"] ? { contactEmail: process.env["PAPER_PDF_EMAIL"] } : {}),
		...(flags.buy && process.env["OPENALEX_API_KEY"] ? { openAlexKey: process.env["OPENALEX_API_KEY"], buyOpenAlexCopy: true } : {}),
		...(flags.closed ? { searchClosed: true } : {}),
		...(flags.without ? { without: flags.without.split(",") as NonNullable<Parameters<typeof findPdf>[1]>["without"] & string[] } : {}),
		accept: async ({ bytes }) => {
			try {
				opened = await open(bytes);
				endings[`opens, ${ends(bytes) ? "ends whole" : "no ending"}`] = (endings[`opens, ${ends(bytes) ? "ends whole" : "no ending"}`] ?? 0) + 1;
			} catch (error) {
				endings[`does not open, ${ends(bytes) ? "ends whole" : "no ending"}`] = (endings[`does not open, ${ends(bytes) ? "ends whole" : "no ending"}`] ?? 0) + 1;
				return `Does not open as a PDF: ${error instanceof Error ? error.message : String(error)}`;
			}
			return articleProblem(opened);
		},
	});
	if (!result.ok) return { paper, result };
	const { bytes, ...rest } = result;
	if (flags.keep) writeFileSync(`bench/pdfs/${(paper.doi ?? paper.openalexId ?? "paper").replace(/[^\w.-]+/gu, "_")}.pdf`, bytes);
	return { paper, result: rest, bytes: bytes.byteLength, ...(opened ? { pages: opened.pages, title: titleMatch(paper.title ?? "", opened.text) } : {}) };
}

const started = Date.now();
let next = 0;
await Promise.all(
	Array.from({ length: Number(flags.parallel) }, async () => {
		while (next < papers.length) {
			const paper = papers[next++]!;
			const row = await run(paper);
			rows.push(row);
			const { result } = row;
			console.log(`${String(rows.length).padStart(4)}/${papers.length} ${result.ok ? `found  ${result.source.padEnd(13)}` : `missed ${result.reason.padEnd(13)}`} ${String(result.ms).padStart(6)} ms  ${paper.doi ?? paper.openalexId}`);
		}
	}),
);

const percentile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))] ?? 0;
const tally = (values: string[]) => Object.entries(Object.groupBy(values, (value) => value)).map(([name, group]) => `${name} ${group!.length}`).sort((a, b) => Number(b.split(" ").at(-1)) - Number(a.split(" ").at(-1))).join(", ");
const found = rows.filter((row) => row.result.ok);
const missed = rows.filter((row) => !row.result.ok);
const times = (group: Row[]) => group.map((row) => row.result.ms);
const judged = found.filter((row) => row.title !== undefined);

console.log(`\n${basename(file)}: ${found.length} of ${rows.length} found (${((100 * found.length) / rows.length).toFixed(1)}%) in ${((Date.now() - started) / 1000).toFixed(0)} s`);
console.log(`  found by      ${tally(found.map((row) => (row.result.ok ? row.result.source : "")))}`);
console.log(`  missed as     ${tally(missed.map((row) => (row.result.ok ? "" : row.result.reason)))}`);
console.log(`  time found    median ${percentile(times(found), 0.5)} ms, 90th ${percentile(times(found), 0.9)} ms`);
console.log(`  time missed   median ${percentile(times(missed), 0.5)} ms, 90th ${percentile(times(missed), 0.9)} ms`);
console.log(`  requests      median ${percentile(rows.map((row) => row.result.attempts.length), 0.5)} a paper, ${rows.reduce((sum, row) => sum + row.result.attempts.length, 0)} in all`);
console.log(`  title check   ${judged.filter((row) => row.title! >= 0.6).length} of ${judged.length} with text carry the paper's title, ${found.length - judged.length} could not be compared`);
const statuses = Object.groupBy(rows, (row) => row.paper.status ?? "unknown");
console.log(`  by status     ${Object.entries(statuses).map(([status, group]) => `${status} ${group!.filter((row) => row.result.ok).length}/${group!.length}`).join(", ")}`);
const lost = missed.flatMap((row) => row.result.attempts.filter((attempt) => attempt.outcome !== "lookup" && attempt.source !== "wayback").map((attempt) => `${new URL(attempt.url).hostname} ${attempt.outcome}${attempt.status ? ` ${attempt.status}` : ""}`));
console.log(`  misses' hosts ${tally(lost).split(", ").slice(0, 25).join(", ")}`);
console.log(`  file endings  ${JSON.stringify(endings)}`);
console.log(`  missed with an OpenAlex copy for sale: ${missed.filter((row) => row.paper.openAlexCopy).length}`);

mkdirSync("bench/results", { recursive: true });
const saved = `bench/results/${basename(file).replace(/\.\w+$/u, "")}-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`;
writeFileSync(saved, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
console.log(`  saved         ${saved}`);
