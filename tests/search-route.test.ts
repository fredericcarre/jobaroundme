import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryRateLimiter,
  SEARCH_RATE_LIMIT_MAX_REQUESTS,
} from "@/lib/search-guard";
import { GoogleMapsError } from "@/lib/google-maps";

const { searchEmployersMock } = vi.hoisted(() => ({
  searchEmployersMock: vi.fn(),
}));

vi.mock("@/lib/search-service", () => ({
  searchEmployers: searchEmployersMock,
}));

import { POST } from "@/app/api/search/route";

const ORIGINAL_MAX_CONCURRENT_SEARCHES =
  process.env.SEARCH_MAX_CONCURRENT_SEARCHES;
const ORIGINAL_TRUSTED_CLIENT_IP_HEADER =
  process.env.TRUSTED_CLIENT_IP_HEADER;

beforeEach(() => {
  searchEmployersMock.mockReset();
  process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_MAX_CONCURRENT_SEARCHES === undefined) {
    delete process.env.SEARCH_MAX_CONCURRENT_SEARCHES;
  } else {
    process.env.SEARCH_MAX_CONCURRENT_SEARCHES =
      ORIGINAL_MAX_CONCURRENT_SEARCHES;
  }
  if (ORIGINAL_TRUSTED_CLIENT_IP_HEADER === undefined) {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  } else {
    process.env.TRUSTED_CLIENT_IP_HEADER =
      ORIGINAL_TRUSTED_CLIENT_IP_HEADER;
  }
});

