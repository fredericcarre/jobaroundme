import { NextResponse } from "next/server";

import {
  BoundedTtlCache,
  consumeHierarchicalRateLimit,
  InMemoryRateLimiter,
  isSafeSearchCacheInput,
  rateLimitHeaders,
  readSearchMaxEmployers,
  searchCacheKey,
  searchClientIdentifier,
} from "@/lib/search-guard";
import {
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/request-body";
import { GoogleMapsError } from "@/lib/google-maps";
import { searchInputSchema } from "@/lib/search-schema";
import { searchEmployers } from "@/lib/search-service";
import type { SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const rateLimiter = new InMemoryRateLimiter();
const globalRateLimiter = new InMemoryRateLimiter(120, 60_000, 1);
const responseCache = new BoundedTtlCache<SearchResponse>();
const MAX_SEARCH_REQUEST_BYTES = 64 * 1024;
const SEARCH_EXECUTION_TIMEOUT_MS = 50_000;
const DEFAULT_MAX_CONCURRENT_SEARCHES = 6;
const MAX_CONFIGURED_CONCURRENT_SEARCHES = 20;
let activeSearchExecutions = 0;
const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export async function POST(request: Request) {
  if (request.signal.aborted) {
    await cancelUnreadBody(request);
    return abortedResponse();
  }

  if (isExplicitlyCrossSite(request.headers)) {
    await cancelUnreadBody(request);
    return NextResponse.json(
      { error: "Les requêtes provenant d’un autre site ne sont pas autorisées." },
      { status: 403, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    await cancelUnreadBody(request);
    return NextResponse.json(
      { error: "La requête doit utiliser le type application/json." },
      { status: 415, headers: PRIVATE_RESPONSE_HEADERS },
    );
  }

  const admission = consumeHierarchicalRateLimit(
    globalRateLimiter,
    "all-clients",
    rateLimiter,
    () => searchClientIdentifier(request.headers),
  );

  if (admission.scope === "global") {
    const globalRateLimitHeaders = rateLimitHeaders(admission.global);
    await cancelUnreadBody(request);
    return NextResponse.json(
      {
        error:
          "Le service reçoit trop de recherches en ce moment. Réessayez dans quelques instants.",
      },
      {
        status: 429,
        headers: {
          ...PRIVATE_RESPONSE_HEADERS,
          ...globalRateLimitHeaders,
          "Retry-After": String(admission.global.retryAfterSeconds),
        },
      },
    );
  }

  if (admission.scope === "client") {
    const requestHeaders = rateLimitHeaders(admission.client);
    await cancelUnreadBody(request);
    return NextResponse.json(
      {
        error:
          "Trop de recherches ont été lancées en peu de temps. Réessayez dans quelques instants.",
      },
      {
        status: 429,
        headers: {
          ...PRIVATE_RESPONSE_HEADERS,
          ...requestHeaders,
          "Retry-After": String(admission.client.retryAfterSeconds),
        },
      },
    );
  }

  const clientIdentifier = admission.clientKey;
  const requestHeaders = rateLimitHeaders(admission.client);

  let payload: unknown;

  try {
    const body = await readBoundedRequestBody(
      request,
      MAX_SEARCH_REQUEST_BYTES,
      { totalTimeoutMs: 5_000 },
    );
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      return abortedResponse(requestHeaders);
    }
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "La requête de recherche est trop volumineuse." },
        {
          status: 413,
          headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
        },
      );
    }
    if (error instanceof RequestBodyTimeoutError) {
      return NextResponse.json(
        { error: "La requête de recherche a mis trop de temps à arriver." },
        {
          status: 408,
          headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
        },
      );
    }
    return NextResponse.json(
      { error: "La requête doit contenir un objet JSON valide." },
      {
        status: 400,
        headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
      },
    );
  }

  const parsed = searchInputSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Certains critères de recherche sont invalides.",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      {
        status: 400,
        headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
      },
    );
  }

  const cacheable = isSafeSearchCacheInput(parsed.data);
  const cacheKey = cacheable
    ? searchCacheKey(clientIdentifier, parsed.data)
    : undefined;
  const cached = cacheKey ? responseCache.get(cacheKey) : undefined;
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        ...PRIVATE_RESPONSE_HEADERS,
        ...requestHeaders,
        "X-Search-Cache": "hit",
      },
    });
  }

  const maxConcurrentSearches = readMaxConcurrentSearches();
  if (activeSearchExecutions >= maxConcurrentSearches) {
    return NextResponse.json(
      {
        error:
          "Le service traite déjà plusieurs recherches. Réessayez dans quelques secondes.",
      },
      {
        status: 503,
        headers: {
          ...PRIVATE_RESPONSE_HEADERS,
          ...requestHeaders,
          "Retry-After": "2",
        },
      },
    );
  }
  activeSearchExecutions += 1;

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new Error("La recherche a dépassé le délai maximal."),
      ),
    SEARCH_EXECUTION_TIMEOUT_MS,
  );
  const executionSignal = AbortSignal.any([
    request.signal,
    timeoutController.signal,
  ]);

  try {
    executionSignal.throwIfAborted();
    const result = await searchEmployers(parsed.data, {
      signal: executionSignal,
      maxEmployers: readSearchMaxEmployers(),
    });
    executionSignal.throwIfAborted();

    if (cacheKey) responseCache.set(cacheKey, result);
    return NextResponse.json(result, {
      headers: {
        ...PRIVATE_RESPONSE_HEADERS,
        ...requestHeaders,
        "X-Search-Cache": cacheKey ? "miss" : "bypass",
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return abortedResponse(requestHeaders);
    }
    if (timeoutController.signal.aborted) {
      return NextResponse.json(
        {
          error:
            "La recherche a pris trop de temps. Réduisez le rayon ou le nombre de modes de transport, puis réessayez.",
        },
        {
          status: 504,
          headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
        },
      );
    }
    if (isAbortError(error)) return abortedResponse(requestHeaders);
    if (
      error instanceof GoogleMapsError &&
      error.code === "GEOCODING_NOT_FOUND"
    ) {
      return NextResponse.json(
        { error: error.message },
        {
          status: 422,
          headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
        },
      );
    }

    console.error("Employer search failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });

    return NextResponse.json(
      {
        error:
          "La recherche en direct est momentanément indisponible. Vérifiez la configuration Google Maps ou réessayez.",
      },
      {
        status: 502,
        headers: { ...PRIVATE_RESPONSE_HEADERS, ...requestHeaders },
      },
    );
  } finally {
    clearTimeout(timeout);
    activeSearchExecutions -= 1;
  }
}

function readMaxConcurrentSearches(
  configured = process.env.SEARCH_MAX_CONCURRENT_SEARCHES,
): number {
  const parsed = Number.parseInt(configured ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT_SEARCHES;
  return Math.max(1, Math.min(MAX_CONFIGURED_CONCURRENT_SEARCHES, parsed));
}

function abortedResponse(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    // 499 is widely used for a request cancelled by the client. In practice,
    // the disconnected client will generally never receive this response.
    status: 499,
    headers: { ...PRIVATE_RESPONSE_HEADERS, ...headers },
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isExplicitlyCrossSite(headers: Headers): boolean {
  return headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site";
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function cancelUnreadBody(request: Request): Promise<void> {
  if (!request.body || request.body.locked) return;
  await request.body.cancel().catch(() => undefined);
}
