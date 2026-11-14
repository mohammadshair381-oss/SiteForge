/**
 * Rate-limit "source" keys derived from the client address returned by
 * `getClientIp` (pure; no I/O, safe anywhere).
 *
 * Trust model (unchanged): the address comes ONLY from the operator-configured
 * `TRUSTED_IP_HEADER` (see lib/rate-limit.ts). Nothing here reads request
 * headers or makes an address more trusted; it only canonicalises what the
 * trusted proxy supplied so that one client cannot appear as many sources.
 *
 * - IPv4 (optionally with `:port`): one source per address, `ipv4:a.b.c.d`.
 *   Octets with leading zeros are rejected (ambiguous octal forms).
 * - IPv6 (optionally `[addr]:port`, zone id stripped): grouped by /64,
 *   `ipv6/64:h:h:h:h`. A single subscriber or host is normally given at least
 *   a /64, so rotating addresses inside it no longer yields new sources.
 * - IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 well-known-prefix
 *   (`64:ff9b::a.b.c.d`) addresses are keyed as the embedded IPv4 address,
 *   so translated IPv4 clients are not collapsed into one shared /64.
 * - `unknown` (no trusted header outside production) stays the shared
 *   `unknown` bucket; anything unparseable maps to ONE shared `unparseable`
 *   bucket, so varying garbage can never mint fresh sources.
 */

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d{1,5})?$/;
const MAX_ADDRESS_LENGTH = 100;

export type RateLimitSource = string;

export function rateLimitSourceKey(raw: string | null | undefined): RateLimitSource {
  if (typeof raw !== "string") return "missing";
  let value = raw.trim();
  if (!value) return "missing";
  if (value.toLowerCase() === "unknown") return "unknown";
  if (value.length > MAX_ADDRESS_LENGTH) return "unparseable";

  const bracketed = BRACKETED_IPV6.exec(value);
  if (bracketed) {
    value = bracketed[1];
  } else {
    const withPort = IPV4_WITH_PORT.exec(value);
    if (withPort) value = withPort[1];
  }

  if (IPV4.test(value)) return `ipv4:${value}`;

  const hextets = parseIPv6(value);
  if (!hextets) return "unparseable";

  const embedded = embeddedIPv4(hextets);
  if (embedded) return `ipv4:${embedded}`;
  return `ipv6/64:${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}`;
}

/** Parses an IPv6 address (with optional zone id / dotted IPv4 tail) into 8 hextets. */
export function parseIPv6(input: string): number[] | null {
  let value = input.toLowerCase();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(":") || !/^[0-9a-f:.]+$/.test(value)) return null;

  // Replace a dotted IPv4 tail ("::ffff:1.2.3.4") with two hextets.
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const split = (part: string) => (part === "" ? [] : part.split(":"));
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  const groups = [...head, ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  let full: string[];
  if (halves.length === 2) {
    if (groups.length > 7) return null; // "::" stands for at least one group
    full = [...head, ...Array<string>(8 - groups.length).fill("0"), ...rest];
  } else {
    if (groups.length !== 8) return null;
    full = groups;
  }
  return full.map((group) => parseInt(group, 16));
}

function embeddedIPv4(h: number[]): string | null {
  const v4 = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4();
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix, RFC 6052)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4();
  return null;
}
