/** What a response turned out to be: checks on addresses, files and pages. Runs anywhere `fetch` does. */

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** A PDF may carry a short preamble before its header, so the header is looked for in the first kilobyte. */
export function isPdf(bytes: Uint8Array): boolean {
	const last = Math.min(bytes.byteLength, 1024) - PDF_HEADER.length;
	for (let at = 0; at <= last; at++) {
		if (PDF_HEADER.every((byte, offset) => bytes[at + offset] === byte)) return true;
	}
	return false;
}

const PDF_END = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF

/**
 * Whether a PDF arrived whole: one ends with an end-of-file mark, and a download that stopped early has none. On
 * 241 downloaded files this agreed every time with whether pdf.js could open the file.
 */
export function isWholePdf(bytes: Uint8Array): boolean {
	for (let at = bytes.byteLength - PDF_END.length; at >= Math.max(0, bytes.byteLength - 4_096); at--) {
		if (PDF_END.every((byte, offset) => bytes[at + offset] === byte)) return true;
	}
	return false;
}

/**
 * Whether an address is on the public internet, judged from how it is written. Links come from metadata services and
 * from pages, so one may point at this machine or its network. A name that resolves to a private address passes
 * here: `publicFetch` in `./node` refuses that one when it connects.
 */
export function isPublicUrl(url: URL): boolean {
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase().replace(/\.$/u, "");
	// No paper is served from an IPv6 address written out, or from a name without a dot.
	if (host.startsWith("[") || !host.includes(".")) return false;
	if (/\.(?:local|localhost|internal|lan|home|corp|test|invalid)$/u.test(host)) return false;
	const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/u.exec(host);
	if (!v4) return true;
	const a = Number(v4[1]);
	const b = Number(v4[2]);
	return !(
		a === 0 || a === 10 || a === 127 || a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 88 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19 || b === 51)) ||
		(a === 203 && b === 0)
	);
}

/**
 * A link to a paper's supplement, which is a PDF but not the paper: a publisher's supplement folder, or a file named
 * the way PubMed Central, Elsevier and Springer name supplements.
 */
export function isSupplementUrl(url: URL): boolean {
	const path = decodeURIComponent(url.pathname.replace(/%(?![0-9a-f]{2})/giu, "%25")).toLowerCase();
	if (path.includes("/downloadsupplement") || path.includes("/suppl_file/")) return true;
	return /supplement|supporting[_-]?info|[-_]suppl?[-_.\d]|^mmc\d+\.pdf$|moesm\d|_esm\.pdf$/u.test(path.split("/").at(-1) ?? "");
}

/** Whether a link reads as a PDF's own address, as opposed to the page about the paper. */
export function looksLikePdfUrl(url: URL): boolean {
	return /\.pdf$|\/pdf(?:\/|$)|\/pdfdirect\/|\/fullpdf|viewcontent\.cgi|\/bitstreams?\/|\/download(?:\/|$)|blobtype=pdf|type=printable/iu.test(
		url.pathname + url.search,
	);
}

/**
 * Why a page is a refusal to automated requests and not the paper's page, when it says so. A host that answers this
 * way answers every paper the same, so the caller stops asking it for a while.
 */
export function blockReason(headers: Headers, html: string): string | undefined {
	if (headers.get("cf-mitigated")) return "Cloudflare challenge";
	const title = /<title[^>]*>([^<]*)/iu.exec(html)?.[1]?.trim().toLowerCase() ?? "";
	if (title.startsWith("just a moment")) return "Cloudflare challenge";
	if (title === "client challenge") return "Fastly challenge";
	if (title.includes("making sure you") && title.includes("not a bot")) return "Anubis proof of work";
	const text = html.toLowerCase();
	if (text.includes("cpe00001") && text.includes("problem providing the content")) return "ScienceDirect bot protection";
	if (title.startsWith("preparing to download") || html.includes("POW_CHALLENGE")) return "PubMed Central proof of work";
	if (title.includes("radware bot manager") || text.includes("validate.perfdrive.com")) return "Radware bot manager";
	if (text.includes("_incapsula_resource")) return "Imperva challenge";
	if (text.includes("captcha-delivery.com")) return "DataDome challenge";
	if (title === "access denied" && text.includes("errors.edgesuite.net")) return "Akamai refusal";
	return undefined;
}

