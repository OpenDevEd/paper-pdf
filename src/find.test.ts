import { afterEach, beforeEach, expect, test } from "vitest";
import { findPdf, forgetHosts, type Options, paperKey } from "./find.ts";
import { archive, challenge, cutShort, delayed, type Handler, json, page, PDF, pdf, redirect, stall, trickle, web, xml } from "./testing.ts";

const DAY = 86_400_000;

let site: Awaited<ReturnType<typeof web>> | undefined;

async function serve(routes: Record<string, Handler>) {
	site = await web(routes);
	const options: Options = { fetch: site.fetch, hedgeMs: 500, contactEmail: "team@library.example" };
	return { asked: site.asked, options };
}

beforeEach(() => forgetHosts());
afterEach(async () => {
	await site?.close();
	site = undefined;
});

test("the caller's link is fetched and nothing else is asked", async () => {
	const { asked, options } = await serve({ "publisher.example/a.pdf": pdf() });

	const result = await findPdf({ doi: "10.1/x", urls: ["https://publisher.example/a.pdf"] }, options);

	expect(result).toMatchObject({ ok: true, source: "given", url: "https://publisher.example/a.pdf" });
	expect(result.ok && Buffer.from(result.bytes).equals(PDF)).toBe(true);
	expect(asked).toEqual(["publisher.example/a.pdf"]);
});

test("a landing page's declared PDF is followed", async () => {
	const { options } = await serve({
		"publisher.example/article/1": page('<html><head><meta name="citation_pdf_url" content="/files/1.pdf?download=1&amp;inline=0"></head></html>'),
		"publisher.example/files/1.pdf": pdf(),
	});

	const result = await findPdf({ urls: ["https://publisher.example/article/1"] }, options);

	expect(result).toMatchObject({ ok: true, source: "page", url: "https://publisher.example/files/1.pdf?download=1&inline=0" });
});

test("a host that shows a bot challenge is answered from the Internet Archive and left alone afterwards", async () => {
	const { asked, options } = await serve({
		"blocked.example/a.pdf": challenge,
		"blocked.example/b.pdf": challenge,
		"blocked.example/c.pdf": challenge,
		...archive({ "https://blocked.example/a.pdf": pdf(), "https://blocked.example/b.pdf": pdf(), "https://blocked.example/c.pdf": pdf() }),
	});
	const memory = new Map<string, unknown>();

	const first = await findPdf({ urls: ["https://blocked.example/a.pdf"] }, { ...options, memory });
	const second = await findPdf({ urls: ["https://blocked.example/b.pdf"] }, { ...options, memory });
	// Another server, which learned nothing itself, reads the refusal from the shared memory.
	forgetHosts();
	const third = await findPdf({ urls: ["https://blocked.example/c.pdf"] }, { ...options, memory });

	expect([first, second, third]).toMatchObject([{ ok: true, source: "wayback" }, { ok: true, source: "wayback" }, { ok: true, source: "wayback" }]);
	expect(asked).toContain("blocked.example/a.pdf");
	expect(asked).not.toContain("blocked.example/b.pdf");
	expect(asked).not.toContain("blocked.example/c.pdf");
});

test("the archive's saved copy of a refusal does not count against the archive", async () => {
	const { options } = await serve({
		"blocked.example/a.pdf": challenge,
		"gone.example/b.pdf": page("Not found", 404),
		...archive({ "https://blocked.example/a.pdf": challenge, "https://gone.example/b.pdf": pdf() }),
	});

	const first = await findPdf({ urls: ["https://blocked.example/a.pdf"] }, options);
	const second = await findPdf({ urls: ["https://gone.example/b.pdf"] }, options);

	expect(first).toMatchObject({ ok: false, reason: "blocked" });
	expect(second).toMatchObject({ ok: true, source: "wayback" });
});

