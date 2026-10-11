import { createHash, createHmac, randomBytes } from "node:crypto";

import ipaddr from "ipaddr.js";

import type { SearchInput } from "@/lib/types";

export const SEARCH_RATE_LIMIT_MAX_REQUESTS = 12;
export const SEARCH_RATE_LIMIT_WINDOW_MS = 60_000;
export const SEARCH_CACHE_TTL_MS = 90_000;
export const SEARCH_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SEARCH_MAX_EMPLOYERS = 40;

const MAX_RATE_LIMIT_CLIENTS = 10_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_CONFIGURED_EMPLOYERS = 40;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CLIENT_IDENTIFIER_SECRET = randomBytes(32);

type ExpiryTimer = ReturnType<typeof setTimeout>;

function cancelTimer(timer: ExpiryTimer | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

function detachTimer(timer: ExpiryTimer): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

function boundedTimerDelay(delayMs: number): number {
  return Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(delayMs)));
}

function approximateEntryBytes(key: string, value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Number.POSITIVE_INFINITY;
    return Buffer.byteLength(key, "utf8") + Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAfterSeconds: number;
}

export type HierarchicalRateLimitDecision =
  | {
      scope: "global";
      global: RateLimitDecision;
    }
  | {
      scope: "client";
      global: RateLimitDecision;
      client: RateLimitDecision;
      clientKey: string;
    }
  | {
      scope: "allowed";
      global: RateLimitDecision;
      client: RateLimitDecision;
      clientKey: string;
    };

interface RateLimitBucket {
  count: number;
}

/**
 * Small, bounded fixed-window limiter for one Node.js process. Every check is
 * O(1): rotating untrusted identities cannot trigger a scan or evict tracked
 * clients. Once the identity capacity is reached, all unknown clients share a
 * single overflow bucket until the next window.
 *
 * The deployment layer remains responsible for a distributed limit when
 * several instances are running.
 */
export class InMemoryRateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private overflowBucket: RateLimitBucket = { count: 0 };
  private activeWindowId: number | undefined;

  constructor(
    private readonly limit = SEARCH_RATE_LIMIT_MAX_REQUESTS,
    private readonly windowMs = SEARCH_RATE_LIMIT_WINDOW_MS,
    private readonly maxClients = MAX_RATE_LIMIT_CLIENTS,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("La limite doit être un entier positif.");
    }
    if (!Number.isFinite(windowMs) || windowMs < 1) {
      throw new TypeError("La fenêtre doit être positive.");
    }
    if (!Number.isInteger(maxClients) || maxClients < 1) {
      throw new TypeError("Le nombre maximal de clients doit être positif.");
    }
  }

  /**
   * Observe the current quota without rotating a window, allocating a bucket,
   * or consuming an admission. This is suitable for an early global-capacity
   * check before touching attacker-controlled client state.
   */
  inspect(key: string, now = Date.now()): RateLimitDecision {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    const requestedWindowId = Math.floor(timestamp / this.windowMs);
    const windowId =
      this.activeWindowId === undefined ||
      requestedWindowId > this.activeWindowId
        ? requestedWindowId
        : this.activeWindowId;
    const resetAfterMs = Math.max(
      1,
      (windowId + 1) * this.windowMs - timestamp,
    );
    const bucket =
      windowId === this.activeWindowId
        ? (this.buckets.get(key) ??
          (this.buckets.size >= this.maxClients
            ? this.overflowBucket
            : undefined))
        : undefined;
    const count = bucket?.count ?? 0;

    return {
      allowed: count < this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      retryAfterSeconds:
        count < this.limit
          ? 0
          : Math.max(1, Math.ceil(resetAfterMs / 1_000)),
      resetAfterSeconds: Math.max(1, Math.ceil(resetAfterMs / 1_000)),
    };
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    const requestedWindowId = Math.floor(timestamp / this.windowMs);

    if (
      this.activeWindowId === undefined ||
      requestedWindowId > this.activeWindowId
    ) {
      // Replacing the map keeps window rotation constant-time and lets the old
      // bounded map be reclaimed without walking attacker-controlled keys.
      this.buckets = new Map<string, RateLimitBucket>();
      this.overflowBucket = { count: 0 };
      this.activeWindowId = requestedWindowId;
    }

    // A backwards wall-clock adjustment must never create a fresh quota.
    const windowId = this.activeWindowId;
    const windowEndsAt = (windowId + 1) * this.windowMs;
    const resetAfterMs = Math.max(1, windowEndsAt - timestamp);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      if (this.buckets.size < this.maxClients) {
        bucket = { count: 0 };
        this.buckets.set(key, bucket);
      } else {
        bucket = this.overflowBucket;
      }
    }

    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(resetAfterMs / 1_000)),
        resetAfterSeconds: Math.max(1, Math.ceil(resetAfterMs / 1_000)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - bucket.count,
      retryAfterSeconds: 0,
      resetAfterSeconds: Math.max(1, Math.ceil(resetAfterMs / 1_000)),
    };
  }

  clear(): void {
    this.buckets = new Map<string, RateLimitBucket>();
    this.overflowBucket = { count: 0 };
    this.activeWindowId = undefined;
  }
}