const decodeEntities = (value: string) =>
	value.replaceAll("&amp;", "&").replaceAll("&#38;", "&").replaceAll("&#x26;", "&").replaceAll("&quot;", '"').trim();

const attribute = (tag: string, name: string) =>
	new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "iu").exec(tag)?.slice(1).find((value) => value !== undefined);

const LINK_LIMIT = 5;

// ponytail: the last two labels stand for the site, so every `.ac.uk` host counts as one. A public-suffix list if a wrong file gets through.
const site = (url: URL) => url.hostname.split(".").slice(-2).join(".");

// A site's own documents, which a paper's page links to beside the paper.
const SITE_DOCUMENT = /licen[sc]e|permission|terms|conditions|voorwaarden|polic(?:y|ies)|guidelines?|instructions?|template|faq|copyright|checklist|brochure|flyer/iu;

/**
 * The PDFs a page links to, likeliest first: what it declares to indexers (`citation_pdf_url`, an alternate link
 * of type PDF), where it sends the browser next, then links that both read as a PDF and are named one. At most
 * five. With `declaredOnly`, the links are left out. A link counts on the page's own site alone, and not when it
 * names a site document: an article page also links to the PDFs it cites, to its terms and to its author guidelines.
 */
export function pdfLinks(html: string, base: URL, declaredOnly = false): URL[] {
	const found: string[] = [];
	const metas = html.match(/<meta\b[^>]*>/giu) ?? [];
	for (const tag of metas) {
		if (/^citation_pdf_url$/iu.test(attribute(tag, "name") ?? attribute(tag, "property") ?? "")) found.push(attribute(tag, "content") ?? "");
	}
	for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
		if (/^application\/pdf$/iu.test(attribute(tag, "type") ?? "")) found.push(attribute(tag, "href") ?? "");
	}
	for (const tag of metas) {
		if (!/^refresh$/iu.test(attribute(tag, "http-equiv") ?? "")) continue;
		found.push(/url\s*=\s*['"]?([^'"]+)/iu.exec(attribute(tag, "content") ?? "")?.[1] ?? "");
	}
	const declared = found.length;
	if (!declaredOnly) {
		const reads = (href: string) => /\.pdf(?:$|[?#])|\/pdf(?:\/|$)|viewcontent\.cgi|\/bitstreams?\/|\/download\//iu.test(href);
		for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/giu)) {
			const href = attribute(match[1] ?? "", "href") ?? "";
			const text = (match[2] ?? "").replace(/<[^>]*>/gu, " ");
			const named = /\bpdf\b|full[\s-]*text|download/iu.test(text) || /pdf/iu.test(attribute(match[1] ?? "", "class") ?? "");
			if (reads(href) && named && !SITE_DOCUMENT.test(text) && !SITE_DOCUMENT.test(href.split("/").at(-1) ?? "")) found.push(href);
		}
		for (const match of html.matchAll(/<(?:embed|iframe|object)\b[^>]*?\b(?:src|data)\s*=\s*["']([^"']*\.pdf[^"']*)["']/giu)) found.push(match[1] ?? "");
	}

	const links = new Map<string, URL>();
	for (const [index, value] of found.entries()) {
		if (!value || /^(?:javascript:|mailto:|#)/iu.test(value)) continue;
		let url: URL;
		try {
			url = new URL(decodeEntities(value), base);
		} catch {
			continue;
		}
		url.hash = "";
		if (url.href === base.href || isSupplementUrl(url) || (index >= declared && site(url) !== site(base))) continue;
		links.set(url.href, url);
		if (links.size === LINK_LIMIT) break;
	}
	return [...links.values()];
}

/**
 * Why a short PDF is not the paper, from its text: a preprint server's cover sheet or a publisher's preview. A
 * caller that extracts text passes it through `accept`. Longer PDFs are never judged, and a short paper with
 * neither phrase is a paper.
 */
export function articleProblem(file: { pages: number; text: string }): string | undefined {
	if (file.pages > 3) return undefined;
	const text = file.text.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
	if (text.includes("hosted file") && text.includes("authorea.com")) return "A preprint cover sheet, not the manuscript";
	if (text.includes("more pages are available in the full version")) return "A publisher's preview, not the paper";
	return undefined;
}
