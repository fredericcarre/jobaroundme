import { haversineDistanceKm } from "@/lib/geo";
import type { GooglePlaceCandidate } from "@/lib/google-maps";
import { safePublicHttpUrl } from "@/lib/public-url";
import type { Coordinates, OpportunityEvidence } from "@/lib/types";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";

const LBA_SEARCH_ENDPOINT =
  "https://api.apprentissage.beta.gouv.fr/api/job/v1/search";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_PER_EMPLOYER = 12;
const LOCATION_TOLERANCE_KM = 0.5;
const NEAR_EXACT_LOCATION_KM = 0.05;
const ENV_PROXY_AGENT = new EnvHttpProxyAgent();

export const BTS_MCO_ROME_CODES = [
  "D1301",
  "D1401",
  "D1501",
  "D1502",
  "D1503",
  "D1506",
  "M1704",
  "M1705",
] as const;

const ROME_CODE_PATTERN = /^[A-Z][0-9]{4}$/;
const MAX_ROME_CODES_PER_SEARCH = 10;
const SUPPORTED_ROME_CODES = new Set<string>(BTS_MCO_ROME_CODES);

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const proxyFetch: FetchLike = async (input, init) =>
  (await undiciFetch(input, {
    ...init,
    dispatcher: ENV_PROXY_AGENT,
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;

const geopointSchema = z.object({
  type: z.literal("Point").optional(),
  coordinates: z.tuple([z.number(), z.number()]),
});

const workplaceSchema = z.object({
  name: z.string().nullable().optional(),
  legal_name: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  siret: z.string().regex(/^\d{14}$/).nullable().optional(),
  website: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  location: z.object({
    address: z.string(),
    geopoint: geopointSchema,
  }),
  domain: z
    .object({
      naf: z
        .object({
          code: z.string(),
          label: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

const applySchema = z.object({
  url: z.string(),
});

const jobSchema = z.object({
  identifier: z.object({
    id: z.string().nullable().optional(),
    partner_job_id: z.string(),
    partner_label: z.string(),
  }),
  workplace: workplaceSchema,
  apply: applySchema,
  contract: z.object({
    type: z.array(z.enum(["Apprentissage", "Professionnalisation"])),
  }),
  offer: z.object({
    title: z.string(),
    description: z.string(),
    desired_skills: z.array(z.string()).optional().default([]),
    to_be_acquired_skills: z.array(z.string()).optional().default([]),
    rome_codes: z.array(z.string()),
    status: z.enum(["Active", "Filled", "Cancelled"]),
    publication: z.object({
      creation: z.string().nullable(),
      expiration: z.string().nullable(),
    }),
  }),
  is_delegated: z.boolean(),
});

const recruiterSchema = z.object({
  identifier: z.object({ id: z.string() }),
  workplace: workplaceSchema,
  apply: applySchema,
});

const responseSchema = z.object({
  jobs: z.array(z.unknown()),
  recruiters: z.array(z.unknown()),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
    }),
  ),
});

export interface LaBonneAlternanceOptions {
  /** Test hook. Production requests use the managed environment proxy. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** Cancels the upstream request when the client abandons the search. */
  signal?: AbortSignal;
  /** Server-derived ROME codes. Invalid or empty inputs fall back to BTS MCO. */
  romeCodes?: readonly string[];
}

export interface LaBonneAlternanceEmployer {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  address: string;
  coordinates: Coordinates;
  distanceKm: number;
  siret?: string;
  websiteUrl?: string;
  evidence: OpportunityEvidence[];
  matchedKeywords: string[];
  publicOfferCount: number;
  recruiterSignal: boolean;
}

export interface LaBonneAlternanceWarning {
  code: string;
  message: string;
}

export interface LaBonneAlternanceSearchResult {
  employers: LaBonneAlternanceEmployer[];
  warnings: LaBonneAlternanceWarning[];
  statistics: {
    jobsReceived: number;
    recruitersReceived: number;
    publicOffersIncluded: number;
    recruitersIncluded: number;
    delegatedJobsHidden: number;
    invalidOrInactiveItemsSkipped: number;
  };
}

export interface LaBonneAlternanceMergeResult {
  places: GooglePlaceCandidate[];
  evidenceByPlaceId: Map<string, OpportunityEvidence[]>;
  keywordsByPlaceId: Map<string, string[]>;
  mergedEmployers: number;
  addedEmployers: number;
}

export class LaBonneAlternanceError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "LaBonneAlternanceError";
    this.code = code;
    this.status = status;
  }
}

export function laBonneAlternanceApiKey(): string | undefined {
  const value = process.env.LBA_API_KEY?.trim();
  return value || undefined;
}

/**
 * Searches the official API Apprentissage endpoint for a server-derived
 * professional profile, with BTS MCO as the safe product fallback.
 * Delegated offers are intentionally discarded because their public workplace
 * is the school/CFA acting as an intermediary, rather than the local employer.
 */
export async function searchLaBonneAlternance(
  origin: Coordinates,
  radiusKm: number,
  apiKey: string,
  options: LaBonneAlternanceOptions = {},
): Promise<LaBonneAlternanceSearchResult> {
  assertSearchInput(origin, radiusKm, apiKey);
  const romeCodes = safeRomeCodesForSearch(options.romeCodes);
  const romeCodeSet = new Set(romeCodes);
  const endpoint = new URL(LBA_SEARCH_ENDPOINT);
  endpoint.searchParams.set("longitude", String(origin.lng));
  endpoint.searchParams.set("latitude", String(origin.lat));
  endpoint.searchParams.set("radius", String(radiusKm));
  endpoint.searchParams.set("romes", romeCodes.join(","));
  endpoint.searchParams.set("target_diploma_level", "5");

  const payload = await fetchJson(
    endpoint,
    apiKey,
    options,
  );
  const now = options.now?.() ?? new Date();
  const records: LaBonneAlternanceEmployer[] = [];
  let delegatedJobsHidden = 0;
  let invalidOrInactiveItemsSkipped = 0;
  let publicOffersIncluded = 0;
  let recruitersIncluded = 0;

  for (const rawJob of payload.jobs) {
    const delegated = delegatedFlag(rawJob);
    if (delegated === true) {
      delegatedJobsHidden += 1;
      continue;
    }

    const parsed = jobSchema.safeParse(rawJob);
    if (!parsed.success) {
      invalidOrInactiveItemsSkipped += 1;
      continue;
    }

    const employer = mapJob(
      parsed.data,
      origin,
      radiusKm,
      now,
      romeCodeSet,
    );
    if (!employer) {
      invalidOrInactiveItemsSkipped += 1;
      continue;
    }
    publicOffersIncluded += 1;
    records.push(employer);
  }

  for (const rawRecruiter of payload.recruiters) {
    const parsed = recruiterSchema.safeParse(rawRecruiter);
    if (!parsed.success) {
      invalidOrInactiveItemsSkipped += 1;
      continue;
    }

    const employer = mapRecruiter(parsed.data, origin, radiusKm, now);
    if (!employer) {
      invalidOrInactiveItemsSkipped += 1;
      continue;
    }
    recruitersIncluded += 1;
    records.push(employer);
  }

  return {
    employers: deduplicateEmployers(records),
    warnings: payload.warnings,
    statistics: {
      jobsReceived: payload.jobs.length,
      recruitersReceived: payload.recruiters.length,
      publicOffersIncluded,
      recruitersIncluded,
      delegatedJobsHidden,
      invalidOrInactiveItemsSkipped,
    },
  };
}

/**
 * Produces the only ROME values that may reach the upstream query. The caller
 * must provide values accepted by the bounded CV profile catalogue; this
 * boundary additionally prevents malformed or oversized upstream requests.
 */
export function safeRomeCodesForSearch(
  candidateCodes: readonly string[] | undefined,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawCode of candidateCodes ?? []) {
    const code = rawCode.trim().toUpperCase();
    if (
      !ROME_CODE_PATTERN.test(code) ||
      !SUPPORTED_ROME_CODES.has(code) ||
      seen.has(code)
    ) {
      continue;
    }
    seen.add(code);
    result.push(code);
    if (result.length >= MAX_ROME_CODES_PER_SEARCH) break;
  }
  return result.length > 0 ? result : [...BTS_MCO_ROME_CODES];
}

/** Merge official opportunities with Maps establishments without duplicating a branch. */
export function mergeLaBonneAlternanceWithGoogle(
  googlePlaces: GooglePlaceCandidate[],
  employers: LaBonneAlternanceEmployer[],
): LaBonneAlternanceMergeResult {
  const places = googlePlaces.map((place) => ({ ...place }));
  const evidenceByPlaceId = new Map<string, OpportunityEvidence[]>();
  const keywordsByPlaceId = new Map<string, string[]>();
  let mergedEmployers = 0;
  let addedEmployers = 0;

  const orderedEmployers = [...employers].sort(
    (left, right) =>
      Number(right.publicOfferCount > 0) - Number(left.publicOfferCount > 0) ||
      left.distanceKm - right.distanceKm,
  );

  for (const employer of orderedEmployers) {
    const placeIndex = findMatchingGooglePlaceIndex(places, employer);
    if (placeIndex >= 0) {
      const place = places[placeIndex];
      places[placeIndex] = {
        ...place,
        ...(place.websiteUrl || !employer.websiteUrl
          ? {}
          : { websiteUrl: employer.websiteUrl }),
      };
      appendEvidence(evidenceByPlaceId, place.placeId, employer.evidence);
      appendKeywords(keywordsByPlaceId, place.placeId, employer.matchedKeywords);
      mergedEmployers += 1;
      continue;
    }

    const placeId = uniqueLbaPlaceId(employer.id, places);
    places.push({
      placeId,
      name: employer.name,
      category: employer.category,
      address: employer.address,
      coordinates: employer.coordinates,
      distanceKm: roundToOneDecimal(employer.distanceKm),
      ...(employer.websiteUrl ? { websiteUrl: employer.websiteUrl } : {}),
      googleMapsUrl: googleMapsSearchUrl(employer.name, employer.coordinates),
    });
    appendEvidence(evidenceByPlaceId, placeId, employer.evidence);
    appendKeywords(keywordsByPlaceId, placeId, employer.matchedKeywords);
    addedEmployers += 1;
  }

  return {
    places,
    evidenceByPlaceId,
    keywordsByPlaceId,
    mergedEmployers,
    addedEmployers,
  };
}

async function fetchJson(
  endpoint: URL,
  apiKey: string,
  options: LaBonneAlternanceOptions,
): Promise<z.infer<typeof responseSchema>> {
  const controller = new AbortController();
  const timeoutMs = clampInteger(options.timeoutMs, REQUEST_TIMEOUT_MS, 500, 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const request = () =>
      (options.fetchImpl ?? proxyFetch)(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        cache: "no-store",
        signal,
      });
    let response = await request();
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      if (retryAfterMs <= 2_000) {
        await response.body?.cancel();
        await abortableDelay(retryAfterMs, signal);
        response = await request();
      }
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        throw new LaBonneAlternanceError(
          "LBA_RATE_LIMITED",
          "La limite de requêtes La Bonne Alternance est atteinte ; réessayez plus tard.",
          response.status,
        );
      }
      throw new LaBonneAlternanceError(
        "LBA_HTTP_ERROR",
        `La Bonne Alternance est indisponible (HTTP ${response.status}).`,
        response.status,
      );
    }

    const contentLength = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new LaBonneAlternanceError(
        "LBA_RESPONSE_TOO_LARGE",
        "La Bonne Alternance a renvoyé une réponse trop volumineuse.",
        response.status,
      );
    }

    const text = await readBoundedResponseText(response, signal);

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new LaBonneAlternanceError(
        "LBA_INVALID_JSON",
        "La Bonne Alternance a renvoyé une réponse illisible.",
        response.status,
        error,
      );
    }

    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) {
      throw new LaBonneAlternanceError(
        "LBA_INVALID_RESPONSE",
        "La Bonne Alternance a renvoyé une réponse incomplète.",
        response.status,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof LaBonneAlternanceError) throw error;
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (controller.signal.aborted) {
      throw new LaBonneAlternanceError(
        "LBA_TIMEOUT",
        "La Bonne Alternance n’a pas répondu à temps.",
        undefined,
        error,
      );
    }
    throw new LaBonneAlternanceError(
      "LBA_NETWORK_ERROR",
      "Impossible de joindre La Bonne Alternance.",
      undefined,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LaBonneAlternanceError(
          "LBA_RESPONSE_TOO_LARGE",
          "La Bonne Alternance a renvoyé une réponse trop volumineuse.",
          response.status,
        );
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
}

function mapJob(
  job: z.infer<typeof jobSchema>,
  origin: Coordinates,
  radiusKm: number,
  now: Date,
  requestedRomeCodes: ReadonlySet<string>,
): LaBonneAlternanceEmployer | undefined {
  if (job.is_delegated || job.offer.status !== "Active") return undefined;
  if (!job.offer.rome_codes.some((code) => requestedRomeCodes.has(code))) {
    return undefined;
  }

  const creation = validDate(job.offer.publication.creation);
  const expiration = validDate(job.offer.publication.expiration);
  if (
    !creation ||
    !expiration ||
    creation.getTime() > now.getTime() + 24 * 60 * 60 * 1_000 ||
    expiration.getTime() <= now.getTime()
  ) {
    return undefined;
  }

  const common = mapWorkplace(job.workplace, origin, radiusKm);
  const applyUrl = safePublicHttpUrl(job.apply.url);
  if (!common || !applyUrl) return undefined;

  const partnerLabel = cleanText(job.identifier.partner_label, 100);
  const identifier =
    cleanText(job.identifier.id ?? "", 180) ||
    `${partnerLabel}:${cleanText(job.identifier.partner_job_id, 180)}`;
  if (!partnerLabel || !identifier) return undefined;

  const contractLabel = job.contract.type.join(" ou ").toLowerCase();
  const description = plainText(job.offer.description, 230);
  const excerpt = [contractLabel ? `Contrat ${contractLabel}.` : "", description]
    .filter(Boolean)
    .join(" ");
  const matchedKeywords = uniqueStrings([
    "alternance",
    ...job.contract.type,
    ...job.offer.rome_codes.map((value) => cleanText(value, 20)),
    ...job.offer.desired_skills.map((value) => cleanText(value, 100)),
    ...job.offer.to_be_acquired_skills.map((value) => cleanText(value, 100)),
    cleanText(job.offer.title, 180),
  ]).slice(0, 24);

  return {
    ...common,
    id: identifier,
    evidence: [
      {
        level: "public-offer",
        title: cleanText(job.offer.title, 180) || "Offre d’alternance",
        url: applyUrl,
        excerpt,
        confidence: 0.98,
        sourceKind: "official-job-service",
        sourceLabel: `La Bonne Alternance · diffuseur : ${partnerLabel}`,
        // The employer is named, but publication is relayed by an official service.
        directEmployer: false,
        specificity: "specific",
        publishedAt: creation.toISOString(),
        validThrough: expiration.toISOString(),
        retrievedAt: now.toISOString(),
        locationText: common.address,
      },
    ],
    matchedKeywords,
    publicOfferCount: 1,
    recruiterSignal: false,
  };
}

function mapRecruiter(
  recruiter: z.infer<typeof recruiterSchema>,
  origin: Coordinates,
  radiusKm: number,
  now: Date,
): LaBonneAlternanceEmployer | undefined {
  const common = mapWorkplace(recruiter.workplace, origin, radiusKm);
  const applyUrl = safePublicHttpUrl(recruiter.apply.url);
  const identifier = cleanText(recruiter.identifier.id, 180);
  if (!common || !applyUrl || !identifier) return undefined;

  return {
    ...common,
    id: identifier,
    evidence: [
      {
        level: "prospecting",
        title: `Candidature spontanée chez ${common.name}`,
        url: applyUrl,
        excerpt:
          "Entreprise signalée par La Bonne Alternance comme susceptible de recruter des apprentis dans ce domaine, sans offre publiée.",
        confidence: 0.78,
        sourceKind: "official-job-service",
        sourceLabel: "La Bonne Alternance",
        directEmployer: false,
        specificity: "generic",
        retrievedAt: now.toISOString(),
        locationText: common.address,
      },
    ],
    matchedKeywords: ["candidature spontanée", "alternance"],
    publicOfferCount: 0,
    recruiterSignal: true,
  };
}

function mapWorkplace(
  workplace: z.infer<typeof workplaceSchema>,
  origin: Coordinates,
  radiusKm: number,
): Omit<
  LaBonneAlternanceEmployer,
  | "id"
  | "evidence"
  | "matchedKeywords"
  | "publicOfferCount"
  | "recruiterSignal"
> | undefined {
  const aliases = uniqueStrings([
    workplace.brand,
    workplace.name,
    workplace.legal_name,
  ]).map((value) => cleanText(value, 180));
  const name = aliases.find(Boolean);
  const address = cleanText(workplace.location.address, 260);
  const [lng, lat] = workplace.location.geopoint.coordinates;
  const coordinates = { lat, lng };
  if (!name || !address || !validCoordinates(coordinates)) return undefined;

  const distanceKm = haversineDistanceKm(origin, coordinates);
  if (!Number.isFinite(distanceKm) || distanceKm > radiusKm + LOCATION_TOLERANCE_KM) {
    return undefined;
  }

  const category =
    cleanText(workplace.domain?.naf?.label ?? "", 140) ||
    "Employeur potentiel — alternance";
  const websiteUrl = safePublicHttpUrl(workplace.website ?? undefined);

  return {
    name,
    aliases,
    category,
    address,
    coordinates,
    distanceKm,
    ...(workplace.siret ? { siret: workplace.siret } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
  };
}

function deduplicateEmployers(
  employers: LaBonneAlternanceEmployer[],
): LaBonneAlternanceEmployer[] {
  const byEstablishment = new Map<string, LaBonneAlternanceEmployer>();

  for (const employer of employers) {
    const key = employerKey(employer);
    const existing = byEstablishment.get(key);
    if (!existing) {
      byEstablishment.set(key, employer);
      continue;
    }

    const preferred =
      employer.publicOfferCount > existing.publicOfferCount ? employer : existing;
    const fallback = preferred === employer ? existing : employer;
    byEstablishment.set(key, {
      ...fallback,
      ...preferred,
      aliases: uniqueStrings([...preferred.aliases, ...fallback.aliases]),
      evidence: deduplicateEvidence([
        ...preferred.evidence,
        ...fallback.evidence,
      ]).slice(0, MAX_EVIDENCE_PER_EMPLOYER),
      matchedKeywords: uniqueStrings([
        ...preferred.matchedKeywords,
        ...fallback.matchedKeywords,
      ]).slice(0, 40),
      publicOfferCount:
        preferred.publicOfferCount + fallback.publicOfferCount,
      recruiterSignal:
        preferred.recruiterSignal || fallback.recruiterSignal,
      ...(preferred.websiteUrl || fallback.websiteUrl
        ? { websiteUrl: preferred.websiteUrl ?? fallback.websiteUrl }
        : {}),
    });
  }

  return [...byEstablishment.values()].sort(
    (left, right) =>
      Number(right.publicOfferCount > 0) - Number(left.publicOfferCount > 0) ||
      right.publicOfferCount - left.publicOfferCount ||
      left.distanceKm - right.distanceKm,
  );
}

function findMatchingGooglePlaceIndex(
  places: GooglePlaceCandidate[],
  employer: LaBonneAlternanceEmployer,
): number {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  const employerNames = employer.aliases
    .map(normalizeCompanyName)
    .filter(Boolean);
  const employerPostcode = postcode(employer.address);
  const employerStreetNumber = streetNumber(employer.address);
  const employerStreet = streetName(employer.address);

  places.forEach((place, index) => {
    if (!place.googlePlaceId) return;
    const separationKm = haversineDistanceKm(
      place.coordinates,
      employer.coordinates,
    );
    if (separationKm > 1) return;

    const placeName = normalizeCompanyName(place.name);
    if (!placeName) return;
    const placePostcode = postcode(place.address);
    const samePostcode =
      Boolean(employerPostcode) && employerPostcode === placePostcode;
    const placeStreetNumber = streetNumber(place.address);
    const placeStreet = streetName(place.address);
    const sameAddressAnchor =
      samePostcode &&
      Boolean(employerStreetNumber) &&
      employerStreetNumber === placeStreetNumber &&
      streetsConcordant(employerStreet, placeStreet);
    const conflictingAddressAnchor = addressesConflict(
      {
        postcode: employerPostcode,
        streetNumber: employerStreetNumber,
        street: employerStreet,
      },
      {
        postcode: placePostcode,
        streetNumber: placeStreetNumber,
        street: placeStreet,
      },
    );

    let nameScore = 0;
    for (const employerName of employerNames) {
      if (employerName === placeName) {
        nameScore = Math.max(nameScore, 1);
      } else if (
        Math.min(employerName.length, placeName.length) >= 4 &&
        (employerName.includes(placeName) || placeName.includes(employerName))
      ) {
        nameScore = Math.max(nameScore, 0.86);
      } else {
        nameScore = Math.max(nameScore, tokenSimilarity(employerName, placeName));
      }
    }

    const credibleMatch =
      (sameAddressAnchor && nameScore >= 0.67) ||
      (separationKm <= NEAR_EXACT_LOCATION_KM &&
        nameScore >= 0.85 &&
        !conflictingAddressAnchor);
    if (!credibleMatch) return;

    // A complete matching address is stronger than upstream geocoding. This
    // matters for two nearby branches of the same chain: a slightly imprecise
    // LBA geopoint must not move an offer to the neighbouring establishment.
    const score =
      nameScore * 10 +
      (sameAddressAnchor ? 100 : 0) +
      (samePostcode ? 1 : 0) -
      separationKm;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function employerKey(employer: LaBonneAlternanceEmployer): string {
  if (employer.siret) return `siret:${employer.siret}`;
  return [
    normalizeCompanyName(employer.name),
    employer.coordinates.lat.toFixed(3),
    employer.coordinates.lng.toFixed(3),
  ].join(":");
}

function delegatedFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const flag = (value as { is_delegated?: unknown }).is_delegated;
  return typeof flag === "boolean" ? flag : undefined;
}

function appendEvidence(
  map: Map<string, OpportunityEvidence[]>,
  placeId: string,
  evidence: OpportunityEvidence[],
): void {
  map.set(
    placeId,
    deduplicateEvidence([...(map.get(placeId) ?? []), ...evidence]).slice(
      0,
      MAX_EVIDENCE_PER_EMPLOYER,
    ),
  );
}

function appendKeywords(
  map: Map<string, string[]>,
  placeId: string,
  keywords: string[],
): void {
  map.set(placeId, uniqueStrings([...(map.get(placeId) ?? []), ...keywords]));
}

function deduplicateEvidence(
  evidence: OpportunityEvidence[],
): OpportunityEvidence[] {
  const byKey = new Map<string, OpportunityEvidence>();
  for (const item of evidence) {
    const key = `${item.url}|${normalizeText(item.title)}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      evidencePriority(right) - evidencePriority(left) ||
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
  );
}

function evidencePriority(evidence: OpportunityEvidence): number {
  if (evidence.level === "public-offer") return 3;
  if (evidence.level === "recruitment-page") return 2;
  return 1;
}

function uniqueLbaPlaceId(
  identifier: string,
  places: GooglePlaceCandidate[],
): string {
  const base = `lba:${encodeURIComponent(identifier).slice(0, 220)}`;
  const ids = new Set(places.map(({ placeId }) => placeId));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

function googleMapsSearchUrl(name: string, coordinates: Coordinates): string {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set(
    "query",
    `${name} ${coordinates.lat},${coordinates.lng}`,
  );
  return url.toString();
}

function normalizeCompanyName(value: string): string {
  const corporateTerms = new Set([
    "sas",
    "sasu",
    "sarl",
    "eurl",
    "sa",
    "societe",
    "groupe",
    "france",
  ]);
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !corporateTerms.has(token))
    .join(" ");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter((token) => token.length >= 3));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length >= 3));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  const union = new Set([...leftTokens, ...rightTokens]);
  return intersection.length / union.size;
}

function postcode(value: string): string | undefined {
  return value.match(/\b(?:0[1-9]|[1-8]\d|9[0-5]|97[1-6])\d{3}\b/)?.[0];
}

function streetNumber(value: string): string | undefined {
  return normalizeText(value)
    .match(
      /\b(\d{1,4}(?:\s*(?:bis|ter|quater|[a-d]))?)\s+(?=(?:allee|all|avenue|av|boulevard|bd|bld|chemin|ch|cours|impasse|passage|place|quai|route|rte|rue|square|voie)\b)/,
    )?.[1]
    ?.replace(/\s+/g, "")
    .toLowerCase();
}

interface AddressAnchor {
  postcode?: string;
  streetNumber?: string;
  street?: string;
}

function streetName(value: string): string | undefined {
  const normalized = normalizeText(value);
  const postalCode = postcode(value);
  const beforePostcode = postalCode
    ? normalized.slice(0, normalized.indexOf(postalCode))
    : normalized;
  const tokens = beforePostcode.split(" ").filter(Boolean);
  const streetTypeAliases = new Map<string, string>([
    ["allee", "allee"],
    ["all", "allee"],
    ["avenue", "avenue"],
    ["av", "avenue"],
    ["boulevard", "boulevard"],
    ["bd", "boulevard"],
    ["bld", "boulevard"],
    ["chemin", "chemin"],
    ["ch", "chemin"],
    ["cours", "cours"],
    ["impasse", "impasse"],
    ["passage", "passage"],
    ["place", "place"],
    ["quai", "quai"],
    ["route", "route"],
    ["rte", "route"],
    ["rue", "rue"],
    ["square", "square"],
    ["voie", "voie"],
  ]);
  const streetStart = tokens.findIndex((token) => streetTypeAliases.has(token));
  if (streetStart < 0) return undefined;

  const connectors = new Set(["d", "de", "des", "du", "l", "la", "le", "les"]);
  const streetTokens = tokens
    .slice(streetStart)
    .map((token, index) =>
      index === 0 ? (streetTypeAliases.get(token) ?? token) : token,
    )
    .filter((token, index) => index === 0 || !connectors.has(token));

  return streetTokens.length >= 2 ? streetTokens.join(" ") : undefined;
}

function streetsConcordant(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;

  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersectionSize = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  return (
    left.split(" ")[0] === right.split(" ")[0] &&
    intersectionSize >= 2 &&
    intersectionSize / Math.min(leftTokens.size, rightTokens.size) >= 0.8
  );
}

function addressesConflict(left: AddressAnchor, right: AddressAnchor): boolean {
  if (left.postcode && right.postcode && left.postcode !== right.postcode) {
    return true;
  }
  if (
    left.streetNumber &&
    right.streetNumber &&
    left.streetNumber !== right.streetNumber
  ) {
    return true;
  }
  return Boolean(
    left.street &&
      right.street &&
      !streetsConcordant(left.street, right.street),
  );
}

function validDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 250;
  return Math.max(0, date.getTime() - Date.now());
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function plainText(value: string, maxLength: number): string {
  return cleanText(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;|&#34;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
    maxLength,
  );
}

function cleanText(value: string, maxLength: number): string {
  const compact = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = typeof raw === "string" ? raw.trim() : "";
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function validCoordinates(value: Coordinates): boolean {
  return (
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    value.lng >= -180 &&
    value.lng <= 180
  );
}

function assertSearchInput(
  origin: Coordinates,
  radiusKm: number,
  apiKey: string,
): void {
  if (!validCoordinates(origin)) {
    throw new LaBonneAlternanceError(
      "LBA_INVALID_COORDINATES",
      "Les coordonnées de recherche sont invalides.",
    );
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 0 || radiusKm > 200) {
    throw new LaBonneAlternanceError(
      "LBA_INVALID_RADIUS",
      "Le rayon La Bonne Alternance doit être compris entre 0 et 200 km.",
    );
  }
  if (!apiKey.trim()) {
    throw new LaBonneAlternanceError(
      "LBA_API_KEY_MISSING",
      "La clé serveur La Bonne Alternance n’est pas configurée.",
    );
  }
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value as number)));
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