/**
 * Enforce a process-wide ceiling and a per-client ceiling as one synchronous
 * operation. The global inspection is non-consuming, so a globally saturated
 * service rejects before resolving or mutating client state. Once capacity is
 * known to exist, the client admission is consumed first. A rejected client
 * therefore never spends global capacity. There is no async boundary before
 * the final global commit, so another request handler cannot interleave with
 * the inspection/commit pair in this process.
 */
export function consumeHierarchicalRateLimit(
  globalLimiter: InMemoryRateLimiter,
  globalKey: string,
  clientLimiter: InMemoryRateLimiter,
  resolveClientKey: () => string,
  now = Date.now(),
): HierarchicalRateLimitDecision {
  if (globalLimiter === clientLimiter) {
    throw new TypeError("Les quotas global et client doivent être distincts.");
  }

  const timestamp = Number.isFinite(now) ? now : Date.now();
  const globalPreflight = globalLimiter.inspect(globalKey, timestamp);
  if (!globalPreflight.allowed) {
    return { scope: "global", global: globalPreflight };
  }

  const clientKey = resolveClientKey();
  const client = clientLimiter.check(clientKey, timestamp);
  if (!client.allowed) {
    return {
      scope: "client",
      global: globalPreflight,
      client,
      clientKey,
    };
  }

  const global = globalLimiter.check(globalKey, timestamp);
  if (!global.allowed) {
    // The callback must stay side-effect free. Keep this invariant explicit so
    // a future caller cannot silently consume client capacity without the
    // matching global admission.
    throw new Error("Le quota global a changé pendant son admission synchrone.");
  }

  return { scope: "allowed", global, client, clientKey };
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  sizeBytes: number;
}

