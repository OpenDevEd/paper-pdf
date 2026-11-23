import { expect, test } from "vitest";
import { articleProblem, isPublicUrl, isSupplementUrl, isWholePdf, pdfLinks } from "./check.ts";
import { PDF } from "./testing.ts";

test.each([
	["https://journals.example.org/a.pdf", true],
	["http://8.8.8.8/a.pdf", true],
	["http://127.0.0.1/a.pdf", false],
	// The URL parser turns these spellings of 127.0.0.1 into the dotted form before the check sees them.
	["http://2130706433/a.pdf", false],
	["http://0x7f.1/a.pdf", false],
	["http://[::1]/a.pdf", false],
	["http://[::ffff:8.8.8.8]/a.pdf", false],
	["http://localhost./a.pdf", false],
	["http://printer/a.pdf", false],
	["http://storage.internal/a.pdf", false],
	["http://169.254.169.254/latest/meta-data", false],
	["http://192.168.1.1/a.pdf", false],
	["http://172.20.0.1/a.pdf", false],
	["http://100.100.100.200/a.pdf", false],
	["ftp://journals.example.org/a.pdf", false],
	["file:///etc/passwd", false],
])("%s is public: %s", (address, expected) => {
	expect(isPublicUrl(new URL(address))).toBe(expected);
});

test("a page's declared PDF comes first, and what is not the paper is left out", () => {
	const html = `
		<a href="/issue/cover.pdf">Cover</a>
		<a href="/issue/1/full.pdf">Whole issue (PDF)</a>
		<a href="/docs/Terms_and_Conditions.pdf">Download PDF</a>
		<a href="/docs/guide.pdf">Author guidelines (PDF)</a>
		<a href="https://www.regulator.example.gov/labels/drug.pdf">Label (PDF)</a>
		<a class="btn" href="/article/1/download/9">Download PDF</a>
		<a href="/doi/suppl/1/suppl_file/s1.pdf">PDF</a>
		<link rel="alternate" type="application/pdf" href="https://cdn.example.org/1.pdf">
		<meta content="https://journals.example.org/article/1/pdf" name="citation_pdf_url">`;

	expect(pdfLinks(html, new URL("https://journals.example.org/article/1")).map((url) => url.href)).toEqual([
		"https://journals.example.org/article/1/pdf",
		"https://cdn.example.org/1.pdf",
		"https://journals.example.org/issue/1/full.pdf",
		"https://journals.example.org/article/1/download/9",
	]);
	expect(pdfLinks(html, new URL("https://journals.example.org/article/1"), true).map((url) => url.href)).toEqual([
		"https://journals.example.org/article/1/pdf",
		"https://cdn.example.org/1.pdf",
	]);
});

test("two universities under one country's registry are two sites", () => {
	const html = '<a href="https://www.repository.cam.ac.uk/files/cited.pdf">PDF</a><a href="https://files.ox.ac.uk/objects/1/paper.pdf">Download PDF</a>';

	expect(pdfLinks(html, new URL("https://ora.ox.ac.uk/objects/1")).map((url) => url.href)).toEqual(["https://files.ox.ac.uk/objects/1/paper.pdf"]);
});

test("a supplement is told by its name, and a path that is not text is judged as written", () => {
	expect(isSupplementUrl(new URL("https://pmc.example/bin/NIHMS1-supplement-Supporting_Information.pdf"))).toBe(true);
	expect(isSupplementUrl(new URL("https://ars.els-cdn.example/content/mmc1.pdf"))).toBe(true);
	expect(isSupplementUrl(new URL("https://publisher.example/%FF.pdf"))).toBe(false);
	expect(isSupplementUrl(new URL("https://publisher.example/articles/supply-chains.pdf"))).toBe(false);
});

test("a PDF is whole when its ending names where its table of objects starts", () => {
	expect(isWholePdf(PDF)).toBe(true);
	expect(isWholePdf(PDF.subarray(0, 1_500))).toBe(false);
	expect(isWholePdf(Buffer.from("%PDF-1.7\njunk\n%%EOF\n"))).toBe(false);
	expect(isWholePdf(Buffer.from("%PDF-1.7\njunk\nstartxref\n9\n%%EOF\n"))).toBe(false);
});

test("a short PDF is the paper unless its text says it is a cover sheet or a preview", () => {
	expect(articleProblem({ pages: 2, text: "This is a hosted   file on Authorea.com" })).toBeTruthy();
	expect(articleProblem({ pages: 1, text: "More pages are available in the full version" })).toBeTruthy();
	expect(articleProblem({ pages: 2, text: "A two-page research note." })).toBeUndefined();
	expect(articleProblem({ pages: 12, text: "more pages are available in the full version" })).toBeUndefined();
});