test("a saved page's links are read against the site it was saved from, however many links failed before", async () => {
	const { options } = await serve({
		"repository.example/handle/1": challenge,
		...archive({
			"https://repository.example/handle/1": page('<a href="/bitstreams/1/download">Download PDF</a>'),
			"https://repository.example/bitstreams/1/download": pdf(),
		}),
	});

	// With the page itself, as many failed links as the archive is asked about.
	const dead = ["https://a.example/1.pdf", "https://b.example/1.pdf"];
	const result = await findPdf({ urls: [...dead, "https://repository.example/handle/1"] }, options);

	expect(result).toMatchObject({ ok: true, source: "wayback", url: "https://web.archive.org/web/20240101000000id_/https://repository.example/bitstreams/1/download" });
});

test("a figshare item, whose page needs a browser, is read from figshare's record of its files", async () => {
	const { options } = await serve({
		// With a version number after the item's own.
		"doi.org/10.6084/m9.figshare.6470414": redirect("https://figshare.com/articles/journal_contribution/A_paper/6470414/2"),
		"figshare.com/articles/journal_contribution/A_paper/6470414/2": page("<html><body><div id='root'></div></body></html>"),
		"api.figshare.com/v2/articles/6470414": json({
			files: [
				{ name: "data.csv", download_url: "https://ndownloader.figshare.com/files/1" },
				{ name: "supplement.pdf", mimetype: "application/pdf", download_url: "https://ndownloader.figshare.com/files/3" },
				{ name: "paper.pdf", mimetype: "application/pdf", download_url: "https://ndownloader.figshare.com/files/2" },
			],
		}),
		"ndownloader.figshare.com/files/2": pdf(),
		"ndownloader.figshare.com/files/3": pdf(),
	});

	const result = await findPdf({ doi: "10.6084/m9.figshare.6470414" }, options);

	expect(result).toMatchObject({ ok: true, url: "https://ndownloader.figshare.com/files/2" });
});

test("a quick search asks no service and no archive, and the full search can follow at once", async () => {
	const { asked, options } = await serve({
		"api.crossref.org/works/10.1%2Fx": json({ message: { DOI: "10.1/x", link: [{ URL: "https://repository.example/x.pdf", "content-type": "application/pdf" }] } }),
		"repository.example/x.pdf": pdf(),
		...archive({ "https://publisher.example/gone.pdf": pdf() }),
	});
	const memory = new Map<string, unknown>();
	const paper = { doi: "10.1/x", openalexId: "W1", urls: ["https://publisher.example/gone.pdf"] };

	const quick = await findPdf(paper, { ...options, memory, quick: true });

	expect(quick).toMatchObject({ ok: false, remembered: false });
	expect(asked).toEqual(["publisher.example/gone.pdf", "doi.org/10.1/x"]);
	expect([...memory.keys()].filter((key) => key.startsWith("paper:"))).toEqual([]);

	const full = await findPdf(paper, { ...options, memory });

	expect(full.ok).toBe(true);
});

test("a search that waits its turn for the archive does not run out of time", async () => {
	const { options } = await serve({ ...archive({ "https://gone.example/a.pdf": pdf(), "https://gone.example/b.pdf": pdf() }) });
	const began = Date.now();

	// The archive is asked one question every 0.7 seconds, which is longer than either search may take.
	const results = await Promise.all([
		findPdf({ urls: ["https://gone.example/a.pdf"] }, { ...options, budgetMs: 500 }),
		findPdf({ urls: ["https://gone.example/b.pdf"] }, { ...options, budgetMs: 500 }),
	]);

	expect(results).toMatchObject([{ ok: true, source: "wayback" }, { ok: true, source: "wayback" }]);
	expect(Date.now() - began).toBeGreaterThan(600);
});

test("the archive asking for fewer requests is asked again after the time it names", async () => {
	const copies = archive({ "https://gone.example/a.pdf": pdf() });
	let refusals = 1;
	const { asked, options } = await serve({
		...copies,
		"archive.org/wayback/available": (request, response) => {
			if (refusals-- > 0) response.writeHead(429, { "retry-after": "1" }).end();
			else copies["archive.org/wayback/available"]!(request, response);
		},
	});
	const began = Date.now();

	const result = await findPdf({ urls: ["https://gone.example/a.pdf"] }, options);

	expect(result).toMatchObject({ ok: true, source: "wayback" });
	expect(asked.filter((key) => key.startsWith("archive.org/wayback/available"))).toHaveLength(2);
	expect(Date.now() - began).toBeGreaterThan(900);
});

