import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import * as cheerio from "cheerio";
import { getDomain } from "tldts";
import { EnvHttpProxyAgent, request as undiciRequest } from "undici";

import { MCO_PROFILE } from "@/lib/mco-profile";
import {
  isGloballyRoutableIpAddress,
  parsePublicHttpUrl,
} from "@/lib/public-url";
import type { OpportunityEvidence, SiteInspection } from "@/lib/types";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;
const DEFAULT_MAX_PAGES = 3;
const MAX_REDIRECTS = 3;
const DEFAULT_USER_AGENT = "JobAroundMeBot/1.0 (+website-inspection)";
const MAX_ROBOTS_PATH_LENGTH = 4_096;
const MAX_ROBOTS_RULES = 256;
const MAX_ROBOTS_PATTERN_LENGTH = 512;
const MAX_TARGET_ROLES = 12;
const MAX_SCANNER_URL_LENGTH = 4_096;
const MAX_JSON_LD_SCRIPTS_PER_PAGE = 32;
const MAX_JSON_LD_NODES_PER_PAGE = 128;
const MAX_JSON_LD_DEPTH = 12;
const MAX_CAREER_LINKS_PER_PAGE = 64;
const MAX_EVIDENCE_PER_PAGE = 32;
const MAX_EVIDENCE_PER_SCAN = 48;
const MAX_EVIDENCE_TITLE_LENGTH = 300;
const MAX_STRUCTURED_TEXT_LENGTH = 20_000;
const MAX_STRUCTURED_ARRAY_ITEMS = 16;

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
  connection?: Readonly<PinnedRequestContext>,
) => Promise<Response>;

export interface PinnedRequestContext {
  /** URL requested by the crawler before its hostname is replaced by an IP. */
  originalUrl: URL;
  /** Public IP selected from the validated DNS response. */
  address: string;
  /** HTTP Host authority preserved from the original URL. */
  hostHeader: string;
  /** TLS identity and SNI name. Undefined when the original host is an IP. */
  servername?: string;
}

interface TransportResponse {
  response: {
    status: number;
    headers: Headers;
    readBody: (limit: number, signal: AbortSignal) => Promise<string>;
    discardBody: () => Promise<void>;
  };
  dispose?: () => Promise<void>;
}

export interface SiteScannerOptions {
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
  userAgent?: string;
  /** Cancels DNS and HTTP work when the parent search is abandoned. */
  signal?: AbortSignal;
  /** Bounded professional concepts extracted from the CV profile. */
  professionalKeywords?: readonly string[];
  /** Bounded job titles explicitly targeted by the CV profile. */
  targetRoles?: readonly string[];
  /**
   * Test hook. `input` is already pinned to the validated numeric address;
   * `connection` exposes the original URL and TLS/Host metadata.
   */
  fetchImpl?: FetchLike;
  /** Test hook returning every address advertised for a hostname. */
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  now?: () => Date;
  /** Formatted address of the nearby establishment used to verify offer locality. */
  expectedLocationText?: string;
  /** Google Places employer name used to reject jobs for another organisation. */
  expectedEmployerName?: string;
}

interface NormalizedScannerOptions {
  timeoutMs: number;
  deadlineAt: number;
  maxResponseBytes: number;
  maxPages: number;
  userAgent: string;
  signal?: AbortSignal;
  professionalKeywords: string[];
  targetRoles: string[];
  fetchImpl?: FetchLike;
  resolveHostname: (hostname: string) => Promise<readonly string[]>;
  now: () => Date;
  expectedLocationText?: string;
  expectedEmployerName?: string;
}

type CrawledSourceKind = "employer-site" | "employer-ats" | "unknown";

interface CrawlCandidate {
  url: URL;
  label: string;
  sourceKind: CrawledSourceKind;
  linkedFromEmployer: boolean;
  recruitmentHub: boolean;
  specificOffer: boolean;
}

interface SafeResponse {
  status: number;
  headers: Headers;
  body: string;
  url: URL;
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface RobotsPolicy {
  rules: RobotsRule[];
  unavailable?: boolean;
}

interface PageAnalysis {
  evidence: OpportunityEvidence[];
  careerLinks: CrawlCandidate[];
  matchedKeywords: string[];
  recruitmentHub: boolean;
}

class UnsafeUrlError extends Error {}
class RequestTimeoutError extends Error {}
class ResponseTooLargeError extends Error {}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeOptions(options: SiteScannerOptions): NormalizedScannerOptions {
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000);
  const totalTimeoutMs = clampInteger(
    options.totalTimeoutMs,
    DEFAULT_TOTAL_TIMEOUT_MS,
    500,
    30_000,
  );
  return {
    timeoutMs,
    deadlineAt: Date.now() + totalTimeoutMs,
    maxResponseBytes: clampInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      4_096,
      2_000_000,
    ),
    maxPages: clampInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 5),
    userAgent: options.userAgent?.trim() || DEFAULT_USER_AGENT,
    signal: options.signal,
    professionalKeywords: normalizeProfessionalKeywords(
      options.professionalKeywords,
    ),
    targetRoles: normalizeTargetRoles(options.targetRoles),
    fetchImpl: options.fetchImpl,
    resolveHostname:
      options.resolveHostname ??
      (async (hostname) => {
        const results = await lookup(hostname, { all: true, verbatim: true });
        return results.map(({ address }) => address);
      }),
    now: options.now ?? (() => new Date()),
    expectedLocationText: options.expectedLocationText?.trim() || undefined,
    expectedEmployerName: options.expectedEmployerName?.trim() || undefined,
  };
}

function requestTimeout(options: NormalizedScannerOptions) {
  options.signal?.throwIfAborted();
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) throw new RequestTimeoutError("L’inspection a expiré.");
  return Math.min(options.timeoutMs, remaining);
}

async function withRequestTimeout<T>(
  operation: Promise<T>,
  options: NormalizedScannerOptions,
  onTimeout?: (reason: RequestTimeoutError) => void,
): Promise<T> {
  const timeoutMs = requestTimeout(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const racers: Promise<T>[] = [
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const reason = new RequestTimeoutError("La requête a expiré.");
          onTimeout?.(reason);
          reject(reason);
        }, timeoutMs);
      }),
    ];
    if (options.signal) {
      racers.push(
        new Promise<never>((_resolve, reject) => {
          abortListener = () =>
            reject(
              options.signal?.reason ??
                new DOMException("Aborted", "AbortError"),
            );
          options.signal?.addEventListener("abort", abortListener, {
            once: true,
          });
          if (options.signal?.aborted) abortListener();
        }),
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
  }
}

function parseHttpUrl(rawUrl: string | URL): URL {
  const url = parsePublicHttpUrl(rawUrl);
  if (!url) throw new UnsafeUrlError("Cette destination réseau n’est pas publique.");
  return url;
}

function hostnameWithoutBrackets(hostname: string) {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped;
}

function isPublicAddress(address: string) {
  return isGloballyRoutableIpAddress(address);
}

function pinnedRequestTarget(url: URL, address: string) {
  const pinnedUrl = new URL(url);
  pinnedUrl.hostname = isIP(address) === 6 ? `[${address}]` : address;
  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase();
  return {
    pinnedUrl,
    connection: {
      originalUrl: new URL(url),
      address,
      hostHeader: url.host,
      ...(isIP(hostname) ? {} : { servername: hostname }),
    } satisfies PinnedRequestContext,
  };
}

