import { afterEach, expect, test } from "vitest";
import { isPrivateIp, publicFetch } from "./node.ts";
import { pdf, web } from "./testing.ts";

let site: Awaited<ReturnType<typeof web>> | undefined;
afterEach(async () => {
	await site?.close();
	site = undefined;
});

test.each([
	["8.8.8.8", false],
	["2606:4700:4700::1111", false],
	["127.0.0.1", true],
	["10.1.2.3", true],
	["::1", true],
	["fe80::1", true],
	["::ffff:127.0.0.1", true],
	["::ffff:7f00:1", true],
	["64:ff9b::7f00:1", true],
	["::ffff:8.8.8.8", false],
	["not an address", true],
])("%s is private: %s", (address, expected) => {
	expect(isPrivateIp(address)).toBe(expected);
});

test("a server on this machine is not reached, by its address or by a name that resolves to it", async () => {
	site = await web({ "localhost/": pdf() });

	// The server is up and answers a plain fetch, so a refusal below is the guard's and not a closed port.
	expect((await fetch(`http://localhost:${site.port}/`)).status).toBe(404);
	await expect(publicFetch(`http://127.0.0.1:${site.port}/`)).rejects.toThrow("Private address");
	await expect(publicFetch(`http://localhost:${site.port}/`)).rejects.toMatchObject({ cause: { message: "Private address is not allowed" } });
	expect(site.asked).toHaveLength(1);
});