test("a service that asks to be left alone for a long time is not waited for", async () => {
	const { asked, options } = await serve({
		...archive({ "https://gone.example/a.pdf": pdf() }),
		"archive.org/wayback/available": (_request, response) => void response.writeHead(429, { "retry-after": "600" }).end(),
	});
	const began = Date.now();

	const result = await findPdf({ urls: ["https://gone.example/a.pdf"] }, options);

	expect(result.ok).toBe(false);
	expect(asked.filter((key) => key.startsWith("archive.org/wayback/available"))).toHaveLength(1);
	expect(Date.now() - began).toBeLessThan(5_000);
});

test("a memory that never answers about a host does not keep the search from ending", async () => {
	const { options } = await serve({ "publisher.example/a.pdf": pdf() });
	const memory = { get: (key: string) => (key.startsWith("host:") ? new Promise(() => undefined) : undefined), set: () => undefined };

	const result = await findPdf({ urls: ["https://publisher.example/a.pdf"] }, { ...options, memory, budgetMs: 300 });

	expect(result).toMatchObject({ ok: false, reason: "unreachable" });
});

test("a sign-in page at a PDF link is passed over, and a PDF with another content type is taken", async () => {
	const { options } = await serve({
		"publisher.example/a.pdf": page("<html><body>Sign in to continue</body></html>"),
		"repository.example/a.pdf": pdf(PDF, "application/octet-stream"),
	});

	const result = await findPdf({ urls: ["https://publisher.example/a.pdf", "https://repository.example/a.pdf"] }, options);

	expect(result).toMatchObject({ ok: true, url: "https://repository.example/a.pdf" });
});

test("Crossref is asked once the caller's link fails", async () => {
	const { asked, options } = await serve({
		"api.crossref.org/works/10.1%2Fx": json({ message: { DOI: "10.1/X", link: [{ URL: "https://publisher.example/files/x.pdf?a=1&amp;b=2", "content-type": "application/pdf" }, { URL: "https://api.publisher.example/tdm/x", "content-type": "unspecified" }] } }),
		"publisher.example/files/x.pdf": pdf(),
	});

	// The ID and the links say the caller holds OpenAlex's record, whose links are Unpaywall's.
	const result = await findPdf({ doi: "https://doi.org/10.1/X", openalexId: "W1", urls: ["https://publisher.example/gone.pdf"] }, options);

	expect(result).toMatchObject({ ok: true, source: "crossref", url: "https://publisher.example/files/x.pdf?a=1&b=2" });
	expect(result.attempts).toContainEqual(expect.objectContaining({ source: "crossref", outcome: "lookup", note: "1 links" }));
	expect(asked.filter((key) => key.startsWith("api.unpaywall.org"))).toEqual([]);
});

test("a paper whose links are not OpenAlex's is looked up in Unpaywall", async () => {
	const { options } = await serve({
		"api.unpaywall.org/v2/10.1%2Fx": json({ oa_locations: [{ url_for_pdf: "https://repository.example/green.pdf" }] }),
		"repository.example/green.pdf": pdf(),
	});

	const result = await findPdf({ doi: "10.1/x", urls: ["https://publisher.example/gone.pdf"] }, options);

	expect(result).toMatchObject({ ok: true, source: "unpaywall", url: "https://repository.example/green.pdf" });
});

test("the services are not asked while the caller's landing page is still answering", async () => {
	const { asked, options } = await serve({
		"publisher.example/article/1": delayed(page('<meta name="citation_pdf_url" content="/files/1.pdf">'), 100),
		"publisher.example/files/1.pdf": pdf(),
	});

	const result = await findPdf({ doi: "10.1/x", urls: ["https://publisher.example/article/1"] }, options);

	expect(result).toMatchObject({ ok: true, source: "page" });
	expect(asked).toEqual(["publisher.example/article/1", "publisher.example/files/1.pdf"]);
});

