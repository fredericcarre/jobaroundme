import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoundedTtlCache,
  canonicalizeClientIp,
  consumeHierarchicalRateLimit,
  DEFAULT_SEARCH_MAX_EMPLOYERS,
  InMemoryRateLimiter,
  isSafeSearchCacheInput,
  readSearchMaxEmployers,
  searchCacheKey,
  searchClientIdentifier,
} from "@/lib/search-guard";

afterEach(() => {
  vi.useRealTimers();
});

function rateLimiterBucketCount(limiter: InMemoryRateLimiter): number {
  return (
    limiter as unknown as {
      buckets: Map<string, unknown>;
    }
  ).buckets.size;
}

function cacheEntryCount<T>(cache: BoundedTtlCache<T>): number {
  return (
    cache as unknown as {
      entries: Map<string, unknown>;
    }
  ).entries.size;
}

describe("InMemoryRateLimiter", () => {
  it("inspecte la capacité sans consommer, allouer ni faire tourner la fenêtre", () => {
    const limiter = new InMemoryRateLimiter(2, 10_000, 10);
    limiter.check("ancien-client", 1_000);
    const previousBuckets = (
      limiter as unknown as { buckets: Map<string, unknown> }
    ).buckets;

    expect(limiter.inspect("client", 11_000)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(rateLimiterBucketCount(limiter)).toBe(1);
    expect(
      (limiter as unknown as { activeWindowId?: number }).activeWindowId,
    ).toBe(0);
    expect(
      (limiter as unknown as { buckets: Map<string, unknown> }).buckets,
    ).toBe(previousBuckets);
    expect(limiter.check("client", 11_000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("refuse les requêtes au-delà de la fenêtre fixe et indique quand réessayer", () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(2, 10_000, 10);

    expect(limiter.check("client", 1_000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.check("client", 2_000)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.check("client", 2_500)).toEqual({
      allowed: false,
      limit: 2,
      remaining: 0,
      retryAfterSeconds: 8,
      resetAfterSeconds: 8,
    });

    expect(limiter.check("client", 10_001)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("agrège les nouvelles identités sans évincer les clients déjà suivis", () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(2, 60_000, 2);

    expect(limiter.check("a", 1).allowed).toBe(true);
    expect(limiter.check("b", 2).allowed).toBe(true);
    expect(limiter.check("c", 3).allowed).toBe(true);
    expect(limiter.check("d", 4)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.check("e", 5).allowed).toBe(false);
    expect(limiter.check("a", 6).allowed).toBe(true);
    expect(limiter.check("a", 7).allowed).toBe(false);
    expect(rateLimiterBucketCount(limiter)).toBe(2);
  });

  it("borne la mémoire et le quota même sous une rotation massive d’identités", () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(4, 60_000, 3);
    let allowed = 0;

    for (let index = 0; index < 5_000; index += 1) {
      if (limiter.check(`client-${index}`, 1_000 + index).allowed) allowed += 1;
    }

    // Three one-shot tracked clients, then four admissions from one shared overflow bucket.
    expect(allowed).toBe(7);
    expect(rateLimiterBucketCount(limiter)).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("remplace la génération bornée en temps constant à la fenêtre suivante", () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(2, 1_000, 10);
    limiter.check("client-a", 500);
    const previousBuckets = (
      limiter as unknown as { buckets: Map<string, unknown> }
    ).buckets;

    expect(limiter.check("client-b", 1_001).allowed).toBe(true);
    const currentBuckets = (
      limiter as unknown as { buckets: Map<string, unknown> }
    ).buckets;

    expect(currentBuckets).not.toBe(previousBuckets);
    expect(rateLimiterBucketCount(limiter)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ne recrée pas de quota lorsque l’horloge système recule", () => {
    const limiter = new InMemoryRateLimiter(1, 1_000, 10);

    expect(limiter.check("client", 1_500).allowed).toBe(true);
    expect(limiter.check("client", 500).allowed).toBe(false);
  });

  it("bloque globalement avant de résoudre ou muter le client", () => {
    const globalLimiter = new InMemoryRateLimiter(1, 60_000, 1);
    const clientLimiter = new InMemoryRateLimiter(2, 60_000, 10);
    globalLimiter.check("all", 1_000);
    const resolveClientKey = vi.fn(() => "client");

    const decision = consumeHierarchicalRateLimit(
      globalLimiter,
      "all",
      clientLimiter,
      resolveClientKey,
      2_000,
    );

    expect(decision.scope).toBe("global");
    expect(resolveClientKey).not.toHaveBeenCalled();
    expect(rateLimiterBucketCount(clientLimiter)).toBe(0);
  });

  it("ne consomme pas le quota global lorsque le client est refusé", () => {
    const globalLimiter = new InMemoryRateLimiter(2, 60_000, 1);
    const clientLimiter = new InMemoryRateLimiter(1, 60_000, 10);
    clientLimiter.check("bloque", 1_000);

    for (let index = 0; index < 5; index += 1) {
      expect(
        consumeHierarchicalRateLimit(
          globalLimiter,
          "all",
          clientLimiter,
          () => "bloque",
          2_000 + index,
        ).scope,
      ).toBe("client");
    }

    expect(globalLimiter.inspect("all", 3_000).remaining).toBe(2);
    const admitted = consumeHierarchicalRateLimit(
      globalLimiter,
      "all",
      clientLimiter,
      () => "nouveau-client",
      3_000,
    );
    expect(admitted).toMatchObject({
      scope: "allowed",
      global: { remaining: 1 },
      client: { remaining: 0 },
    });
    expect(
      consumeHierarchicalRateLimit(
        globalLimiter,
        "all",
        clientLimiter,
        () => "dernier-client",
        3_001,
      ),
    ).toMatchObject({ scope: "allowed", global: { remaining: 0 } });
    const resolveRejectedClient = vi.fn(() => "jamais-resolu");
    expect(
      consumeHierarchicalRateLimit(
        globalLimiter,
        "all",
        clientLimiter,
        resolveRejectedClient,
        3_002,
      ).scope,
    ).toBe("global");
    expect(resolveRejectedClient).not.toHaveBeenCalled();
  });
});

describe("BoundedTtlCache", () => {
  it("expire les réponses et évince l’entrée la moins récemment consultée", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<number>(1_000, 2);
    cache.set("a", 1, 0);
    cache.set("b", 2, 10);
    expect(cache.get("a", 20)).toBe(1);

    cache.set("c", 3, 30);
    expect(cache.get("b", 30)).toBeUndefined();
    expect(cache.get("a", 999)).toBe(1);
    expect(cache.get("a", 1_000)).toBeUndefined();
  });

  it("supprime activement les valeurs expirées sans nouvelle consultation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = new BoundedTtlCache<number>(1_000, 10);

    cache.set("a", 1);
    cache.set("b", 2);

    expect(cacheEntryCount(cache)).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);

    expect(cacheEntryCount(cache)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ne laisse pas de timers lors d’un remplacement, d’une suppression ou d’un clear", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<number>(1_000, 2);

    cache.set("a", 1);
    cache.set("a", 2);
    cache.set("b", 3);
    cache.set("c", 4);
    expect(cacheEntryCount(cache)).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    expect(cache.get("b", Date.now() + 1_000)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);

    cache.clear();
    expect(cacheEntryCount(cache)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("évince les entrées LRU pour respecter le budget en octets", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<string>(1_000, 10, 14);

    cache.set("a", "1234");
    cache.set("b", "5678");
    expect(cache.get("a")).toBe("1234");

    cache.set("c", "9012");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1234");
    expect(cache.get("c")).toBe("9012");
  });

  it("refuse une valeur qui dépasse à elle seule le budget", () => {
    vi.useFakeTimers();
    const cache = new BoundedTtlCache<string>(1_000, 10, 16);

    cache.set("petite", "ok");
    cache.set("trop-grande", "une valeur trop grande");

    expect(cache.get("petite")).toBe("ok");
    expect(cache.get("trop-grande")).toBeUndefined();
  });
});

describe("garde-fous de cache et de configuration", () => {
  const genericInput = {
    origin: { kind: "address" as const, address: "Nantes, France" },
    radiusKm: 10,
    travelModes: ["TRANSIT" as const],
  };

  it("ne met jamais en cache une recherche contenant un profil CV", () => {
    expect(isSafeSearchCacheInput(genericInput)).toBe(true);
    expect(
      isSafeSearchCacheInput({
        ...genericInput,
        profile: {
          headline: "Conseiller de vente",
          targetRoles: ["Conseiller de vente"],
          skills: [],
          sectors: [],
          keywords: [],
          romeCodes: ["D1501"],
          confidence: "high",
          explanations: [],
        },
      }),
    ).toBe(false);
  });

  it("produit une clé opaque, stable malgré l’ordre des propriétés et isolée par client", () => {
    const first = searchCacheKey("client-a", genericInput);
    const reordered = searchCacheKey("client-a", {
      travelModes: ["TRANSIT"],
      radiusKm: 10,
      origin: { address: "Nantes, France", kind: "address" },
    });

    expect(first).toBe(reordered);
    expect(first).not.toContain("Nantes");
    expect(searchCacheKey("client-b", genericInput)).not.toBe(first);
  });

  it("canonise IPv4, IPv6 et IPv4 mappée, puis rejette les formes ambiguës", () => {
    expect(canonicalizeClientIp(" 192.0.2.24 ")).toBe("192.0.2.24");
    expect(canonicalizeClientIp("2001:0DB8:0:0:0:0:0:1")).toBe(
      "2001:db8::1",
    );
    expect(canonicalizeClientIp("::ffff:192.0.2.24")).toBe("192.0.2.24");
    expect(canonicalizeClientIp("192.0.2.24, 10.0.0.1")).toBeUndefined();
    expect(canonicalizeClientIp("192.0.2.24:443")).toBeUndefined();
    expect(canonicalizeClientIp("010.000.000.001")).toBeUndefined();
    expect(canonicalizeClientIp("fe80::1%eth0")).toBeUndefined();
  });

  it("pseudonymise par HMAC seulement l’adresse du proxy explicitement configurée", async () => {
    const headers = new Headers({
      "x-client-ip": "203.0.113.24",
      "x-forwarded-for": "198.51.100.10",
    });
    const identifier = searchClientIdentifier(headers, "X-Client-IP");

    expect(identifier).not.toContain("203.0.113.24");
    expect(identifier).toHaveLength(43);
    expect(searchClientIdentifier(headers, "x-client-ip")).toBe(identifier);
    expect(
      searchClientIdentifier(
        new Headers({ "x-client-ip": "203.0.113.25" }),
        "x-client-ip",
      ),
    ).not.toBe(identifier);

    vi.resetModules();
    const reloadedModule = await import("@/lib/search-guard");
    expect(
      reloadedModule.searchClientIdentifier(headers, "x-client-ip"),
    ).not.toBe(identifier);
  });

  it("ignore tous les en-têtes directs sans proxy configuré", () => {
    const first = searchClientIdentifier(
      new Headers({
        "x-forwarded-for": "203.0.113.1",
        "x-real-ip": "203.0.113.2",
        "cf-connecting-ip": "203.0.113.3",
      }),
      "",
    );
    const rotated = searchClientIdentifier(
      new Headers({
        "x-forwarded-for": "198.51.100.1",
        "x-real-ip": "198.51.100.2",
        "cf-connecting-ip": "198.51.100.3",
      }),
      "",
    );

    expect(rotated).toBe(first);
  });

  it("agrège les valeurs proxy absentes, invalides ou composées", () => {
    const missing = searchClientIdentifier(new Headers(), "x-client-ip");

    expect(
      searchClientIdentifier(
        new Headers({ "x-client-ip": "203.0.113.5, 10.0.0.2" }),
        "x-client-ip",
      ),
    ).toBe(missing);
    expect(
      searchClientIdentifier(
        new Headers({ "x-client-ip": "valeur-changeante-invalide" }),
        "x-client-ip",
      ),
    ).toBe(missing);
  });

  it("borne le plafond d’employeurs configurable", () => {
    expect(readSearchMaxEmployers(undefined)).toBe(
      DEFAULT_SEARCH_MAX_EMPLOYERS,
    );
    expect(readSearchMaxEmployers("0")).toBe(1);
    expect(readSearchMaxEmployers("24")).toBe(24);
    expect(readSearchMaxEmployers("999")).toBe(40);
    expect(readSearchMaxEmployers("invalide")).toBe(
      DEFAULT_SEARCH_MAX_EMPLOYERS,
    );
  });
});