interface UndiciBody extends AsyncIterable<unknown> {
  destroy(error?: Error): unknown;
}

async function readUndiciBody(
  body: UndiciBody,
  headers: Headers,
  limit: number,
  signal: AbortSignal,
) {
  const declaredLength = Number(headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    body.destroy();
    throw new ResponseTooLargeError("La réponse dépasse la taille autorisée.");
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const rawChunk of body) {
      if (signal.aborted) throw signal.reason;
      const chunk = typeof rawChunk === "string"
        ? new TextEncoder().encode(rawChunk)
        : rawChunk instanceof Uint8Array
          ? rawChunk
          : undefined;
      if (!chunk) throw new Error("Le site a renvoyé un contenu illisible.");
      size += chunk.byteLength;
      if (size > limit) {
        throw new ResponseTooLargeError("La réponse dépasse la taille autorisée.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    body.destroy(error instanceof Error ? error : undefined);
    throw error;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
) {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item);
    } else if (value !== undefined) {
      normalized.append(name, value);
    }
  }
  return normalized;
}

async function environmentRequest(
  pinnedUrl: URL,
  init: RequestInit,
  connection: Readonly<PinnedRequestContext>,
): Promise<TransportResponse> {
  // The proxy sees the numeric destination, so it cannot perform a second DNS
  // lookup. For HTTPS, requestTls preserves certificate verification and SNI
  // against the original hostname; connect does the same on the direct path.
  const tlsIdentity = connection.servername
    ? { servername: connection.servername }
    : undefined;
  const dispatcher = new EnvHttpProxyAgent({
    connections: 1,
    pipelining: 0,
    proxyTunnel: true,
    ...(tlsIdentity ? { connect: tlsIdentity, requestTls: tlsIdentity } : {}),
  });

  try {
    const requestHeaders = Object.fromEntries(new Headers(init.headers).entries());
    requestHeaders.host = connection.hostHeader;
    const result = await undiciRequest(pinnedUrl, {
      method: "GET",
      headers: requestHeaders,
      signal: init.signal,
      dispatcher,
    });
    const headers = responseHeaders(result.headers);
    return {
      response: {
        status: result.statusCode,
        headers,
        readBody: (limit, signal) =>
          readUndiciBody(result.body, headers, limit, signal),
        discardBody: async () => {
          result.body.destroy();
        },
      },
      dispose: async () => {
        await dispatcher.destroy();
      },
    };
  } catch (error) {
    try {
      await dispatcher.destroy();
    } catch {
      // Preserve the network error, which is more useful than cleanup failure.
    }
    throw error;
  }
}

async function validateAndResolveUrl(
  rawUrl: string | URL,
  options: NormalizedScannerOptions,
) {
  options.signal?.throwIfAborted();
  const url = parseHttpUrl(rawUrl);
  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new UnsafeUrlError("Cette destination réseau n’est pas publique.");
  }

  let addresses: readonly string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await withRequestTimeout(options.resolveHostname(hostname), options);
    } catch {
      throw new Error("Le nom de domaine ne répond pas.");
    }
  }

  if (addresses.length === 0) {
    throw new Error("Le nom de domaine ne fournit aucune adresse.");
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new UnsafeUrlError("Cette destination réseau n’est pas publique.");
  }

  options.signal?.throwIfAborted();
  return { url, address: addresses[0] };
}

function readFetchBody(response: Response, limit: number, signal: AbortSignal) {
  return (async () => {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel();
      throw new ResponseTooLargeError("La réponse dépasse la taille autorisée.");
    }

    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new ResponseTooLargeError("La réponse dépasse la taille autorisée.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  })();
}

async function fetchThroughPinnedTransport(
  url: URL,
  address: string,
  options: NormalizedScannerOptions,
): Promise<SafeResponse> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timeoutMs = requestTimeout(options);
  const timer = setTimeout(
    () => controller.abort(new RequestTimeoutError("La requête a expiré.")),
    timeoutMs,
  );
  const { pinnedUrl, connection } = pinnedRequestTarget(url, address);
  const headers = new Headers({
    Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
    "Accept-Encoding": "identity",
    "User-Agent": options.userAgent,
  });
  headers.set("Host", connection.hostHeader);
  let transportResponse: TransportResponse | undefined;

  try {
    const requestInit: RequestInit = {
      method: "GET",
      redirect: "manual",
      signal,
      headers,
    };
    const request = options.fetchImpl
      ? options.fetchImpl(pinnedUrl, requestInit, connection).then((response) => ({
          response: {
            status: response.status,
            headers: response.headers,
            readBody: (limit: number, signal: AbortSignal) =>
              readFetchBody(response, limit, signal),
            discardBody: async () => {
              await response.body?.cancel();
            },
          },
        }))
      : environmentRequest(pinnedUrl, requestInit, connection);
    const abortTimedOutRequest = (reason: RequestTimeoutError) => {
      controller.abort(reason);
    };
    const completedResponse = await withRequestTimeout(
      request,
      options,
      abortTimedOutRequest,
    );
    transportResponse = completedResponse;
    const { response } = completedResponse;
    let body = "";
    if (isRedirect(response.status)) {
      await response.discardBody();
    } else {
      body = await withRequestTimeout(
        response.readBody(options.maxResponseBytes, signal),
        options,
        abortTimedOutRequest,
      );
    }
    return { status: response.status, headers: response.headers, body, url };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (controller.signal.aborted) {
      throw new RequestTimeoutError("La requête a expiré.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      await transportResponse?.dispose?.();
    } catch {
      // A cleanup failure must not replace the request error or scan result.
    }
  }
}

function isRedirect(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function safeRequest(
  rawUrl: string | URL,
  options: NormalizedScannerOptions,
  beforeRequest?: (url: URL) => Promise<void>,
): Promise<SafeResponse> {
  let currentUrl = parseHttpUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await beforeRequest?.(currentUrl);
    const { url, address } = await validateAndResolveUrl(currentUrl, options);
    const response = await fetchThroughPinnedTransport(url, address, options);

    if (!isRedirect(response.status)) return response;
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error("Le site effectue trop de redirections.");
    }

    const location = response.headers.get("location");
    if (!location) throw new Error("La redirection du site est incomplète.");
    currentUrl = parseHttpUrl(new URL(location, url));
  }

  throw new Error("Le site effectue trop de redirections.");
}

function parseRobotsTxt(contents: string, userAgent: string): RobotsPolicy {
  const groups: Array<{
    agents: string[];
    rules: RobotsRule[];
    limitsExceeded: boolean;
  }> = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let limitsExceeded = false;

  const flush = () => {
    if (agents.length > 0) groups.push({ agents, rules, limitsExceeded });
    agents = [];
    rules = [];
    limitsExceeded = false;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      if (rules.length > 0 || limitsExceeded) flush();
      agents.push(value.toLowerCase());
    } else if ((directive === "allow" || directive === "disallow") && agents.length > 0) {
      if (!value) continue;
      if (
        value.length > MAX_ROBOTS_PATTERN_LENGTH ||
        rules.length >= MAX_ROBOTS_RULES
      ) {
        limitsExceeded = true;
        continue;
      }
      rules.push({ allow: directive === "allow", pattern: value });
    }
  }
  flush();

  const normalizedAgent = userAgent.toLowerCase().split(/[\s/]/, 1)[0];
  const specific = groups.filter(({ agents: groupAgents }) =>
    groupAgents.some((agent) => agent !== "*" && normalizedAgent.includes(agent)),
  );
  const applicable = specific.length > 0
    ? specific
    : groups.filter(({ agents: groupAgents }) => groupAgents.includes("*"));

  const applicableRuleCount = applicable.reduce(
    (count, group) => count + group.rules.length,
    0,
  );
  if (
    applicable.some((group) => group.limitsExceeded) ||
    applicableRuleCount > MAX_ROBOTS_RULES
  ) {
    return { rules: [], unavailable: true };
  }

  return { rules: applicable.flatMap((group) => group.rules) };
}