test("a link that only mentions PubMed Central is fetched as it is", async () => {
	const { asked, options } = await serve({ "publisher.example/a.pdf": pdf() });

	const result = await findPdf({ urls: ["https://publisher.example/a.pdf?ref=https://pmc.ncbi.nlm.nih.gov/articles/PMC999/"] }, options);

	expect(result.ok).toBe(true);
	expect(asked).toEqual(["publisher.example/a.pdf?ref=https://pmc.ncbi.nlm.nih.gov/articles/PMC999/"]);
});

test("a host that fails to connect three times in a row is left alone", async () => {
	const { options } = await serve({});
	let calls = 0;
	const down: typeof fetch = (input, init) => {
		if (new URL(input as string | URL).hostname !== "down.example") return options.fetch!(input, init);
		calls++;
		return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
	};

	for (const name of ["a", "b", "c", "d", "e"]) await findPdf({ urls: [`https://down.example/${name}.pdf`] }, { ...options, fetch: down, quick: true });

	expect(calls).toBe(3);
});

test("a host that cannot be reached stays worth a retry soon when the archive has no copy either", async () => {
	const { options } = await serve({ ...archive({}) });
	const down: typeof fetch = (input, init) => (new URL(input as string | URL).hostname === "down.example" ? Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })) : options.fetch!(input, init));

	const result = await findPdf({ urls: ["https://down.example/a.pdf"] }, { ...options, fetch: down });

	expect(result).toMatchObject({ ok: false, reason: "unreachable" });
	expect(!result.ok && result.retryAt - Date.now()).toBeLessThan(2 * 3_600_000);
});

test("a PDF that was cut short is passed over", async () => {
	const { options } = await serve({ "publisher.example/a.pdf": cutShort, "repository.example/a.pdf": pdf() });

	const result = await findPdf({ urls: ["https://publisher.example/a.pdf", "https://repository.example/a.pdf"] }, options);

	expect(result).toMatchObject({ ok: true, url: "https://repository.example/a.pdf" });
	expect(result.attempts).toContainEqual(expect.objectContaining({ outcome: "not_pdf", note: "A PDF cut short" }));
});

test("a miss is remembered, costs no request until its retry time, and waits longer after each further miss", async () => {
	const { asked, options } = await serve({});
	const memory = new Map<string, unknown>();
	const paper = { doi: "10.1/x", urls: ["https://publisher.example/gone.pdf"] };

	const first = await findPdf(paper, { ...options, memory });
	asked.length = 0;
	const second = await findPdf(paper, { ...options, memory });

	expect(first).toMatchObject({ ok: false, reason: "no_pdf", remembered: false });
	expect(second).toMatchObject({ ok: false, reason: "no_pdf", remembered: true, attempts: [] });
	expect(asked).toEqual([]);

	memory.set(paperKey(paper)!, { ...(memory.get(paperKey(paper)!) as object), retryAt: Date.now() - 1 });
	const third = await findPdf(paper, { ...options, memory });

	expect(third).toMatchObject({ ok: false, remembered: false });
	expect(asked).toContain("publisher.example/gone.pdf");
	expect(!third.ok && third.retryAt - Date.now()).toBeGreaterThan(20 * DAY);
});

test("a closed paper with no link costs no request", async () => {
	const { asked, options } = await serve({});

	const result = await findPdf({ doi: "10.1/x", openAccess: false }, options);

	expect(result).toMatchObject({ ok: false, reason: "closed", attempts: [] });
	expect(asked).toEqual([]);
});

