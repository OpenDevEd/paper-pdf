/** The fetch to use on Node. It connects only to addresses on the public internet. */

import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Addresses outside the public internet, from the IANA special-purpose registries: private, loopback, link-local,
 * shared, benchmarking, documentation, reserved, multicast, and their IPv6 counterparts, including deprecated
 * site-local and IPv4 embedded in IPv6.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
	["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	// IPv4 written as IPv6 (::ffff:0:0/96) is not listed: the block list checks every IPv4 address in that form, so
	// listing it would refuse all of them. Such addresses are judged as the IPv4 address they carry instead.
	["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
	["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

/** Whether an address is outside the public internet. An IPv4 address written as IPv6 is judged as that IPv4 address. */
export function isPrivateIp(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return NOT_PUBLIC.check(address, "ipv4");
	if (version !== 6) return true;
	const mapped = mappedIpv4(address);
	return mapped ? NOT_PUBLIC.check(mapped, "ipv4") : NOT_PUBLIC.check(address, "ipv6");
}

/**
 * The IPv4 address carried inside an IPv6 one, written either way ("::ffff:127.0.0.1" or "::ffff:7f00:1"): IPv4-mapped
 * addresses, and the NAT64 prefix 64:ff9b::/96, which a translating network turns back into that IPv4 address.
 */
function mappedIpv4(address: string) {
	const carrier = /^(?:(?:0{0,4}:){0,5}:?ffff|64:ff9b::)/iu.exec(address)?.[0];
	if (!carrier) return undefined;
	const rest = address.slice(carrier.length).replace(/^:/u, "");
	const dotted = /^(\d+\.\d+\.\d+\.\d+)$/u.exec(rest)?.[1];
	if (dotted) return dotted;
	const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(rest);
	if (!hex) return undefined;
	const [high, low] = [Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16)];
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Connects only to addresses its own lookup accepted, so a name cannot resolve to a public address for the check and
 * to a private one for the connection.
 */
const publicOnly = new Agent({
	// Springer Nature's Fastly answers HTTP/1.1 requests from undici with a JavaScript challenge, but not HTTP/2 ones.
	allowH2: true,
	connect: {
		lookup(hostname, options, callback) {
			lookup(hostname, { all: true }, (error, addresses) => {
				if (error) return callback(error, "", 0);
				if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
					return callback(new Error("Private address is not allowed"), "", 0);
				}
				if (options.all) return (callback as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
				callback(null, addresses[0]!.address, addresses[0]!.family);
			});
		},
	},
});

/**
 * `fetch` that refuses a name resolving to a private address, and an address written out that is private. `findPdf`
 * follows redirects itself and checks each one, so every request of a search passes through here.
 */
export const publicFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => {
	const url = new URL(typeof input === "object" && "url" in input ? input.url : input);
	const host = url.hostname.replace(/^\[|\]$/gu, "");
	if (isIP(host) && isPrivateIp(host)) return Promise.reject(new Error("Private address is not allowed"));
	return undiciFetch(input, { ...init, dispatcher: publicOnly });
}) as unknown as typeof fetch;
