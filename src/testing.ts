/** A small web for tests: every host's requests land on one local server, so real requests, redirects and streams run. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2_000, "x"), Buffer.from("\n%%EOF\n")]);

export const pdf = (bytes: Buffer = PDF, type = "application/pdf"): Handler => (_request, response) => {
	response.writeHead(200, { "content-type": type, "content-length": bytes.byteLength }).end(bytes);
};

export const page = (html: string, status = 200, headers: Record<string, string> = {}): Handler => (_request, response) => {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(html);
};

export const json = (value: unknown): Handler => (_request, response) => {
	response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
};

export const redirect = (to: string): Handler => (_request, response) => {
	response.writeHead(302, { location: to }).end();
};

export const delayed = (handler: Handler, ms: number): Handler => (request, response) => {
	setTimeout(() => handler(request, response), ms);
};

/** Answers and then sends nothing more. */
export const stall: Handler = (_request, response) => {
	response.writeHead(200, { "content-type": "application/pdf" });
	response.flushHeaders();
};

/** A PDF whose download stopped early, as the Internet Archive sometimes saved one. */
export const cutShort = pdf(PDF.subarray(0, 1_500));

/** Starts a PDF and then sends nothing more. */
export const trickle: Handler = (_request, response) => {
	response.writeHead(200, { "content-type": "application/pdf", "content-length": PDF.byteLength });
	response.write(PDF.subarray(0, 1_500));
};

export const xml = (body: string): Handler => (_request, response) => {
	response.writeHead(200, { "content-type": "application/xml" }).end(body);
};

export const challenge = page("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>", 403);

/** The Internet Archive holding a saved copy of each address, and none of any other. */
export function archive(copies: Record<string, Handler>): Record<string, Handler> {
	const saved = "20240101000000";
	return {
		"archive.org/wayback/available": (request, response) => {
			const asked = new URL(`https://${decodeURIComponent((request.url ?? "/").slice(1))}`).searchParams.get("url") ?? "";
			const closest = { status: "200", available: true, url: `http://web.archive.org/web/${saved}/${asked}`, timestamp: saved };
			json({ url: asked, archived_snapshots: asked in copies ? { closest } : {} })(request, response);
		},
		...Object.fromEntries(Object.entries(copies).map(([address, handler]) => [`web.archive.org/web/${saved}id_/${address}`, handler])),
	};
}

/** Routes are keyed by host and path, such as "publisher.example/paper.pdf". `asked` lists every request in order. */
export async function web(routes: Record<string, Handler>) {
	const asked: string[] = [];
	const server = createServer((request, response) => {
		const key = decodeURIComponent((request.url ?? "/").slice(1));
		asked.push(key);
		const handler = routes[key] ?? routes[key.split("?")[0] ?? ""];
		if (handler) handler(request, response);
		else response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const there = ((input: string | URL, init?: RequestInit) => {
		const url = new URL(input);
		return fetch(`http://127.0.0.1:${port}/${encodeURIComponent(url.host + url.pathname + url.search)}`, init);
	}) as typeof fetch;
	return {
		fetch: there,
		asked,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