test("a private address is never requested, whether a page links to it or a redirect leads to it", async () => {
	const { asked, options } = await serve({
		"publisher.example/article": page('<meta name="citation_pdf_url" content="http://169.254.169.254/latest/meta-data.pdf"><a href="http://localhost/admin.pdf">PDF</a>'),
		"publisher.example/moved.pdf": redirect("http://10.0.0.5/secret.pdf"),
		"169.254.169.254/latest/meta-data.pdf": pdf(),
		"localhost/admin.pdf": pdf(),
		"10.0.0.5/secret.pdf": pdf(),
	});

	const result = await findPdf({ urls: ["https://publisher.example/article", "https://publisher.example/moved.pdf"] }, options);

	expect(result.ok).toBe(false);
	expect(asked.filter((key) => /^(?:169\.254|localhost|10\.)/u.test(key))).toEqual([]);
});

test("a supplement is not taken for the paper", async () => {
	const { asked, options } = await serve({
		"publisher.example/doi/suppl/10.1/x/suppl_file/s1.pdf": pdf(),
		"pmc.example/articles/instance/1/bin/NIHMS1-supplement-Supporting_Information.pdf": pdf(),
	});

	const result = await findPdf(
		{ urls: ["https://publisher.example/doi/suppl/10.1/x/suppl_file/s1.pdf", "https://pmc.example/articles/instance/1/bin/NIHMS1-supplement-Supporting_Information.pdf"] },
		options,
	);

	expect(result.ok).toBe(false);
	expect(asked).toEqual([]);
});