function buildKmpPrefixTable(needle: string) {
  const prefix = new Uint16Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length;) {
    if (needle[index] === needle[matched]) {
      prefix[index] = matched + 1;
      index += 1;
      matched += 1;
    } else if (matched > 0) {
      matched = prefix[matched - 1];
    } else {
      index += 1;
    }
  }
  return prefix;
}

/** Finds a literal without rescanning the already-consumed part of the path. */
function findLiteral(
  path: string,
  literal: string,
  from: number,
  endExclusive: number,
) {
  if (!literal) return from;
  const prefix = buildKmpPrefixTable(literal);
  let matched = 0;
  for (let index = from; index < endExclusive; index += 1) {
    while (matched > 0 && path[index] !== literal[matched]) {
      matched = prefix[matched - 1];
    }
    if (path[index] === literal[matched]) matched += 1;
    if (matched === literal.length) return index - literal.length + 1;
  }
  return -1;
}

function robotsPatternMatches(path: string, pattern: string) {
  const anchoredAtEnd = pattern.endsWith("$");
  const rawPattern = anchoredAtEnd ? pattern.slice(0, -1) : pattern;
  const startsWithWildcard = rawPattern.startsWith("*");
  const endsWithWildcard = rawPattern.endsWith("*");
  const literals = rawPattern.split("*").filter(Boolean);

  if (literals.length === 0) {
    return !anchoredAtEnd || endsWithWildcard || path.length === 0;
  }

  let literalIndex = 0;
  let cursor = 0;
  if (!startsWithWildcard) {
    const first = literals[0];
    if (!path.startsWith(first)) return false;
    cursor = first.length;
    literalIndex = 1;
  }

  const hasFixedEnding = anchoredAtEnd && !endsWithWildcard;
  const lastLiteralIndex = literals.length - 1;
  if (hasFixedEnding && !startsWithWildcard && literals.length === 1) {
    return cursor === path.length;
  }
  const searchUntil = hasFixedEnding
    ? path.length - literals[lastLiteralIndex].length
    : path.length;

  if (searchUntil < cursor) return false;
  for (
    ;
    literalIndex < literals.length - (hasFixedEnding ? 1 : 0);
    literalIndex += 1
  ) {
    const literal = literals[literalIndex];
    const matchAt = findLiteral(path, literal, cursor, searchUntil);
    if (matchAt < 0) return false;
    cursor = matchAt + literal.length;
  }

  if (!hasFixedEnding) return true;
  const lastLiteral = literals[lastLiteralIndex];
  const lastLiteralStart = path.length - lastLiteral.length;
  return cursor <= lastLiteralStart && path.startsWith(lastLiteral, lastLiteralStart);
}

function isAllowedByRobots(url: URL, policy: RobotsPolicy) {
  if (policy.unavailable) return false;
  const path = `${url.pathname}${url.search}` || "/";
  if (path.length > MAX_ROBOTS_PATH_LENGTH) return false;

  let winningRule: RobotsRule | undefined;
  let winningSpecificity = -1;
  for (const rule of policy.rules) {
    if (!robotsPatternMatches(path, rule.pattern)) continue;
    const specificity = rule.pattern.replace(/[*$]/g, "").length;
    if (
      specificity > winningSpecificity ||
      (specificity === winningSpecificity && rule.allow && !winningRule?.allow)
    ) {
      winningRule = rule;
      winningSpecificity = specificity;
    }
  }
  return winningRule?.allow ?? true;
}

async function loadRobotsPolicy(
  pageUrl: URL,
  options: NormalizedScannerOptions,
): Promise<RobotsPolicy> {
  const robotsUrl = new URL("/robots.txt", pageUrl.origin);
  try {
    const response = await safeRequest(robotsUrl, options);
    if (response.status === 401 || response.status === 403 || response.status >= 500) {
      return { rules: [], unavailable: true };
    }
    if (response.status < 200 || response.status >= 300) return { rules: [] };
    return parseRobotsTxt(response.body, options.userAgent);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (error instanceof UnsafeUrlError) throw error;
    if (error instanceof RequestTimeoutError) throw error;
    return { rules: [], unavailable: true };
  }
}