describe("POST /api/search : garde-fous de coût", () => {
  it("pré-vérifie le quota global sans muter le limiteur client", async () => {
    const inspect = vi
      .spyOn(InMemoryRateLimiter.prototype, "inspect")
      .mockReturnValueOnce({
        allowed: false,
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 17,
        resetAfterSeconds: 17,
      });
    const check = vi.spyOn(InMemoryRateLimiter.prototype, "check");

    const response = await POST(
      searchRequest(
        "203.0.113.99",
        validPayload("Nantes quota global saturé"),
      ),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith("all-clients", expect.any(Number));
    expect(check).not.toHaveBeenCalled();
    expect(searchEmployersMock).not.toHaveBeenCalled();
  });

  it("ne valide pas le quota global lorsque le client est déjà bloqué", async () => {
    const inspect = vi
      .spyOn(InMemoryRateLimiter.prototype, "inspect")
      .mockReturnValueOnce({
        allowed: true,
        limit: 120,
        remaining: 120,
        retryAfterSeconds: 0,
        resetAfterSeconds: 60,
      });
    const check = vi
      .spyOn(InMemoryRateLimiter.prototype, "check")
      .mockReturnValueOnce({
        allowed: false,
        limit: 12,
        remaining: 0,
        retryAfterSeconds: 19,
        resetAfterSeconds: 19,
      });

    const response = await POST(
      searchRequest(
        "203.0.113.98",
        validPayload("Nantes quota client saturé"),
      ),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("19");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(searchEmployersMock).not.toHaveBeenCalled();
  });

  it("refuse une requête navigateur cross-site et annule son corps non lu", async () => {
    const guarded = guardedSearchRequest({
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "cross-site",
      "X-Forwarded-For": "203.0.113.101",
    });

    const response = await POST(guarded.request);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(guarded.wasCancelled()).toBe(true);
    expect(searchEmployersMock).not.toHaveBeenCalled();
  });

  it("refuse un type de contenu autre que application/json et annule le corps", async () => {
    const guarded = guardedSearchRequest({
      "Content-Type": "text/plain",
      "X-Forwarded-For": "203.0.113.102",
    });

    const response = await POST(guarded.request);

    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(guarded.wasCancelled()).toBe(true);
    expect(searchEmployersMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "sans Sec-Fetch-Site", secFetchSite: undefined },
    { label: "avec Sec-Fetch-Site same-origin", secFetchSite: "same-origin" },
  ])("accepte une requête JSON $label", async ({ secFetchSite }) => {
    searchEmployersMock.mockResolvedValue({ ok: true });
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "X-Forwarded-For": secFetchSite ? "203.0.113.104" : "203.0.113.103",
    });
    if (secFetchSite) headers.set("Sec-Fetch-Site", secFetchSite);

    const response = await POST(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers,
        body: JSON.stringify(
          validPayload(
            secFetchSite ? "Nantes même origine" : "Nantes sans métadonnée",
          ),
        ),
      }),
    );

    expect(response.status).toBe(200);
    expect(searchEmployersMock).toHaveBeenCalledTimes(1);
  });

  it("réutilise brièvement une recherche générique identique pour le même client", async () => {
    searchEmployersMock.mockResolvedValue({ sequence: 1 });
    const payload = validPayload("Nantes cache route");

    const first = await POST(searchRequest("203.0.113.10", payload));
    const second = await POST(searchRequest("203.0.113.10", payload));

    expect(first.status).toBe(200);
    expect(first.headers.get("x-search-cache")).toBe("miss");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-search-cache")).toBe("hit");
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(searchEmployersMock).toHaveBeenCalledTimes(1);
    expect(searchEmployersMock).toHaveBeenCalledWith(
      expect.objectContaining({ radiusKm: 10 }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        maxEmployers: 40,
      }),
    );
  });

  it("isole le cache entre deux clients", async () => {
    searchEmployersMock
      .mockResolvedValueOnce({ sequence: 1 })
      .mockResolvedValueOnce({ sequence: 2 });
    const payload = validPayload("Nantes cache isolé");

    const first = await POST(searchRequest("203.0.113.11", payload));
    const second = await POST(searchRequest("203.0.113.12", payload));

    expect(first.headers.get("x-search-cache")).toBe("miss");
    expect(second.headers.get("x-search-cache")).toBe("miss");
    expect(searchEmployersMock).toHaveBeenCalledTimes(2);
  });

  it("contourne le cache dès qu’un profil CV accompagne la recherche", async () => {
    searchEmployersMock
      .mockResolvedValueOnce({ sequence: 1 })
      .mockResolvedValueOnce({ sequence: 2 });
    const payload = {
      ...validPayload("Nantes CV privé"),
      profile: {
        headline: "Conseiller de vente · BTS MCO",
        diploma: "BTS MCO",
        targetRoles: ["Conseiller de vente"],
        skills: ["Relation client"],
        sectors: ["Commerce de détail"],
        keywords: ["alternance"],
        romeCodes: ["D1501"],
        confidence: "high",
        explanations: [],
      },
    };

    const first = await POST(searchRequest("203.0.113.13", payload));
    const second = await POST(searchRequest("203.0.113.13", payload));

    expect(first.headers.get("x-search-cache")).toBe("bypass");
    expect(second.headers.get("x-search-cache")).toBe("bypass");
    expect(searchEmployersMock).toHaveBeenCalledTimes(2);
  });

  it("répond 429 avec Retry-After lorsque la fenêtre par client est épuisée", async () => {
    searchEmployersMock.mockResolvedValue({ ok: true });
    const payload = validPayload("Nantes limite route");
    const ip = "203.0.113.14";

    for (let index = 0; index < SEARCH_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      const response = await POST(searchRequest(ip, payload));
      expect(response.status).toBe(200);
    }

    const limited = await POST(searchRequest(ip, payload));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    await expect(limited.json()).resolves.toMatchObject({
      error: expect.stringContaining("Trop de recherches"),
    });
  });

  it("empêche la rotation des en-têtes directs sans proxy explicitement configuré", async () => {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
    searchEmployersMock.mockResolvedValue({ ok: true });

    for (let index = 0; index < SEARCH_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      const response = await POST(
        new Request("http://localhost/api/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": `203.0.113.${index + 30}`,
            "X-Real-IP": `198.51.100.${index + 30}`,
            "CF-Connecting-IP": `192.0.2.${index + 30}`,
          },
          body: JSON.stringify(validPayload(`Nantes rotation ${index}`)),
        }),
      );
      expect(response.status).toBe(200);
    }

    const limited = await POST(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.250",
          "X-Real-IP": "198.51.100.250",
          "CF-Connecting-IP": "192.0.2.250",
        },
        body: JSON.stringify(validPayload("Nantes rotation bloquée")),
      }),
    );

    expect(limited.status).toBe(429);
    expect(searchEmployersMock).toHaveBeenCalledTimes(
      SEARCH_RATE_LIMIT_MAX_REQUESTS,
    );
  });

  it("n’appelle pas le service si le client a déjà annulé la requête", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = await POST(
      searchRequest(
        "203.0.113.15",
        validPayload("Nantes requête annulée"),
        controller.signal,
      ),
    );

    expect(response.status).toBe(499);
    expect(searchEmployersMock).not.toHaveBeenCalled();
  });

  it("borne les recherches actives et libère la place après leur fin", async () => {
    process.env.SEARCH_MAX_CONCURRENT_SEARCHES = "1";
    let releaseFirstSearch!: (value: unknown) => void;
    const firstSearch = new Promise((resolve) => {
      releaseFirstSearch = resolve;
    });
    searchEmployersMock
      .mockReturnValueOnce(firstSearch)
      .mockResolvedValue({ sequence: 2 });

    const firstResponsePromise = POST(
      searchRequest(
        "203.0.113.18",
        validPayload("Nantes concurrence ouverte"),
      ),
    );
    await vi.waitFor(() => {
      expect(searchEmployersMock).toHaveBeenCalledTimes(1);
    });

    let saturated: Response;
    try {
      saturated = await POST(
        searchRequest(
          "203.0.113.19",
          validPayload("Nantes concurrence refusée"),
        ),
      );
    } finally {
      releaseFirstSearch({ sequence: 1 });
    }

    expect(saturated.status).toBe(503);
    expect(saturated.headers.get("retry-after")).toBe("2");
    expect(searchEmployersMock).toHaveBeenCalledTimes(1);
    expect((await firstResponsePromise).status).toBe(200);

    const admittedAfterRelease = await POST(
      searchRequest(
        "203.0.113.20",
        validPayload("Nantes concurrence libérée"),
      ),
    );
    expect(admittedAfterRelease.status).toBe(200);
    expect(searchEmployersMock).toHaveBeenCalledTimes(2);
  });

  it("explique une adresse introuvable au lieu de signaler une panne serveur", async () => {
    searchEmployersMock.mockRejectedValue(
      new GoogleMapsError(
        "GEOCODING_NOT_FOUND",
        "L’adresse n’a pas pu être localisée.",
      ),
    );

    const response = await POST(
      searchRequest("203.0.113.16", validPayload("Adresse qui n’existe pas")),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "L’adresse n’a pas pu être localisée.",
    });
  });

  it("refuse un corps JSON trop volumineux avant son analyse", async () => {
    const response = await POST(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(70 * 1024),
          "X-Forwarded-For": "203.0.113.17",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
  });
});

function validPayload(address: string) {
  return {
    origin: { kind: "address", address },
    radiusKm: 10,
    travelModes: ["TRANSIT"],
  };
}

function searchRequest(ip: string, payload: unknown, signal?: AbortSignal) {
  return new Request("http://localhost/api/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
}

function guardedSearchRequest(headers: HeadersInit): {
  request: Request;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const init = {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } satisfies RequestInit & { duplex: "half" };

  return {
    request: new Request("http://localhost/api/search", init),
    wasCancelled: () => cancelled,
  };
}