/** A TTL cache with a hard entry bound; values never leave this process. */
export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private expiryTimer: ExpiryTimer | undefined;
  private totalBytes = 0;

  constructor(
    private readonly ttlMs = SEARCH_CACHE_TTL_MS,
    private readonly maxEntries = MAX_CACHE_ENTRIES,
    private readonly maxBytes = SEARCH_CACHE_MAX_BYTES,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new TypeError("La durée du cache doit être positive.");
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("La taille du cache doit être positive.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("Le budget mémoire du cache doit être positif.");
    }
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.deleteEntry(key);
      this.scheduleNextExpiry();
      return undefined;
    }

    // Refresh insertion order so bounded eviction behaves like a small LRU.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.prune(now);
    this.deleteEntry(key);

    const sizeBytes = approximateEntryBytes(key, value);
    if (!Number.isFinite(sizeBytes) || sizeBytes > this.maxBytes) {
      this.scheduleNextExpiry();
      return;
    }

    while (
      this.entries.size >= this.maxEntries ||
      this.totalBytes + sizeBytes > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.deleteEntry(oldestKey);
    }
    this.entries.set(key, {
      value,
      expiresAt: now + this.ttlMs,
      sizeBytes,
    });
    this.totalBytes += sizeBytes;
    this.scheduleNextExpiry();
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
    cancelTimer(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.deleteEntry(key);
    }
  }

  private deleteEntry(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalBytes -= entry.sizeBytes;
    return true;
  }

  private scheduleNextExpiry(): void {
    cancelTimer(this.expiryTimer);
    this.expiryTimer = undefined;

    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      nextExpiry = Math.min(nextExpiry, entry.expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;

    const timer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.prune(Date.now());
      this.scheduleNextExpiry();
    }, boundedTimerDelay(nextExpiry - Date.now()));
    this.expiryTimer = timer;
    detachTimer(timer);
  }
}

/**
 * The cache deliberately excludes CV searches. Even though the key is hashed,
 * a personalized response can contain a profile label and should not outlive
 * the request merely to save an upstream call.
 */
export function isSafeSearchCacheInput(input: SearchInput): boolean {
  return input.profile === undefined;
}

export function searchCacheKey(
  clientIdentifier: string,
  input: SearchInput,
): string {
  return createHash("sha256")
    .update("jobaroundme-search-v1\0")
    .update(clientIdentifier)
    .update("\0")
    .update(canonicalJson(input))
    .digest("base64url");
}

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UNKNOWN_CLIENT_ADDRESS = "adresse-client-non-certifiee";

/**
 * Return one canonical IP. Lists, ports, IPv6 zones and ambiguous IPv4
 * spellings are rejected so different text cannot rotate one logical client.
 */
export function canonicalizeClientIp(value: string | null): string | undefined {
  if (value === null) return undefined;
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > 64 ||
    candidate.includes(",") ||
    candidate.includes("%")
  ) {
    return undefined;
  }

  if (/^[0-9.]+$/.test(candidate)) {
    const parts = candidate.split(".");
    if (
      parts.length !== 4 ||
      parts.some(
        (part) =>
          !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255,
      )
    ) {
      return undefined;
    }
    return parts.map((part) => String(Number(part))).join(".");
  }

  if (!ipaddr.isValid(candidate)) return undefined;
  return ipaddr.process(candidate).toString();
}

/**
 * Pseudonymize the address set by one explicitly trusted reverse-proxy
 * header. With no valid configuration/value, every unattributed request uses
 * the same fallback identity rather than attacker-controlled header values.
 */
export function searchClientIdentifier(
  headers: Headers,
  configuredHeader = process.env.TRUSTED_CLIENT_IP_HEADER,
): string {
  const headerName = configuredHeader?.trim().toLowerCase();
  const trustedAddress =
    headerName && HTTP_HEADER_NAME_PATTERN.test(headerName)
      ? canonicalizeClientIp(headers.get(headerName))
      : undefined;
  const address = trustedAddress ?? UNKNOWN_CLIENT_ADDRESS;

  return createHmac("sha256", CLIENT_IDENTIFIER_SECRET)
    .update("jobaroundme-client-v1\0")
    .update(address)
    .digest("base64url");
}

export function rateLimitHeaders(
  decision: RateLimitDecision,
): Record<string, string> {
  return {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(decision.resetAfterSeconds),
  };
}

export function readSearchMaxEmployers(
  configured = process.env.SEARCH_MAX_EMPLOYERS,
): number {
  const parsed = Number.parseInt(configured ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_MAX_EMPLOYERS;
  return Math.max(1, Math.min(MAX_CONFIGURED_EMPLOYERS, parsed));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortObjectKeys(nestedValue)]),
  );
}