function normalizeText(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const GENERIC_PROFESSIONAL_KEYWORDS = new Set([
  "alternance",
  "apprentissage",
  "apprenti",
  "apprentie",
  "candidat",
  "candidate",
  "contrat",
  "emploi",
  "job",
  "recrutement",
  "stage",
]);

const BROAD_PROFESSIONAL_KEYWORDS = new Set([
  "commerce",
  "commerce de detail",
  "commercial",
  "commerciale",
  "distribution",
  "grande distribution",
  "retail",
  "vente",
]);

function normalizeProfessionalKeywords(
  values: readonly string[] | undefined,
): string[] {
  const unique = new Map<string, string>();
  for (const rawValue of values ?? []) {
    const value = rawValue.replace(/\s+/g, " ").trim().slice(0, 120);
    const normalized = normalizeText(value);
    if (
      normalized.length < 3 ||
      GENERIC_PROFESSIONAL_KEYWORDS.has(normalized) ||
      BROAD_PROFESSIONAL_KEYWORDS.has(normalized) ||
      unique.has(normalized)
    ) {
      continue;
    }
    unique.set(normalized, value);
    if (unique.size >= 40) break;
  }
  return [...unique.values()];
}

function normalizeTargetRoles(values: readonly string[] | undefined): string[] {
  const unique = new Map<string, string>();
  for (const rawValue of values ?? []) {
    const value = rawValue.replace(/\s+/g, " ").trim().slice(0, 120);
    const normalized = normalizeText(value);
    if (
      normalized.length < 4 ||
      GENERIC_PROFESSIONAL_KEYWORDS.has(normalized) ||
      BROAD_PROFESSIONAL_KEYWORDS.has(normalized) ||
      unique.has(normalized)
    ) {
      continue;
    }
    unique.set(normalized, value);
    if (unique.size >= MAX_TARGET_ROLES) break;
  }
  return [...unique.values()];
}

function hasApprenticeshipSignal(text: string) {
  const normalized = normalizeText(text);
  return MCO_PROFILE.apprenticeshipKeywords.some((keyword) =>
    normalized.includes(normalizeText(keyword)),
  );
}

const STRONG_MCO_TITLE_SIGNALS = [
  ...MCO_PROFILE.roleKeywords,
  "chef de rayon",
  "responsable de rayon",
  "vendeur",
  "vendeuse",
];

const PRECISE_MCO_DESCRIPTION_SIGNALS = [
  ...MCO_PROFILE.roleKeywords,
  ...MCO_PROFILE.competencyGroups.flatMap(({ keywords }) => keywords),
  "encaissement",
  "gestion de caisse",
  "manager de rayon",
  "vendeur",
  "vendeuse",
];

function signalText(text: string) {
  return normalizeText(text)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsSignal(text: string, signal: string) {
  const normalizedText = signalText(text);
  const normalizedSignal = signalText(signal);
  return Boolean(
    normalizedSignal &&
      ` ${normalizedText} `.includes(` ${normalizedSignal} `),
  );
}

function hasStrongRoleSignal(
  title: string,
  targetRoles: readonly string[],
) {
  return [...STRONG_MCO_TITLE_SIGNALS, ...targetRoles].some((signal) =>
    containsSignal(title, signal),
  );
}

function preciseDescriptionSignalCount(
  description: string,
  professionalKeywords: readonly string[],
  targetRoles: readonly string[],
) {
  const matchingSignals = new Set<string>();
  for (const signal of [
    ...PRECISE_MCO_DESCRIPTION_SIGNALS,
    ...professionalKeywords,
    ...targetRoles,
  ]) {
    const normalized = signalText(signal);
    if (
      normalized &&
      !BROAD_PROFESSIONAL_KEYWORDS.has(normalized) &&
      containsSignal(description, normalized)
    ) {
      matchingSignals.add(normalized);
    }
  }
  const longestFirst = [...matchingSignals].sort(
    (left, right) => right.length - left.length,
  );
  const independentSignals: string[] = [];
  for (const signal of longestFirst) {
    if (
      independentSignals.some((longerSignal) =>
        containsSignal(longerSignal, signal),
      )
    ) {
      continue;
    }
    independentSignals.push(signal);
  }
  return independentSignals.length;
}

function isRelevantApprenticeship(
  title: string,
  description: string,
  employmentType: string,
  professionalKeywords: readonly string[],
  targetRoles: readonly string[],
) {
  return (
    hasApprenticeshipSignal(`${title} ${description} ${employmentType}`) &&
    (hasStrongRoleSignal(title, targetRoles) ||
      preciseDescriptionSignalCount(
        description,
        professionalKeywords,
        targetRoles,
      ) >= 2)
  );
}

const ALL_MCO_KEYWORDS = Array.from(
  new Set([
    ...MCO_PROFILE.roleKeywords,
    ...MCO_PROFILE.apprenticeshipKeywords,
    ...MCO_PROFILE.recruitmentKeywords,
    ...MCO_PROFILE.competencyGroups.flatMap(({ keywords }) => keywords),
  ]),
);

function keywordMatches(
  text: string,
  professionalKeywords: readonly string[],
  targetRoles: readonly string[],
) {
  const normalized = normalizeText(text);
  return [
    ...new Set([
      ...ALL_MCO_KEYWORDS,
      ...professionalKeywords,
      ...targetRoles,
    ]),
  ].filter((keyword) => normalized.includes(normalizeText(keyword)));
}

function plainText(
  value: unknown,
  maxLength = MAX_STRUCTURED_TEXT_LENGTH,
) {
  if (typeof value !== "string") return "";
  const bounded = value.slice(0, maxLength);
  return cheerio
    .load(`<div>${bounded}</div>`)("div")
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function optionalPlainText(value: unknown, maxLength = 500) {
  const text = plainText(value, maxLength);
  return text || undefined;
}

function jobLocationTexts(value: unknown): string[] {
  const locations = (Array.isArray(value) ? value : [value]).slice(
    0,
    MAX_STRUCTURED_ARRAY_ITEMS,
  );
  return locations.flatMap((location) => {
    if (!location || typeof location !== "object") return [];
    const object = location as Record<string, unknown>;
    const address =
      object.address && typeof object.address === "object"
        ? (object.address as Record<string, unknown>)
        : object;
    const parts = [
      optionalPlainText(address.streetAddress),
      optionalPlainText(address.postalCode),
      optionalPlainText(address.addressLocality),
      optionalPlainText(address.addressRegion),
    ].filter((part): part is string => Boolean(part));
    return parts.length ? [parts.join(" ")] : [];
  });
}

type OfferFreshness = "active" | "unknown" | "stale" | "expired" | "invalid";

interface ParsedOfferDate {
  timestamp: number;
  dateOnly?: string;
}

function parseOfferDate(value: string | undefined): ParsedOfferDate | undefined | null {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return { timestamp: date.getTime(), dateOnly: value };
  }

  // Datetimes without an explicit timezone are ambiguous and must not certify freshness.
  if (!/T/i.test(value) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? { timestamp } : null;
}

function parisCalendarDate(now: Date) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function assessFreshness(
  publishedAt: string | undefined,
  validThrough: string | undefined,
  now: Date,
): OfferFreshness {
  const published = parseOfferDate(publishedAt);
  const validity = parseOfferDate(validThrough);
  if (published === null || validity === null) return "invalid";

  if (published && published.timestamp > now.getTime() + 2 * 86_400_000) {
    return "invalid";
  }
  if (published && validity && validity.timestamp < published.timestamp) {
    return "invalid";
  }
  if (validity) {
    const expired = validity.dateOnly
      ? validity.dateOnly < parisCalendarDate(now)
      : validity.timestamp < now.getTime();
    return expired ? "expired" : "active";
  }
  if (!published) return "unknown";

  const ageDays = (now.getTime() - published.timestamp) / 86_400_000;
  if (ageDays <= 60) return "active";
  if (ageDays <= 120) return "unknown";
  return "stale";
}

const LOCATION_STOP_WORDS = new Set([
  "a",
  "au",
  "aux",
  "av",
  "avenue",
  "bd",
  "boulevard",
  "centre",
  "chemin",
  "commercial",
  "cours",
  "d",
  "de",
  "des",
  "du",
  "impasse",
  "l",
  "la",
  "le",
  "les",
  "magasin",
  "marechal",
  "general",
  "docteur",
  "allee",
  "passage",
  "place",
  "quai",
  "rue",
  "route",
  "saint",
  "sainte",
  "zone",
]);

interface ComparableLocation {
  complete: boolean;
  postcodes: Set<string>;
  streetNumbers: Set<string>;
  streetTokens: Set<string>;
}

function comparableLocation(text: string): ComparableLocation {
  const normalized = signalText(text);
  const postcodeMatch = /\b\d{5}\b/.exec(normalized);
  const postcodes = new Set(normalized.match(/\b\d{5}\b/g) ?? []);
  const streetPart = postcodeMatch
    ? normalized.slice(0, postcodeMatch.index).trim()
    : "";
  const streetNumbers = new Set(
    [
      ...streetPart.matchAll(
        /\b(\d{1,4})(?:\s*(bis|ter|quater|[a-z]))?\b/g,
      ),
    ].map((match) => `${match[1]}${match[2] ?? ""}`),
  );
  const streetTokens = new Set(
    streetPart
      .split(" ")
      .filter(
        (token) =>
          token.length >= 3 &&
          !/^\d+(?:bis|ter|quater|[a-z])?$/.test(token) &&
          !/^(?:bis|ter|quater)$/.test(token) &&
          !LOCATION_STOP_WORDS.has(token),
      ),
  );
  return {
    complete:
      postcodes.size > 0 &&
      streetNumbers.size > 0 &&
      streetTokens.size > 0,
    postcodes,
    streetNumbers,
    streetTokens,
  };
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return [...left].some((value) => right.has(value));
}

function streetTokensMatch(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
) {
  const sharedCount = [...left].filter((value) => right.has(value)).length;
  return (
    sharedCount > 0 &&
    (left.size === 1 || right.size === 1 || sharedCount >= 2)
  );
}

function locationMatches(
  offerLocations: readonly string[],
  expectedLocation: string | undefined,
): boolean | undefined {
  if (offerLocations.length === 0 || !expectedLocation) return undefined;
  const expected = comparableLocation(expectedLocation);
  if (!expected.complete) return undefined;
  let comparedCompleteLocation = false;
  let sawPartialLocation = false;

  for (const offerLocation of offerLocations) {
    const offer = comparableLocation(offerLocation);
    if (!offer.complete) {
      sawPartialLocation = true;
      continue;
    }
    comparedCompleteLocation = true;
    if (
      setsOverlap(offer.postcodes, expected.postcodes) &&
      setsOverlap(offer.streetNumbers, expected.streetNumbers) &&
      streetTokensMatch(offer.streetTokens, expected.streetTokens)
    ) {
      return true;
    }
  }

  return comparedCompleteLocation && !sawPartialLocation ? false : undefined;
}

const COMPANY_NAME_STOP_WORDS = new Set([
  "sa",
  "sas",
  "sasu",
  "sarl",
  "eurl",
  "groupe",
  "group",
  "france",
  "magasin",
  "boutique",
  "societe",
]);

function companyNameTokens(value: string) {
  return normalizeText(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !COMPANY_NAME_STOP_WORDS.has(token));
}

function hiringOrganizationNames(value: unknown): string[] {
  const organisations = (Array.isArray(value) ? value : [value]).slice(
    0,
    MAX_STRUCTURED_ARRAY_ITEMS,
  );
  return organisations.flatMap((organisation) => {
    if (typeof organisation === "string") {
      const name = optionalPlainText(organisation, MAX_EVIDENCE_TITLE_LENGTH);
      return name ? [name] : [];
    }
    if (!organisation || typeof organisation !== "object") return [];
    const object = organisation as Record<string, unknown>;
    const names = [
      optionalPlainText(object.name, MAX_EVIDENCE_TITLE_LENGTH),
      optionalPlainText(object.legalName, MAX_EVIDENCE_TITLE_LENGTH),
    ]
      .filter((name): name is string => Boolean(name));
    return names;
  });
}

function employerNameMatches(
  hiringNames: readonly string[],
  expectedEmployerName: string | undefined,
): boolean | undefined {
  if (hiringNames.length === 0 || !expectedEmployerName) return undefined;
  const expected = new Set(companyNameTokens(expectedEmployerName));
  if (expected.size === 0) return undefined;

  return hiringNames.some((name) => {
    const actual = new Set(companyNameTokens(name));
    if (actual.size === 0) return false;
    const smaller = actual.size <= expected.size ? actual : expected;
    const larger = actual.size <= expected.size ? expected : actual;
    const shared = [...smaller].filter((token) => larger.has(token));
    return shared.length === smaller.size || shared.length >= 2;
  });
}

const ATS_DOMAINS = [
  "flatchr.io",
  "greenhouse.io",
  "jobs.lever.co",
  "myworkdayjobs.com",
  "recruitee.com",
  "smartrecruiters.com",
  "successfactors.com",
  "successfactors.eu",
  "taleo.net",
  "teamtailor.com",
  "welcomekit.co",
];

const THIRD_PARTY_JOB_DOMAINS = [
  ...ATS_DOMAINS,
  "hellowork.com",
  "indeed.com",
  "indeed.fr",
  "labonnealternance.apprentissage.beta.gouv.fr",
  "linkedin.com",
  "welcometothejungle.com",
];

function hostnameMatchesDomain(hostname: string, domains: readonly string[]) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isKnownAts(hostname: string) {
  return hostnameMatchesDomain(hostname, ATS_DOMAINS);
}

function sameRegisteredDomain(left: URL, right: URL) {
  const leftDomain = getDomain(left.hostname, { allowPrivateDomains: true });
  const rightDomain = getDomain(right.hostname, { allowPrivateDomains: true });
  return Boolean(leftDomain && rightDomain && leftDomain === rightDomain);
}

function structuredJobUrl(
  value: unknown,
  pageUrl: URL,
  employerUrl: URL,
): { url: URL; trusted: boolean; externalAts: boolean } {
  if (value === undefined || value === null) {
    return { url: pageUrl, trusted: true, externalAts: false };
  }
  if (typeof value !== "string") {
    return { url: pageUrl, trusted: false, externalAts: false };
  }

  let url: URL;
  try {
    url = parseHttpUrl(new URL(value, pageUrl));
  } catch {
    return { url: pageUrl, trusted: false, externalAts: false };
  }

  if (
    sameRegisteredDomain(url, pageUrl) ||
    sameRegisteredDomain(url, employerUrl)
  ) {
    return { url, trusted: true, externalAts: false };
  }

  // A structured offer may legitimately live on the employer's hosted ATS.
  // Restrict that exception to a small suffix allowlist and HTTPS; arbitrary
  // third-party URLs fall back to the page that was actually inspected.
  if (url.protocol === "https:" && isKnownAts(url.hostname)) {
    return { url, trusted: true, externalAts: true };
  }

  return { url: pageUrl, trusted: false, externalAts: false };
}

function classifyCrawlTarget(
  url: URL,
  employerUrl: URL,
  linkedFromEmployer: boolean,
): Pick<CrawlCandidate, "sourceKind" | "linkedFromEmployer"> {
  if (hostnameMatchesDomain(url.hostname, THIRD_PARTY_JOB_DOMAINS)) {
    if (isKnownAts(url.hostname) && linkedFromEmployer) {
      return { sourceKind: "employer-ats", linkedFromEmployer: true };
    }
    return { sourceKind: "unknown", linkedFromEmployer: false };
  }
  if (sameRegisteredDomain(url, employerUrl)) {
    return { sourceKind: "employer-site", linkedFromEmployer: true };
  }
  return { sourceKind: "unknown", linkedFromEmployer: false };
}

interface JsonLdTraversalBudget {
  remainingNodes: number;
}

/**
 * Traverses only JSON-LD arrays and @graph containers, with a shared per-page
 * node budget. The iterative walk also prevents a hostile graph from exhausting
 * the JavaScript call stack.
 */
function flattenJsonLd(
  value: unknown,
  budget: JsonLdTraversalBudget,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];

  while (pending.length > 0 && budget.remainingNodes > 0) {
    const current = pending.pop()!;
    budget.remainingNodes -= 1;
    if (current.depth > MAX_JSON_LD_DEPTH) continue;

    if (Array.isArray(current.value)) {
      const availableSlots = Math.max(
        0,
        budget.remainingNodes - pending.length,
      );
      const itemCount = Math.min(
        current.value.length,
        availableSlots,
      );
      for (let index = itemCount - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;

    const object = current.value as Record<string, unknown>;
    records.push(object);
    if ("@graph" in object && current.depth < MAX_JSON_LD_DEPTH) {
      pending.push({ value: object["@graph"], depth: current.depth + 1 });
    }
  }

  return records;
}

function hasJsonLdType(value: unknown, expected: string) {
  const types = (Array.isArray(value) ? value : [value]).slice(
    0,
    MAX_STRUCTURED_ARRAY_ITEMS,
  );
  return types.some((type) => typeof type === "string" && normalizeText(type) === expected);
}

function truncate(text: string, maxLength = 220) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

const GENERIC_RECRUITMENT_LABELS = new Set([
  "carriere",
  "carrieres",
  "career",
  "careers",
  "emploi",
  "emplois",
  "espace recrutement",
  "job",
  "jobs",
  "join us",
  "nos offres",
  "nous rejoindre",
  "recrutement",
  "toutes les offres",
  "voir les offres",
]);

const RECRUITMENT_ROUTE_SEGMENTS = new Set([
  "career",
  "careers",
  "carriere",
  "carrieres",
  "emploi",
  "emplois",
  "job",
  "jobs",
  "offre",
  "offres",
  "position",
  "positions",
  "recrutement",
  "join us",
  "nous rejoindre",
  "vacancies",
  "vacancy",
]);

const RECRUITMENT_HUB_TAILS = new Set([
  "all",
  "liste",
  "list",
  "recherche",
  "search",
  "tous",
  "toutes",
]);

function recruitmentRoute(url: URL) {
  const segments = url.pathname
    .split("/")
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
  const routeIndex = segments.findIndex((segment) =>
    RECRUITMENT_ROUTE_SEGMENTS.has(segment),
  );
  if (routeIndex < 0) return { hub: false, individual: false };

  const individualQuery = [
    "gh_jid",
    "id",
    "job",
    "job_id",
    "jobid",
    "offer",
    "offre",
    "position",
  ].some((name) => url.searchParams.has(name));
  if (individualQuery) return { hub: false, individual: true };

  const tail = segments.slice(routeIndex + 1);
  if (tail.length === 0 || tail.every((segment) => RECRUITMENT_HUB_TAILS.has(segment))) {
    return { hub: true, individual: false };
  }
  return { hub: false, individual: true };
}

function isRecruitmentHub(label: string, url: URL) {
  const route = recruitmentRoute(url);
  if (route.individual) return false;
  return route.hub || GENERIC_RECRUITMENT_LABELS.has(normalizeText(label));
}

function isCareerLink(label: string, url: URL) {
  const haystack = normalizeText(`${label} ${url.pathname} ${url.search}`);
  return [
    "carriere",
    "career",
    "recrut",
    "nous rejoindre",
    "nous-rejoindre",
    "join us",
    "join-us",
    "nos offres",
    "nos-offres",
    "emploi",
    "jobs",
    "alternance",
  ].some((keyword) => haystack.includes(keyword));
}

function looksLikeSpecificOffer(
  url: URL,
  label: string,
  professionalKeywords: readonly string[],
  targetRoles: readonly string[],
) {
  const normalizedLabel = normalizeText(label);
  if (GENERIC_RECRUITMENT_LABELS.has(normalizedLabel) || normalizedLabel.length < 8) {
    return false;
  }

  const path = normalizeText(`${url.pathname} ${url.search}`);
  const offerRoute = /(?:^|[ /_-])(job|jobs|offre|offres|emploi|position|vacanc|recrut)(?:[ /_?&=-]|$)/.test(
    path,
  );
  return (
    offerRoute &&
    isRelevantApprenticeship(
      normalizedLabel,
      "",
      "",
      professionalKeywords,
      targetRoles,
    )
  );
}

function dedupeEvidence(evidence: OpportunityEvidence[]) {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.level}:${item.url}:${normalizeText(item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidencePriority(evidence: OpportunityEvidence) {
  const level =
    evidence.level === "public-offer"
      ? 3
      : evidence.level === "recruitment-page"
        ? 2
        : 1;
  const direct = evidence.directEmployer ? 1 : 0;
  return level * 100 + direct * 10 + evidence.confidence;
}

function pushEvidenceBounded(
  items: OpportunityEvidence[],
  item: OpportunityEvidence,
  limit: number,
) {
  if (items.length < limit) {
    items.push(item);
    return;
  }

  let lowestIndex = 0;
  for (let index = 1; index < items.length; index += 1) {
    if (evidencePriority(items[index]) < evidencePriority(items[lowestIndex])) {
      lowestIndex = index;
    }
  }
  if (evidencePriority(item) > evidencePriority(items[lowestIndex])) {
    items[lowestIndex] = item;
  }
}

function appendEvidenceBounded(
  items: OpportunityEvidence[],
  additions: readonly OpportunityEvidence[],
  limit: number,
) {
  for (const item of additions) pushEvidenceBounded(items, item, limit);
}

async function keepOnlyPublicEvidenceDestinations(
  items: readonly OpportunityEvidence[],
  inspectedPageUrl: URL,
  options: NormalizedScannerOptions,
  publicHostnames: Map<string, Promise<boolean>>,
): Promise<OpportunityEvidence[]> {
  const checked: OpportunityEvidence[] = [];

  for (const item of items) {
    let destination: URL;
    let literalSafe = true;
    try {
      destination = parseHttpUrl(item.url);
    } catch {
      destination = inspectedPageUrl;
      literalSafe = false;
    }

    const hostname = hostnameWithoutBrackets(destination.hostname).toLowerCase();
    let isPublic = publicHostnames.get(hostname);
    if (!isPublic) {
      isPublic = (async () => {
        try {
          await validateAndResolveUrl(destination, options);
          return true;
        } catch {
          if (options.signal?.aborted) {
            throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          return false;
        }
      })();
      publicHostnames.set(hostname, isPublic);
    }

    if (literalSafe && await isPublic) {
      checked.push({ ...item, url: destination.href });
      continue;
    }

    checked.push({
      ...item,
      level: "prospecting",
      url: inspectedPageUrl.href,
      excerpt:
        "Annonce repérée, mais sa destination n’a pas pu être confirmée comme publique.",
      confidence: Math.min(item.confidence, 0.45),
      directEmployer: false,
    });
  }

  return checked;
}

function analyzeHtml(
  html: string,
  pageUrl: URL,
  now: Date,
  employerUrl: URL,
  sourceKind: CrawledSourceKind,
  linkedFromEmployer: boolean,
  professionalKeywords: readonly string[],
  targetRoles: readonly string[],
  expectedLocationText?: string,
  expectedEmployerName?: string,
): PageAnalysis {
  const $ = cheerio.load(html);
  const evidence: OpportunityEvidence[] = [];
  const careerLinks: CrawlCandidate[] = [];
  const sourceKeywordText: string[] = [];
  const jsonLdBudget: JsonLdTraversalBudget = {
    remainingNodes: MAX_JSON_LD_NODES_PER_PAGE,
  };

  $("script[type='application/ld+json']").each((index, element) => {
    if (
      index >= MAX_JSON_LD_SCRIPTS_PER_PAGE ||
      jsonLdBudget.remainingNodes <= 0 ||
      evidence.length >= MAX_EVIDENCE_PER_PAGE
    ) {
      return false;
    }
    const contents = $(element).text().trim();
    if (!contents) return;
    try {
      const values = flattenJsonLd(JSON.parse(contents), jsonLdBudget);
      for (const value of values) {
        if (evidence.length >= MAX_EVIDENCE_PER_PAGE) break;
        if (!hasJsonLdType(value["@type"], "jobposting")) continue;
        const title =
          plainText(value.title, MAX_EVIDENCE_TITLE_LENGTH) ||
          "Offre d’emploi publiée";
        const description = plainText(
          value.description,
          MAX_STRUCTURED_TEXT_LENGTH,
        );
        const employmentType = Array.isArray(value.employmentType)
          ? value.employmentType
              .slice(0, MAX_STRUCTURED_ARRAY_ITEMS)
              .map((item) => plainText(item, 200))
              .join(" ")
          : plainText(value.employmentType, 200);
        const publishedAt = optionalPlainText(value.datePosted, 100);
        const validThrough = optionalPlainText(value.validThrough, 100);
        const locationTexts = jobLocationTexts(value.jobLocation);
        const locationText = locationTexts.length
          ? truncate([...new Set(locationTexts)].join(" · "), 500)
          : undefined;
        const freshness = assessFreshness(publishedAt, validThrough, now);
        const contractAndRoleMatch = isRelevantApprenticeship(
          title,
          description,
          employmentType,
          professionalKeywords,
          targetRoles,
        );
        const localMatch = locationMatches(locationTexts, expectedLocationText);
        const hiringNames = hiringOrganizationNames(value.hiringOrganization);
        const hiringEmployerMatch = employerNameMatches(
          hiringNames,
          expectedEmployerName,
        );
        const sourceConfirmsEmployer = sourceKind === "employer-site"
          ? hiringEmployerMatch !== false
          : sourceKind === "employer-ats" &&
            linkedFromEmployer &&
            hiringEmployerMatch === true;
        const evidenceDestination = structuredJobUrl(
          value.url,
          pageUrl,
          employerUrl,
        );
        const destinationConfirmsEmployer =
          evidenceDestination.trusted &&
          (!evidenceDestination.externalAts || hiringEmployerMatch === true);
        const relevantApprenticeship =
          freshness === "active" &&
          contractAndRoleMatch &&
          localMatch === true &&
          sourceConfirmsEmployer &&
          destinationConfirmsEmployer;
        if (relevantApprenticeship) {
          sourceKeywordText.push(title, description, employmentType);
        }
        pushEvidenceBounded(evidence, {
          level: relevantApprenticeship ? "public-offer" : "prospecting",
          title,
          url: evidenceDestination.url.href,
          excerpt: relevantApprenticeship
            ? truncate(
                description ||
                  `Offre d’alternance « ${title} » publiée sur le site.`,
              )
            : freshness === "expired" || freshness === "stale"
              ? "Annonce structurée repérée, mais sa date de validité est dépassée."
              : freshness === "invalid"
                ? "Annonce structurée repérée, mais ses dates sont incohérentes ou non vérifiables."
              : !contractAndRoleMatch
                ? "Annonce publique repérée, sans confirmation qu’il s’agit d’une alternance compatible avec le profil recherché."
                : freshness === "unknown"
                  ? "Alternance compatible repérée, mais aucune date ne permet de confirmer qu’elle est encore active."
                  : hiringEmployerMatch === false
                    ? "Alternance compatible repérée, mais l’employeur publié ne correspond pas à cet établissement."
                    : !sourceConfirmsEmployer
                      ? "Alternance compatible repérée sur un site tiers, sans identité employeur suffisamment vérifiée."
                    : !evidenceDestination.trusted
                      ? "Alternance compatible repérée, mais son lien externe n’appartient ni au site inspecté ni à un ATS reconnu."
                    : evidenceDestination.externalAts && hiringEmployerMatch !== true
                      ? "Alternance compatible repérée sur un ATS, mais l’identité de l’employeur n’y est pas confirmée."
                  : localMatch === false
                    ? "Alternance compatible repérée, mais le lieu publié ne correspond pas à cet établissement."
                    : "Alternance compatible repérée, mais son lieu de travail local n’est pas confirmé.",
          confidence: relevantApprenticeship ? 0.98 : 0.52,
          sourceKind,
          directEmployer:
            sourceConfirmsEmployer && destinationConfirmsEmployer,
          specificity: contractAndRoleMatch ? "specific" : "generic",
          ...(publishedAt ? { publishedAt } : {}),
          ...(validThrough ? { validThrough } : {}),
          ...(locationText ? { locationText } : {}),
        }, MAX_EVIDENCE_PER_PAGE);
      }
    } catch {
      // Invalid JSON-LD is common and must not make the whole inspection fail.
    }
  });

  $("a[href]").each((_index, element) => {
    if (careerLinks.length >= MAX_CAREER_LINKS_PER_PAGE) return false;
    const href = $(element).attr("href");
    if (!href || href.length > MAX_SCANNER_URL_LENGTH) return;
    let linkUrl: URL;
    try {
      linkUrl = parseHttpUrl(new URL(href, pageUrl));
    } catch {
      return;
    }
    const label =
      truncate($(element).text() || linkUrl.pathname, MAX_EVIDENCE_TITLE_LENGTH) ||
      "Lien de recrutement";
    if (!isCareerLink(label, linkUrl)) return;
    const linkSource = classifyCrawlTarget(
      linkUrl,
      employerUrl,
      linkedFromEmployer && sourceKind !== "unknown",
    );
    careerLinks.push({
      url: linkUrl,
      label,
      ...linkSource,
      recruitmentHub: isRecruitmentHub(label, linkUrl),
      specificOffer: looksLikeSpecificOffer(
        linkUrl,
        label,
        professionalKeywords,
        targetRoles,
      ),
    });
  });

  const pageTitle = truncate(
    $("title").first().text() || $("h1").first().text(),
    MAX_EVIDENCE_TITLE_LENGTH,
  );
  const bodyText = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STRUCTURED_TEXT_LENGTH);
  const currentPageLabel = `${pageTitle} ${pageUrl.pathname}`;
  const recruitmentHub = isRecruitmentHub(currentPageLabel, pageUrl);
  if (recruitmentHub) {
    pushEvidenceBounded(evidence, {
      level: "recruitment-page",
      title: pageTitle || "Espace recrutement",
      url: pageUrl.href,
      excerpt: truncate(bodyText || "Page de recrutement identifiée sur le site."),
      confidence: 0.78,
      sourceKind,
      directEmployer: sourceKind !== "unknown" && linkedFromEmployer,
      specificity: "generic",
    }, MAX_EVIDENCE_PER_PAGE);
  }

  return {
    evidence: dedupeEvidence(evidence),
    careerLinks: Array.from(
      new Map(careerLinks.map((link) => [link.url.href, link])).values(),
    ),
    matchedKeywords: keywordMatches(
      `${pageTitle} ${bodyText} ${sourceKeywordText.join(" ")}`,
      professionalKeywords,
      targetRoles,
    ),
    recruitmentHub,
  };
}

function recruitmentEvidenceFromLink(link: CrawlCandidate): OpportunityEvidence {
  return {
    level: link.recruitmentHub ? "recruitment-page" : "prospecting",
    title: link.label || "Espace recrutement",
    url: link.url.href,
    excerpt: link.recruitmentHub
      ? link.sourceKind === "unknown"
        ? "Espace recrutement externe repéré; son lien avec l’employeur reste à vérifier."
        : "Espace recrutement public identifié depuis le site de l’entreprise."
      : "Lien vers une annonce potentielle repéré; le contrat, le lieu, la date et l’employeur restent à confirmer.",
    confidence: link.recruitmentHub ? 0.72 : 0.48,
    sourceKind: link.sourceKind,
    directEmployer: link.sourceKind !== "unknown" && link.linkedFromEmployer,
    specificity: link.specificOffer ? "specific" : "generic",
  };
}

function checkedAt(options: NormalizedScannerOptions) {
  return options.now().toISOString();
}

/**
 * Inspect a small, robots-aware sample of an employer website.
 *
 * Every requested URL (including robots.txt and redirects) is restricted to
 * standard web schemes/ports and must resolve exclusively to public addresses.
 */
export async function inspectEmployerWebsite(
  websiteUrl?: string,
  scannerOptions: SiteScannerOptions = {},
): Promise<SiteInspection> {
  scannerOptions.signal?.throwIfAborted();
  if (!websiteUrl?.trim()) {
    return {
      status: "not-requested",
      pagesChecked: 0,
      evidence: [],
      matchedKeywords: [],
      note: "Aucun site internet n’est renseigné pour cette entreprise.",
    };
  }

  const options = normalizeOptions(scannerOptions);
  const policies = new Map<string, RobotsPolicy>();
  const evidence: OpportunityEvidence[] = [];
  const matchedKeywords = new Set<string>();
  const queued: CrawlCandidate[] = [];
  const visited = new Set<string>();
  const publicHostnames = new Map<string, Promise<boolean>>();
  let recruitmentPageUrl: string | undefined;
  let pagesChecked = 0;
  let partialFailure = false;

  let initialUrl: URL;
  try {
    initialUrl = parseHttpUrl(websiteUrl.trim());
  } catch (error) {
    return {
      status: error instanceof UnsafeUrlError ? "blocked" : "unreachable",
      checkedAt: checkedAt(options),
      pagesChecked: 0,
      evidence: [],
      matchedKeywords: [],
      note:
        error instanceof UnsafeUrlError
          ? error.message
          : "Le site de l’entreprise est actuellement inaccessible.",
    };
  }

  const initialSource = classifyCrawlTarget(initialUrl, initialUrl, false);
  queued.push({
    url: initialUrl,
    label: "Site de l’entreprise",
    ...initialSource,
    recruitmentHub: isRecruitmentHub("", initialUrl),
    specificOffer: false,
  });

  while (queued.length > 0 && pagesChecked < options.maxPages) {
    options.signal?.throwIfAborted();
    const candidate = queued.shift()!;
    if (visited.has(candidate.url.href)) continue;
    visited.add(candidate.url.href);

    try {
      const enforceRobotsPolicy = async (url: URL) => {
        let policy = policies.get(url.origin);
        if (!policy) {
          policy = await loadRobotsPolicy(url, options);
          policies.set(url.origin, policy);
        }
        if (!isAllowedByRobots(url, policy)) {
          throw new UnsafeUrlError(
            "Le fichier robots.txt n’autorise pas l’inspection de cette page.",
          );
        }
      };

      const response = await safeRequest(
        candidate.url,
        options,
        enforceRobotsPolicy,
      );
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        if (pagesChecked === 0) {
          return {
            status: "blocked",
            checkedAt: checkedAt(options),
            pagesChecked: 0,
            evidence: [],
            matchedKeywords: [],
            note: "Le site refuse l’inspection automatisée.",
          };
        }
        partialFailure = true;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        if (pagesChecked === 0) throw new Error("Réponse HTTP non exploitable.");
        partialFailure = true;
        continue;
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("html") && !contentType.includes("xhtml")) {
        if (pagesChecked === 0) {
          return {
            status: "checked",
            checkedAt: checkedAt(options),
            pagesChecked: 0,
            evidence: [],
            matchedKeywords: [],
            note: "Le site ne renvoie pas une page HTML analysable.",
          };
        }
        partialFailure = true;
        continue;
      }

      pagesChecked += 1;
      publicHostnames.set(
        hostnameWithoutBrackets(response.url.hostname).toLowerCase(),
        Promise.resolve(true),
      );
      const responseSource = classifyCrawlTarget(
        response.url,
        initialUrl,
        candidate.linkedFromEmployer,
      );
      const analysis = analyzeHtml(
        response.body,
        response.url,
        options.now(),
        initialUrl,
        responseSource.sourceKind,
        responseSource.linkedFromEmployer,
        options.professionalKeywords,
        options.targetRoles,
        options.expectedLocationText,
        options.expectedEmployerName,
      );
      const publicEvidence = await keepOnlyPublicEvidenceDestinations(
        analysis.evidence,
        response.url,
        options,
        publicHostnames,
      );
      if (
        candidate.label !== "Site de l’entreprise" &&
        responseSource.sourceKind !== "unknown"
      ) {
        const validatedCandidate: CrawlCandidate = {
          ...candidate,
          url: response.url,
          ...responseSource,
          recruitmentHub: isRecruitmentHub(candidate.label, response.url),
          specificOffer: looksLikeSpecificOffer(
            response.url,
            candidate.label,
            options.professionalKeywords,
            options.targetRoles,
          ),
        };
        pushEvidenceBounded(
          evidence,
          recruitmentEvidenceFromLink(validatedCandidate),
          MAX_EVIDENCE_PER_SCAN,
        );
      }
      appendEvidenceBounded(
        evidence,
        publicEvidence,
        MAX_EVIDENCE_PER_SCAN,
      );
      for (const keyword of analysis.matchedKeywords) matchedKeywords.add(keyword);

      if (
        responseSource.sourceKind !== "unknown" &&
        analysis.recruitmentHub
      ) {
        recruitmentPageUrl ??= response.url.href;
      }

      for (const link of analysis.careerLinks) {
        if (
          link.sourceKind !== "unknown" &&
          !visited.has(link.url.href) &&
          queued.length < options.maxPages * 3
        ) {
          queued.push(link);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (pagesChecked === 0) {
        return {
          status: error instanceof UnsafeUrlError ? "blocked" : "unreachable",
          checkedAt: checkedAt(options),
          pagesChecked: 0,
          evidence: [],
          matchedKeywords: [],
          note:
            error instanceof UnsafeUrlError
              ? error.message
              : error instanceof ResponseTooLargeError
                ? "La page est trop volumineuse pour une inspection prudente."
                : error instanceof RequestTimeoutError
                  ? "Le site n’a pas répondu dans le délai prévu."
                  : "Le site de l’entreprise est actuellement inaccessible.",
        };
      }
      partialFailure = true;
    }
  }

  options.signal?.throwIfAborted();
  return {
    status: "checked",
    checkedAt: checkedAt(options),
    pagesChecked,
    recruitmentPageUrl,
    evidence: dedupeEvidence(evidence)
      .sort((left, right) => evidencePriority(right) - evidencePriority(left))
      .slice(0, 12),
    matchedKeywords: [...matchedKeywords],
    note: partialFailure
      ? "Le site principal a été analysé, mais certaines pages liées n’étaient pas accessibles."
      : undefined,
  };
}

