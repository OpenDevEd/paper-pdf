# @opendeved/paper-pdf

Finds and downloads one paper's open PDF. Openscholar and Evidence Community share it, so both look in the same places, in the same order, and remember the same misses.

```ts
import { findPdf } from "@opendeved/paper-pdf";
import { publicFetch } from "@opendeved/paper-pdf/node";

const result = await findPdf(
	{ doi: "10.1186/s12982-025-00852-8", openalexId: "W4413331464", urls: ["https://link.springer.com/content/pdf/10.1186/s12982-025-00852-8.pdf"], openAccess: true },
	{ fetch: publicFetch, userAgent: "ExampleBot/1.0 (+https://example.org/bot)", contactEmail: "bot@example.org", memory },
);

if (result.ok) save(result.bytes, result.url, result.source);
else show(result.reason, result.retryAt);
```

## Order of a search

A search stops at the first file that is a whole PDF and the paper.

1. **Memory.** A paper that had no copy last time is not searched again until its retry time. That answer costs no request.
2. **What the caller knows.** A paper OpenAlex calls closed, with no link, costs no request either.
3. **The caller's own links.** While one of them is delivering a PDF, nothing else is asked. A link to PubMed Central, figshare or an arXiv abstract is swapped for the address that serves the file to a script.
4. **Services**, once a link fails or takes longer than 1.5 seconds: Crossref's registered full-text links, and Unpaywall and OpenAlex unless the caller already holds the paper's OpenAlex record (it passed OpenAlex's ID and links). They are asked at the same time.
5. **Pages.** A landing page's declared PDF (`citation_pdf_url`, a link of type PDF) is followed, then links on the page's own site that read as a PDF and are named one.
6. **The Internet Archive's saved copy** of a link whose host refused the request or lost the file.
7. **OpenAlex's own copy**, when `buyOpenAlexCopy` is set and every free copy has failed. OpenAlex charges for each download.

Up to three links are tried side by side. The second starts when the first has delivered no PDF after 1.5 seconds, or after 9 seconds when a PDF is arriving slowly. A host gets at most four requests at a time from one process, redirects included.

## Many papers at once

Steps 4, 6 and 7 lean on services every search shares, and those refuse bursts. The Internet Archive answered 120 questions of 120 at 1.5 a second and refused after 13 at 3 a second. Crossref states 10 a second. So thousands of papers take two passes:

```ts
// During the import, as many at a time as its lanes allow: the papers' own links and what their pages lead to.
const first = await findPdf(paper, { ...options, quick: true });

// Afterwards, in the background, for the papers the first pass missed.
if (!first.ok) queue(() => findPdf(paper, options));
```

A quick search asks no service and no archive, so its speed is that of the papers' own hosts. Its miss is not remembered, and the full search can follow at once.

In the full search the package asks each shared service at a steady pace, however many searches are running: the Internet Archive once every 0.7 seconds, Crossref once every 0.15. A search waits its turn, and the wait does not count against its `budgetMs`. A service that still answers 429 is left alone by every search for the time it names, or 30 seconds, and asked once more. The pace is kept per process, so one worker should run the background pass.

## What a search returns

A find carries the bytes, the address they came from, the `source` that named it and every request made. `source` is `openalex-copy` for a file that cost money, so the caller knows to charge for it.

A miss carries a reason and the time a new search is worth it:

| Reason | Meaning | First retry |
| --- | --- | --- |
| `closed` | Not open access and no link. An upload or a paid copy can help. | 30 days |
| `blocked` | A copy exists and its host refuses scripts. | 7 days |
| `no_pdf` | Every link answered and none was the paper. | 14 days |
| `unreachable` | Hosts did not answer, or time ran out. | 1 hour |

Each further miss doubles the wait, up to 60 days.

## Memory

`memory` is any object with `get(key)` and `set(key, value)`, sync or async. A `Map` works for one process. Pass a store both products read (a table, a bucket) and each learns from the other. Two kinds of record go in, both plain JSON:

- `paper:doi:<doi>` holds a paper's last miss. Write `null` to `paperKey(paper)` when a paper's links change.
- `host:<name>` holds a host that showed a bot challenge. It is left alone for 6 hours.

The package keeps no PDFs. The caller stores what it finds and reads its own store before calling `findPdf`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `fetch` | global `fetch` | On Node pass `publicFetch`, which also refuses names that resolve to private addresses. |
| `userAgent` | `paper-pdf/0.1` | How requests name the caller. Leave "Mozilla" out (see below). |
| `contactEmail` | none | Unpaywall needs it and is skipped without it. |
| `openAlexKey` | none | Reads the paper's OpenAlex record when the caller does not hold it. |
| `buyOpenAlexCopy` | off | Downloads OpenAlex's paid copy as the last step. |
| `budgetMs` | 45,000 | The longest one search may take, not counting time spent waiting for a host's turn. |
| `quick` | off | Tries only the caller's links, the DOI and the PDFs their pages lead to. For the first pass over many papers. |
| `hedgeMs` | 1,500 | How long a link may go without delivering before the next starts beside it. |
| `maxBytes` | 50 MiB | The largest file accepted. |
| `accept` | none | Returns why a PDF is not the paper, and the search moves on. `articleProblem({ pages, text })` knows preprint cover sheets and publisher previews. |
| `searchClosed` | off | Searches papers OpenAlex calls closed. |
| `signal` | none | Stops the search. A stopped search is not remembered. |

## Safety

Links come from metadata services and from pages, so any of them may point at the caller's own network. `findPdf` follows redirects itself and checks every address before requesting it. `publicFetch` connects only to addresses its own DNS lookup accepted, so a name cannot resolve to a public address for the check and a private one for the connection. The global `fetch` has no such check: use `publicFetch` wherever Node runs.

The OpenAlex key is cut from every recorded address.

## What it accepts as the paper

- A file that starts as a PDF and ends as one: its first kilobyte holds `%PDF-`, and its ending names where its table of objects starts, with the table at that position. A download that stopped early fails this, as three copies from the Internet Archive did. The content type is ignored: sign-in pages arrive as `application/pdf` and PDFs as `application/octet-stream`.
- The file is not parsed further. A caller that parses PDFs passes its parser as `accept`, which also catches a damaged file that still ends well.
- Not a supplement: a publisher's supplement folder, or a file named the way PubMed Central, Elsevier and Springer name supplements.
- Not a site document: a link named terms, licence, guidelines, FAQ and the like is never followed.
- Not another site's PDF that a page happens to link to.

## Naming the bot

Name the caller plainly, such as `ExampleBot/1.0 (+https://example.org/bot)`, and leave "Mozilla" out. Springer, BMC, HAL and sites behind Anubis challenge names that look like a browser and serve a plainly named bot. On 250 first links the plain name fetched 86 PDFs and `Mozilla/5.0 (compatible; ...)` fetched 69.

## What stays out

- Sci-Hub and other copies shared without the publisher's permission.
- A browser, and requests dressed up as one. A host that challenges scripts is answered from the Internet Archive or left as a miss.
- Storage and billing. Both belong to the product.

## Measured

Run on 23 November 2026 from one laptop. Every found file was opened with pdf.js.

**250 random open-access articles** from OpenAlex, 50 of each status, published 2010 to 2025, each with the links OpenAlex holds:

| Downloader | Found | Median time to a find |
| --- | --- | --- |
| Openscholar's `lib/pdf/download.ts` | 86 (34%) | 1.5 s |
| Evidence Community's `pdf-download.ts` | 125 (50%) | 1.2 s |
| This package, free copies only | 183 (73%) | 1.7 s |

Of the 183, 118 came from the paper's own link, 26 from a PDF a page declared, 32 from the Internet Archive, 5 from the DOI's page and 2 from a link Crossref holds. Nine in ten finds took under 11 seconds, and a miss took a median of 1.4 seconds. A paper cost a median of 3 requests. By status: diamond 43 of 50, gold 46, hybrid 32, bronze 33, green 29.

Of the 67 misses, 48 met a host that refuses scripts (Wiley, Elsevier, Taylor & Francis, Oxford, IOP, MDPI among them), and 28 have a copy OpenAlex sells.

The first pages of 171 of the 178 files that have text carry the paper's title. The other 7 were not read by hand: six look like papers in Japanese, Ukrainian, Chinese or Arabic whose OpenAlex title is in another language, and one is a 90-page file that may be a whole journal issue.

Runs that day found between 178 and 185 with a steady connection.

**1,000 other random open-access articles, the way an import runs**, 200 of each status:

| | Found | Time |
| --- | --- | --- |
| Evidence Community's `pdf-download.ts`, 48 at a time | 499 | 161 s |
| This package, first pass: quick, 48 at a time | 584 | 138 s |
| This package, second pass over the 416 misses: full, 8 at a time | 124 more | 585 s |
| This package, both passes | 708 (71%) | |

An earlier run of the same two passes found 709, with the first pass at 106 seconds. The Internet Archive was asked 560 questions, about one a second, and refused none. Before the pacing, one pass of everything at 48 at a time lost 25 of 184 finds on the 250-paper list to refusals.

**93 open papers the Evidence Community downloader had failed on** (collected in October 2026): 50 found, 30 of them from the Internet Archive. All 43 misses have a copy OpenAlex sells. Runs ranged from 49 to 54.

**100 random closed articles**: with the default, no request is made for a closed paper that has no link. With `searchClosed`, 5 were found at about 4 requests a paper: four are the paper, and one is a single page from Springer that may be a preview.

**OpenAlex's paid copy**: 5 of 5 papers that had failed every free route came back, at about a cent each. The counts of copies for sale above come from OpenAlex's `has_content.pdf` flag and were not bought.

To run it again:

```sh
export OPENALEX_API_KEY=... PAPER_PDF_EMAIL=...
node bench/sample.ts random gold 50 > bench/lists/gold.jsonl
node bench/run.ts bench/lists/open.jsonl
```

`bench/run.ts` prints the totals and writes every request of every paper to `bench/results`.

## Development

```sh
npm install
npm run verify   # lint, typecheck, tests, build
```

The tests run `findPdf` against a real local HTTP server that stands in for every host (`src/testing.ts`), so redirects, streams and time limits are the real ones.