test("a file over the size limit is refused", async () => {
	const { options } = await serve({
		"publisher.example/a.pdf": pdf(),
		"publisher.example/small.pdf": pdf(Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<<>>\nstartxref\n29\n%%EOF\n")),
	});

	const result = await findPdf({ urls: ["https://publisher.example/a.pdf"] }, { ...options, maxBytes: 1_500 });

	expect(result.ok).toBe(false);
	expect(result.attempts).toContainEqual(expect.objectContaining({ outcome: "too_large" }));

	// A file so small that it ends before its first bytes are looked at.
	const small = await findPdf({ urls: ["https://publisher.example/small.pdf"] }, { ...options, maxBytes: 50 });

	expect(small.attempts).toContainEqual(expect.objectContaining({ outcome: "too_large" }));
});

test("a link that stalls does not hold up the next one", async () => {
	const { options } = await serve({ "slow.example/a.pdf": stall, "repository.example/a.pdf": pdf() });

	const result = await findPdf({ urls: ["https://slow.example/a.pdf", "https://repository.example/a.pdf"] }, { ...options, hedgeMs: 50 });

	expect(result).toMatchObject({ ok: true, url: "https://repository.example/a.pdf" });
	expect(result.ms).toBeLessThan(5_000);
});

test("a PDF that arrives too slowly gets a competitor", async () => {
	const { options } = await serve({ "slow.example/a.pdf": trickle, "repository.example/a.pdf": pdf() });

	const result = await findPdf({ urls: ["https://slow.example/a.pdf", "https://repository.example/a.pdf"] }, { ...options, hedgeMs: 30 });

	expect(result).toMatchObject({ ok: true, url: "https://repository.example/a.pdf" });
	expect(result.ms).toBeLessThan(5_000);
});

test("a PubMed Central link is answered from its open storage, the latest version first", async () => {
	const storage = "pmc-oa-opendata.s3.amazonaws.com/";
	const { asked, options } = await serve({
		"pmc.ncbi.nlm.nih.gov/articles/PMC123/pdf/": page("<html><head><title>Preparing to download ...</title></head></html>"),
		[`${storage}?list-type=2&prefix=PMC123.`]: xml(
			"<ListBucketResult><Contents><Key>PMC123.1/PMC123.1.pdf</Key></Contents><Contents><Key>PMC123.2/PMC123.2.json</Key></Contents><Contents><Key>PMC123.2/PMC123.2.pdf</Key></Contents></ListBucketResult>",
		),
		[`${storage}PMC123.1/PMC123.1.pdf`]: pdf(),
		[`${storage}PMC123.2/PMC123.2.pdf`]: pdf(),
	});

	const result = await findPdf({ urls: ["https://pmc.ncbi.nlm.nih.gov/articles/PMC123/pdf/"] }, options);

	expect(result).toMatchObject({ ok: true, url: `https://${storage}PMC123.2/PMC123.2.pdf` });
	expect(asked).not.toContain("pmc.ncbi.nlm.nih.gov/articles/PMC123/pdf/");
});

test("OpenAlex's paid copy is bought only after every free copy failed, and its key stays out of the record", async () => {
	const { asked, options } = await serve({ "content.openalex.org/works/W1.pdf": pdf() });
	const paper = { doi: "10.1/x", openalexId: "https://openalex.org/W1", urls: ["https://publisher.example/gone.pdf"] };

	const unpaid = await findPdf(paper, { ...options, openAlexKey: "sekret" });
	const asksBefore = asked.length;
	const paid = await findPdf(paper, { ...options, openAlexKey: "sekret", buyOpenAlexCopy: true });

	expect(unpaid.ok).toBe(false);
	expect(asked.slice(0, asksBefore).filter((key) => key.startsWith("content.openalex.org"))).toEqual([]);
	expect(paid).toMatchObject({ ok: true, source: "openalex-copy", url: "https://content.openalex.org/works/W1.pdf" });
	expect(asked.at(-1)).toBe("content.openalex.org/works/W1.pdf?api_key=sekret");
	expect(JSON.stringify(paid.attempts)).not.toContain("sekret");

	// An error that quotes the address it failed on.
	const failing: typeof fetch = (input, init) => (new URL(input as string | URL).hostname === "content.openalex.org" ? Promise.reject(new Error(`No route to ${new URL(input as string | URL).href}`)) : options.fetch!(input, init));
	const failed = await findPdf(paper, { ...options, fetch: failing, openAlexKey: "sekret", buyOpenAlexCopy: true });

	expect(failed.attempts).toContainEqual(expect.objectContaining({ source: "openalex-copy", outcome: "network" }));
	expect(JSON.stringify(failed)).not.toContain("sekret");
});

test("OpenAlex's paid copy is not bought while a service may still name a free one", async () => {
	const { asked, options } = await serve({
		"api.crossref.org/works/10.1%2Fx": delayed(json({ message: { DOI: "10.1/x", link: [{ URL: "https://repository.example/green.pdf", "content-type": "application/pdf" }] } }), 150),
		"repository.example/green.pdf": pdf(),
		"content.openalex.org/works/W1.pdf": pdf(),
	});

	const result = await findPdf(
		{ doi: "10.1/x", openalexId: "W1", urls: ["https://publisher.example/gone.pdf"] },
		{ ...options, openAlexKey: "sekret", buyOpenAlexCopy: true },
	);

	expect(result).toMatchObject({ ok: true, source: "crossref" });
	expect(asked.filter((key) => key.startsWith("content.openalex.org"))).toEqual([]);
});

test("a caller's check that throws does not stop the search", async () => {
	const { options } = await serve({ "publisher.example/a.pdf": pdf(), "repository.example/a.pdf": pdf() });

	const result = await findPdf(
		{ urls: ["https://publisher.example/a.pdf", "https://repository.example/a.pdf"] },
		{
			...options,
			accept: ({ url }) => {
				if (url.includes("publisher")) throw new Error("The parser crashed");
				return undefined;
			},
		},
	);

	expect(result).toMatchObject({ ok: true, url: "https://repository.example/a.pdf" });
	expect(result.attempts).toContainEqual(expect.objectContaining({ outcome: "rejected", note: "Failed: The parser crashed" }));
});

test("the search moves on when the caller says a PDF is not the paper", async () => {
	const { options } = await serve({ "preprints.example/cover.pdf": pdf(), "repository.example/a.pdf": pdf() });

	const result = await findPdf(
		{ urls: ["https://preprints.example/cover.pdf", "https://repository.example/a.pdf"] },
		{ ...options, accept: ({ url }) => (url.includes("cover") ? "A preprint cover sheet, not the manuscript" : undefined) },
	);

	expect(result).toMatchObject({ ok: true, url: "https://repository.example/a.pdf" });
	expect(result.attempts).toContainEqual(expect.objectContaining({ outcome: "rejected", note: "A preprint cover sheet, not the manuscript" }));
});
