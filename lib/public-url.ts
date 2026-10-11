import ipaddr from "ipaddr.js";

export const MAX_PUBLIC_HTTP_URL_LENGTH = 4_096;

const LOCAL_HOSTNAME_SUFFIXES = [".localhost", ".local", ".home.arpa"];

function hostnameWithoutBrackets(hostname: string) {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped;
}

/**
 * Returns whether an address is safe to expose as an Internet destination.
 *
 * ipaddr.js labels normal public IPv4/IPv6 addresses as `unicast`. We also
 * reject IPv4-compatible/mapped IPv6 forms explicitly: accepting `::/96`
 * makes the effective destination depend on the network stack and has led to
 * SSRF filter bypasses (for example `::7f00:1`).
 */
export function isGloballyRoutableIpAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;

  const parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv4") {
    return parsed.range() === "unicast";
  }

  if (parsed.range() !== "unicast") return false;

  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) return false;

  // IPv6 global unicast is currently allocated from 2000::/3. Requiring that
  // prefix prevents unallocated/reserved high ranges from being treated as
  // Internet destinations merely because the library calls them `unicast`.
  if ((ipv6.parts[0] & 0xe000) !== 0x2000) return false;

  // IPv4-compatible IPv6 addresses use ::/96. Dotted IPv4 input is often
  // canonicalised before it reaches this point, so inspect the numeric words.
  if (ipv6.parts.slice(0, 6).every((part) => part === 0)) return false;

  return true;
}

function isLocalHostname(hostname: string) {
  if (!hostname || !hostname.includes(".")) return true;
  if (hostname === "localhost" || hostname === "local" || hostname === "home.arpa") {
    return true;
  }
  return LOCAL_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Synchronously validates an untrusted literal URL before it is stored or
 * rendered. Hostnames still need DNS validation before server-side fetching;
 * this helper deliberately performs no DNS lookup and is safe in UI code.
 */
export function parsePublicHttpUrl(
  value: string | URL | undefined | null,
): URL | undefined {
  if (value === undefined || value === null) return undefined;

  const serialized = value instanceof URL ? value.href : value;
  if (
    !serialized ||
    serialized.length > MAX_PUBLIC_HTTP_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(serialized)
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(serialized);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;

  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) return undefined;

  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase();
  if (ipaddr.isValid(hostname)) {
    if (!isGloballyRoutableIpAddress(hostname)) return undefined;
  } else if (isLocalHostname(hostname)) {
    return undefined;
  }

  // HTTPS applications commonly use the fragment as a client-side route to a
  // specific offer or application form. It is not sent in the HTTP request,
  // but must survive validation so the browser can open the intended screen.
  if (url.protocol !== "https:") url.hash = "";
  return url;
}

export function safePublicHttpUrl(
  value: string | URL | undefined | null,
): string | undefined {
  return parsePublicHttpUrl(value)?.href;
}
