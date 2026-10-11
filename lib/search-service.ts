import { createDemoData, type DemoEmployer } from "@/lib/demo-data";
import {
  CV_PROFILE_ROME_CODES,
  deriveRomeCodesForProfile,
} from "@/lib/cv-profile";
import {
  computeGoogleRouteMatrix,
  googlePlaceTypesForProfile,
  googleMapsApiKey,
  resolveGoogleOrigin,
  searchNearbyGooglePlacesDetailed,
  type GooglePlaceCandidate,
} from "@/lib/google-maps";
import {
  laBonneAlternanceApiKey,
  mergeLaBonneAlternanceWithGoogle,
  searchLaBonneAlternance,
  type LaBonneAlternanceSearchResult,
} from "@/lib/la-bonne-alternance";
import { scoreEmployerMatch } from "@/lib/scoring";
import { searchInputSchema } from "@/lib/search-schema";
import { inspectEmployerWebsite } from "@/lib/site-scanner";
import type {
  CandidateProfile,
  EmployerMatch,
  OpportunityEvidence,
  SearchCoverage,
  SearchInput,
  SearchPersonalization,
  SearchResponse,
  SiteInspection,
  TravelEstimate,
  TravelMode,
} from "@/lib/types";

const DEFAULT_WEBSITES_PER_SEARCH = 40;
const MAX_WEBSITES_PER_SEARCH = 40;
const WEBSITE_SCAN_CONCURRENCY = 8;
const WEBSITE_SCAN_PHASE_BUDGET_MS = 24_000;
const MAX_CONCURRENT_WEBSITE_INSPECTIONS = 16;
const MAX_EMPLOYER_BUDGET = 40;

type ReleaseSemaphore = () => void;

interface SemaphoreWaiter {
  signal?: AbortSignal;
  resolve: (release: ReleaseSemaphore) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

/** Bounds crawler work across every search handled by this server instance. */
class AbortableSemaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<ReleaseSemaphore> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<ReleaseSemaphore>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) {
          waiter.onAbort();
          return;
        }
      }
      this.waiters.push(waiter);
    });
  }

  private createRelease(): ReleaseSemaphore {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

const websiteInspectionSemaphore = new AbortableSemaphore(
  MAX_CONCURRENT_WEBSITE_INSPECTIONS,
);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

interface WebsiteInspectionBatch {
  inspections: Map<string, SiteInspection>;
  timeLimitReached: boolean;
}

export interface SearchExecutionOptions {
  signal?: AbortSignal;
  /** Hard cap applied before Routes calls and public website inspections. */
  maxEmployers?: number;
}

export async function searchEmployers(
  input: SearchInput,
  options: SearchExecutionOptions = {},
): Promise<SearchResponse> {
  options.signal?.throwIfAborted();
  const validatedInput: SearchInput = searchInputSchema.parse(input);
  const profile = resolveCandidateProfile(validatedInput);
  const apiKey = googleMapsApiKey();
  const maxEmployers = normalizeEmployerBudget(options.maxEmployers);

  if (!apiKey) {
    options.signal?.throwIfAborted();
    return createDemoResponse(validatedInput, profile, maxEmployers);
  }

  const origin = await resolveGoogleOrigin(validatedInput.origin, apiKey, {
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const lbaKey = laBonneAlternanceApiKey();
  const hasProfileWithoutRomeCodes = Boolean(
    profile && profile.romeCodes.length === 0,
  );
  const lbaSearchKey = hasProfileWithoutRomeCodes ? undefined : lbaKey;
  const [googleNearbyOutcome, lbaOutcome] = await Promise.all([
    fetchGoogleNearbySafely(
      origin.coordinates,
      validatedInput.radiusKm,
      apiKey,
      profile,
      options.signal,
    ),
    fetchLaBonneAlternanceSafely(
      origin.coordinates,
      validatedInput.radiusKm,
      lbaSearchKey,
      profile?.romeCodes,
      options.signal,
    ),
  ]);
  options.signal?.throwIfAborted();
  if (!googleNearbyOutcome.result && !lbaOutcome.result) {
    throw googleNearbyOutcome.error instanceof Error
      ? googleNearbyOutcome.error
      : new Error("Aucune source d’employeurs n’est disponible.");
  }
  const googleNearbyUnavailable = !googleNearbyOutcome.result;
  const googleNearby = googleNearbyOutcome.result ?? {
    places: [],
    failedGroups: [],
  };
  const lbaMerge = lbaOutcome.result
    ? mergeLaBonneAlternanceWithGoogle(
        googleNearby.places,
        lbaOutcome.result.employers,
      )
    : emptyLaBonneAlternanceMerge(googleNearby.places);
  const uncappedEmployerCount = lbaMerge.places.length;
  const places = limitEmployerCandidates(
    lbaMerge.places,
    maxEmployers,
    lbaMerge.evidenceByPlaceId,
  );
  options.signal?.throwIfAborted();
  const failedGroups = googleNearby.failedGroups;
  const siteScanEnabled = isSiteScanEnabled();
  const siteScanLimit = readSiteScanLimit();
  const [routeOutcome, websiteInspectionBatch] = await Promise.all([
    computeGoogleRouteMatrix(
      origin.coordinates,
      places,
      validatedInput.travelModes,
      apiKey,
      { signal: options.signal },
    ),
    inspectCandidateWebsites(
      places,
      siteScanEnabled,
      siteScanLimit,
      profile,
      options.signal,
    ),
  ]);
  options.signal?.throwIfAborted();
  const { travelByPlaceId, failedModes } = routeOutcome;
  const { inspections, timeLimitReached: siteScanTimeLimitReached } =
    websiteInspectionBatch;

  const results = places
    .map((place) =>
      createEmployerMatch(
        place,
        travelByPlaceId.get(place.placeId) ?? {},
        mergeOfficialEvidence(
          inspections.get(place.placeId) ?? notRequestedInspection(),
          lbaMerge.evidenceByPlaceId.get(place.placeId) ?? [],
          lbaMerge.keywordsByPlaceId.get(place.placeId) ?? [],
        ),
        profile,
        false,
      ),
    )
    .sort(compareMatches);

  const websitesDiscovered = places.filter((place) => place.websiteUrl).length;
  const googleOnlyNotice = siteScanEnabled
    ? "Mode réel : les établissements et les trajets proviennent de Google Maps ; l’application contrôle aussi les sites publics connus des employeurs retenus."
    : "Mode réel : les établissements et les trajets proviennent de Google Maps. L’analyse des sites employeurs est désactivée sur ce serveur.";
  const notices = [
    googleNearbyUnavailable
      ? "Mode réel : La Bonne Alternance est la seule source d’employeurs disponible pour cette recherche ; Google Maps reste utilisé pour les trajets des pistes renvoyées."
      : lbaOutcome.result
      ? "Mode réel : les établissements et trajets proviennent de Google Maps, enrichis par les offres et recruteurs de l’API publique La Bonne Alternance."
      : googleOnlyNotice,
    "Vérifiez toujours l’offre et les conditions de l’alternance sur la source indiquée avant de candidater.",
  ];

  if (lbaOutcome.result) {
    const { statistics, warnings } = lbaOutcome.result;
    if (statistics.publicOffersIncluded > 0 || statistics.recruitersIncluded > 0) {
      notices.push(
        `La Bonne Alternance a fourni ${statistics.publicOffersIncluded} offre${statistics.publicOffersIncluded > 1 ? "s" : ""} active${statistics.publicOffersIncluded > 1 ? "s" : ""} et ${statistics.recruitersIncluded} piste${statistics.recruitersIncluded > 1 ? "s" : ""} de candidature spontanée ; ${lbaMerge.mergedEmployers} entreprise${lbaMerge.mergedEmployers > 1 ? "s ont" : " a"} été rapprochée${lbaMerge.mergedEmployers > 1 ? "s" : ""} d’un établissement Google Maps.`,
      );
    }
    if (statistics.delegatedJobsHidden > 0) {
      notices.push(
        `${statistics.delegatedJobsHidden} offre${statistics.delegatedJobsHidden > 1 ? "s portées" : " portée"} par une école ou un CFA ${statistics.delegatedJobsHidden > 1 ? "ont été masquées" : "a été masquée"}, car l’adresse publiée n’est pas celle de l’employeur.`,
      );
    }
    if (warnings.length > 0) {
      notices.push(
        `La couverture La Bonne Alternance est partielle (${warnings.map(({ code }) => code).join(", ")}).`,
      );
    }
  } else if (!lbaKey) {
    notices.push(
      siteScanEnabled
        ? "La Bonne Alternance n’est pas configurée sur ce serveur : la recherche reste limitée à Google Maps et aux sites publics connus des employeurs retenus."
        : "La Bonne Alternance n’est pas configurée sur ce serveur : la recherche reste limitée à Google Maps.",
    );
  } else if (hasProfileWithoutRomeCodes) {
    notices.push(
      siteScanEnabled
        ? "La Bonne Alternance n’a pas été interrogée, car aucun code ROME assez fiable n’est associé au profil corrigé. Les résultats restent issus de Google Maps et des sites publics connus des employeurs retenus."
        : "La Bonne Alternance n’a pas été interrogée, car aucun code ROME assez fiable n’est associé au profil corrigé. Les résultats restent issus de Google Maps.",
    );
  } else if (lbaOutcome.error) {
    notices.push(
      siteScanEnabled
        ? "La source La Bonne Alternance était momentanément indisponible ; les résultats Google Maps et les indices issus des sites employeurs consultés restent affichés."
        : "La source La Bonne Alternance était momentanément indisponible ; les résultats Google Maps restent affichés.",
    );
  }

  if (googleNearbyUnavailable) {
    notices.push(
      "La recherche d’établissements Google Maps était indisponible ; la couverture est partielle et repose ici sur La Bonne Alternance.",
    );
  }

  if (places.length === 0) {
    notices.push(
      "Aucun commerce correspondant n’a été renvoyé dans ce rayon. Essayez un rayon plus large ou une autre adresse.",
    );
  }
  if (uncappedEmployerCount > places.length) {
    notices.push(
      `Pour maîtriser le coût et le délai de la recherche, ${places.length} entreprises prioritaires ont été retenues sur ${uncappedEmployerCount} avant le calcul des trajets${siteScanEnabled ? " et l’analyse des sites" : ""}.`,
    );
  }
  if (failedGroups.length > 0) {
    notices.push(
      `La recherche Google Maps est partielle pour : ${failedGroups.map(({ label }) => label).join(", ")}. Les autres catégories restent affichées.`,
    );
  }
  if (!siteScanEnabled && websitesDiscovered > 0) {
    notices.push(
      "L’analyse des sites employeurs est désactivée dans la configuration du serveur.",
    );
  } else if (websitesDiscovered > siteScanLimit) {
    notices.push(
      `Pour garder un délai raisonnable, jusqu’à ${siteScanLimit} sites parmi les mieux classés ont été retenus pour inspection sur ${websitesDiscovered} sites trouvés.`,
    );
  }
  if (siteScanTimeLimitReached) {
    notices.push(
      "La limite de temps réservée à l’analyse des sites a été atteinte. Les contrôles terminés restent affichés et les autres sites sont signalés comme non inspectés pendant cette recherche.",
    );
  }
  if (failedModes.length > 0) {
    notices.push(
      `Google Maps n’a pas pu calculer certains trajets : ${formatTravelModes(failedModes)}.`,
    );
  }
  if (
    validatedInput.travelModes.includes("TRANSIT") ||
    validatedInput.travelModes.includes("DRIVE") ||
    validatedInput.travelModes.includes("TWO_WHEELER")
  ) {
    notices.push(
      "Les trajets dépendant des horaires ou du trafic sont estimés pour le prochain jour ouvré à 8 h 30, heure de Paris.",
    );
  }
  if (
    validatedInput.travelModes.includes("WALK") ||
    validatedInput.travelModes.includes("BICYCLE") ||
    validatedInput.travelModes.includes("TWO_WHEELER")
  ) {
    notices.push(
      "Les itinéraires à pied, à vélo et en deux-roues motorisé de Google Maps sont en version bêta. Soyez prudent et vérifiez les conditions réelles du trajet.",
    );
  }
  if (profile) {
    notices.push(
      `Recherche personnalisée à partir du profil CV « ${profile.headline} » : les métiers, compétences et secteurs retenus influencent la couverture et le classement${profile.romeCodes.length > 0 ? "; les codes ROME ciblent aussi les offres publiques" : ""}.`,
    );
  }

  return {
    mode: "live",
    partial:
      googleNearbyUnavailable ||
      failedGroups.length > 0 ||
      failedModes.length > 0 ||
      siteScanTimeLimitReached ||
      lbaOutcome.error === true ||
      (lbaOutcome.result?.warnings.length ?? 0) > 0,
    origin,
    radiusKm: validatedInput.radiusKm,
    generatedAt: new Date().toISOString(),
    results,
    coverage: calculateCoverage(results),
    personalization: searchPersonalization(profile),
    notices,
  };
}

function createDemoResponse(
  input: SearchInput,
  profile: CandidateProfile | undefined,
  maxEmployers: number | undefined,
): SearchResponse {
  const { origin, employers } = createDemoData(input);
  const rankedResults = employers
    .map((employer) => createDemoEmployerMatch(employer, profile))
    .sort(compareMatches);
  const results =
    maxEmployers === undefined
      ? rankedResults
      : rankedResults.slice(0, maxEmployers);
  const notices = [
    "Mode démonstration : tous les employeurs, adresses, sites, offres et temps de trajet affichés sont fictifs.",
    "Ajoutez GOOGLE_MAPS_SERVER_API_KEY à l’environnement serveur pour activer les établissements et trajets Google Maps réels.",
    "Ajoutez aussi LBA_API_KEY pour inclure les offres et recruteurs potentiels de La Bonne Alternance dans la recherche réelle.",
  ];

  if (input.origin.kind === "address") {
    notices.push(
      "L’adresse saisie n’a pas été envoyée à Google ni géocodée ; le scénario fictif est centré sur une position de démonstration.",
    );
  }
  if (profile) {
    notices.push(
      `Le classement fictif est personnalisé pour le profil CV « ${profile.headline} » ; en mode réel, ce profil cible aussi les secteurs Google Maps${profile.romeCodes.length > 0 ? " et les métiers ROME" : ""}.`,
    );
  }

  return {
    mode: "demo",
    partial: false,
    origin,
    radiusKm: input.radiusKm,
    generatedAt: new Date().toISOString(),
    results,
    coverage: calculateCoverage(results),
    personalization: searchPersonalization(profile),
    notices,
  };
}

function createDemoEmployerMatch(
  employer: DemoEmployer,
  profile: CandidateProfile | undefined,
): EmployerMatch {
  return createEmployerMatch(
    employer,
    employer.travel,
    employer.siteInspection,
    profile,
    true,
  );
}

function createEmployerMatch(
  place: GooglePlaceCandidate,
  travel: Partial<Record<TravelMode, TravelEstimate>>,
  siteInspection: SiteInspection,
  profile: CandidateProfile | undefined,
  isDemo: boolean,
): EmployerMatch {
  const scored = scoreEmployerMatch({
    name: place.name,
    category: place.category,
    placeTypes: place.placeTypes,
    websiteUrl: place.websiteUrl,
    siteInspection,
    travel,
    profile,
  });
  const caution = buildCaution(siteInspection, isDemo);

  return {
    id: place.placeId,
    name: place.name,
    category: place.category,
    address: place.address,
    coordinates: place.coordinates,
    distanceKm: place.distanceKm,
    ...(place.rating !== undefined ? { rating: place.rating } : {}),
    ...(place.reviewCount !== undefined
      ? { reviewCount: place.reviewCount }
      : {}),
    ...(place.websiteUrl ? { websiteUrl: place.websiteUrl } : {}),
    googleMapsUrl: place.googleMapsUrl,
    travel,
    opportunityLevel: scored.opportunityLevel,
    applicationPotential: scored.applicationPotential,
    siteInspection,
    score: scored.score,
    reasons: scored.reasons,
    ...(caution ? { caution } : {}),
    ...(isDemo ? { isDemo: true } : {}),
  };
}

async function inspectCandidateWebsites(
  places: GooglePlaceCandidate[],
  enabled: boolean,
  limit: number,
  profile: CandidateProfile | undefined,
  signal?: AbortSignal,
): Promise<WebsiteInspectionBatch> {
  signal?.throwIfAborted();
  const inspections = new Map<string, SiteInspection>();
  if (!enabled) {
    for (const place of places) {
      inspections.set(
        place.placeId,
        notRequestedInspection("Analyse du site désactivée sur ce serveur."),
      );
    }
    return { inspections, timeLimitReached: false };
  }

  const candidates = selectWebsiteScanCandidates(places, limit);

  for (const place of places) {
    if (!place.websiteUrl) {
      inspections.set(
        place.placeId,
        notRequestedInspection(
          "Aucun site internet public n’est indiqué par les sources consultées.",
        ),
      );
    }
  }

  if (candidates.length === 0) {
    return { inspections, timeLimitReached: false };
  }

  const phaseController = new AbortController();
  const scanSignal = signal
    ? AbortSignal.any([signal, phaseController.signal])
    : phaseController.signal;
  let timeLimitReached = false;
  let acceptResults = true;
  let resolveTimeLimit: (() => void) | undefined;
  const timeLimitPromise = new Promise<void>((resolve) => {
    resolveTimeLimit = resolve;
  });
  const timeLimit = setTimeout(() => {
    timeLimitReached = true;
    phaseController.abort(
      new DOMException(
        "Website inspection phase exceeded its time budget",
        "TimeoutError",
      ),
    );
    resolveTimeLimit?.();
  }, WEBSITE_SCAN_PHASE_BUDGET_MS);
  timeLimit.unref?.();

  let onClientAbort: (() => void) | undefined;
  const clientAbortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        onClientAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onClientAbort, { once: true });
        if (signal.aborted) onClientAbort();
      })
    : undefined;

  const scanTasks = mapWithConcurrency(
    candidates,
    WEBSITE_SCAN_CONCURRENCY,
    async (place) => {
      if (scanSignal.aborted) {
        if (signal?.aborted) signal.throwIfAborted();
        return;
      }
      let release: ReleaseSemaphore | undefined;
      try {
        release = await websiteInspectionSemaphore.acquire(scanSignal);
        scanSignal.throwIfAborted();
        const inspection = await inspectEmployerWebsite(place.websiteUrl, {
          timeoutMs: 2_000,
          totalTimeoutMs: 6_000,
          maxPages: 2,
          signal: scanSignal,
          professionalKeywords: professionalKeywordsForProfile(profile),
          targetRoles: targetRolesForProfile(profile),
          expectedEmployerName: place.name,
          expectedLocationText: place.address,
        });
        if (acceptResults && !scanSignal.aborted) {
          inspections.set(place.placeId, inspection);
        }
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        if (!phaseController.signal.aborted && acceptResults) {
          inspections.set(place.placeId, {
            status: "unreachable",
            checkedAt: new Date().toISOString(),
            pagesChecked: 0,
            evidence: [],
            matchedKeywords: [],
            note: "Le site n’a pas pu être analysé pendant cette recherche.",
          });
        }
      } finally {
        release?.();
      }
    },
  );

  try {
    await Promise.race([
      scanTasks,
      timeLimitPromise,
      ...(clientAbortPromise ? [clientAbortPromise] : []),
    ]);
    signal?.throwIfAborted();
  } finally {
    acceptResults = false;
    clearTimeout(timeLimit);
    if (signal && onClientAbort) {
      signal.removeEventListener("abort", onClientAbort);
    }
    resolveTimeLimit = undefined;
  }

  const selectedPlaceIds = new Set(candidates.map(({ placeId }) => placeId));

  for (const place of places) {
    if (!inspections.has(place.placeId)) {
      inspections.set(
        place.placeId,
        notRequestedInspection(
          timeLimitReached && selectedPlaceIds.has(place.placeId)
            ? "Site non inspecté car la limite de temps de cette recherche a été atteinte."
            : "Site non inspecté pendant cette recherche en raison de la limite d’analyse.",
        ),
      );
    }
  }

  return { inspections, timeLimitReached };
}

function professionalKeywordsForProfile(
  profile: CandidateProfile | undefined,
): string[] {
  if (!profile) return [];
  return normalizedValues(profile.skills).slice(0, 40);
}

function targetRolesForProfile(
  profile: CandidateProfile | undefined,
): string[] {
  return profile ? normalizedValues(profile.targetRoles).slice(0, 12) : [];
}

/**
 * Retains official opportunities first, then preserves the provider's stable
 * relevance order. This cap is applied before any per-employer paid work.
 */
export function limitEmployerCandidates(
  places: GooglePlaceCandidate[],
  limit: number | undefined,
  evidenceByPlaceId: ReadonlyMap<string, OpportunityEvidence[]> = new Map(),
): GooglePlaceCandidate[] {
  if (limit === undefined || places.length <= limit) return places;

  const ranked = places.map((place, index) => ({
    place,
    index,
    evidencePriority: Math.max(
      0,
      ...(evidenceByPlaceId.get(place.placeId) ?? []).map(
        opportunityEvidencePriority,
      ),
    ),
  }));
  const selected = ranked
    .filter(({ evidencePriority }) => evidencePriority > 0)
    .sort(
      (left, right) =>
        right.evidencePriority - left.evidencePriority ||
        left.index - right.index,
    )
    .slice(0, limit);
  if (selected.length >= limit) return selected.map(({ place }) => place);

  const selectedIds = new Set(selected.map(({ place }) => place.placeId));
  const buckets = new Map<string, typeof ranked>();
  for (const entry of ranked) {
    if (selectedIds.has(entry.place.placeId)) continue;
    const group = entry.place.searchGroup ?? "external";
    const bucket = buckets.get(group) ?? [];
    bucket.push(entry);
    buckets.set(group, bucket);
  }

  let offset = 0;
  while (selected.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      const entry = bucket[offset];
      if (!entry) continue;
      selected.push(entry);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
    offset += 1;
  }

  return selected.map(({ place }) => place);
}

/** Selects websites evenly across Maps cohorts before filling the scan budget. */
export function selectWebsiteScanCandidates(
  places: GooglePlaceCandidate[],
  limit: number,
): Array<GooglePlaceCandidate & { websiteUrl: string }> {
  const candidates = places.filter(
    (place): place is GooglePlaceCandidate & { websiteUrl: string } =>
      Boolean(place.websiteUrl),
  );
  const buckets = new Map<
    string,
    Array<GooglePlaceCandidate & { websiteUrl: string }>
  >();

  for (const candidate of candidates) {
    const key = candidate.searchGroup ?? "external";
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }

  const selected: Array<GooglePlaceCandidate & { websiteUrl: string }> = [];
  let offset = 0;
  while (selected.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      const candidate = bucket[offset];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= limit) return selected;
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await task(item);
      }
    }),
  );
}

function notRequestedInspection(note?: string): SiteInspection {
  return {
    status: "not-requested",
    pagesChecked: 0,
    evidence: [],
    matchedKeywords: [],
    ...(note ? { note } : {}),
  };
}

type LaBonneAlternanceOutcome =
  | { result: LaBonneAlternanceSearchResult; error?: never }
  | { result?: never; error: true }
  | { result?: never; error?: never };

type GoogleNearbyOutcome =
  | {
      result: Awaited<ReturnType<typeof searchNearbyGooglePlacesDetailed>>;
      error?: never;
    }
  | { result?: never; error: unknown };

async function fetchGoogleNearbySafely(
  coordinates: { lat: number; lng: number },
  radiusKm: number,
  apiKey: string,
  profile: CandidateProfile | undefined,
  signal?: AbortSignal,
): Promise<GoogleNearbyOutcome> {
  signal?.throwIfAborted();
  try {
    const result = await searchNearbyGooglePlacesDetailed(
      coordinates,
      radiusKm,
      apiKey,
      {
        preferredPlaceTypes: googlePlaceTypesForProfile(profile),
        signal,
      },
    );
    signal?.throwIfAborted();
    return { result };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    console.warn("Google Places search failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return { error };
  }
}

async function fetchLaBonneAlternanceSafely(
  coordinates: { lat: number; lng: number },
  radiusKm: number,
  apiKey: string | undefined,
  romeCodes: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<LaBonneAlternanceOutcome> {
  if (!apiKey) return {};
  signal?.throwIfAborted();
  try {
    const result = await searchLaBonneAlternance(
      coordinates,
      radiusKm,
      apiKey,
      { romeCodes, signal },
    );
    signal?.throwIfAborted();
    return { result };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    console.warn("La Bonne Alternance search failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return { error: true };
  }
}

function emptyLaBonneAlternanceMerge(places: GooglePlaceCandidate[]) {
  return {
    places,
    evidenceByPlaceId: new Map<string, OpportunityEvidence[]>(),
    keywordsByPlaceId: new Map<string, string[]>(),
    mergedEmployers: 0,
    addedEmployers: 0,
  };
}

export function mergeOfficialEvidence(
  inspection: SiteInspection,
  officialEvidence: OpportunityEvidence[],
  officialKeywords: string[],
): SiteInspection {
  if (!officialEvidence.length && !officialKeywords.length) return inspection;

  const sortedEvidence = deduplicateOpportunityEvidence([
    ...officialEvidence,
    ...inspection.evidence,
  ]).sort(compareEvidence);
  const evidence = selectMergedEvidence(sortedEvidence, 12);

  return {
    ...inspection,
    evidence,
    matchedKeywords: [
      ...new Set([...officialKeywords, ...inspection.matchedKeywords]),
    ],
  };
}

function selectMergedEvidence(
  sortedEvidence: OpportunityEvidence[],
  limit: number,
): OpportunityEvidence[] {
  const selected = ["public-offer", "recruitment-page", "prospecting"]
    .map((level) =>
      sortedEvidence.find(
        (evidence) =>
          evidence.level === level &&
          evidence.sourceKind === "official-job-service",
      ),
    )
    .filter((evidence): evidence is OpportunityEvidence => Boolean(evidence))
    .slice(0, limit);
  const selectedEvidence = new Set(selected);

  for (const evidence of sortedEvidence) {
    if (selected.length >= limit) break;
    if (selectedEvidence.has(evidence)) continue;
    selected.push(evidence);
  }

  return selected.sort(compareEvidence);
}

function compareEvidence(
  left: OpportunityEvidence,
  right: OpportunityEvidence,
): number {
  return (
    opportunityEvidencePriority(right) - opportunityEvidencePriority(left) ||
    evidenceSourcePriority(right) - evidenceSourcePriority(left) ||
    (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
    right.confidence - left.confidence
  );
}

function evidenceSourcePriority(evidence: OpportunityEvidence): number {
  if (evidence.sourceKind === "employer-site") return 4;
  if (evidence.sourceKind === "employer-ats") return 3;
  if (evidence.sourceKind === "official-job-service") return 2;
  if (evidence.sourceKind === "unknown") return 1;
  return 0;
}

function opportunityEvidencePriority(evidence: OpportunityEvidence): number {
  if (evidence.level === "public-offer") return 3;
  if (evidence.level === "recruitment-page") return 2;
  return 1;
}

export function calculateCoverage(results: EmployerMatch[]): SearchCoverage {
  return {
    employersFound: results.length,
    routesCalculated: results.reduce(
      (count, result) =>
        count +
        Object.values(result.travel).filter(
          (estimate) => estimate?.status === "available",
        ).length,
      0,
    ),
    websitesFound: results.filter((result) => Boolean(result.websiteUrl)).length,
    websitesChecked: results.filter(
      (result) => result.siteInspection.pagesChecked > 0,
    ).length,
    publicOffersDetected: results.reduce(
      (count, result) =>
        count +
        deduplicateOpportunityEvidence(
          result.siteInspection.evidence.filter(isTrustedPublicOfferEvidence),
        ).length,
      0,
    ),
  };
}

function deduplicateOpportunityEvidence(
  values: readonly OpportunityEvidence[],
): OpportunityEvidence[] {
  const result: OpportunityEvidence[] = [];
  for (const candidate of values) {
    const existingIndex = result.findIndex((existing) =>
      describesSameOpportunity(existing, candidate),
    );
    if (existingIndex < 0) {
      result.push(candidate);
    } else if (compareEvidence(candidate, result[existingIndex]) < 0) {
      result[existingIndex] = candidate;
    }
  }
  return result;
}

function describesSameOpportunity(
  left: OpportunityEvidence,
  right: OpportunityEvidence,
): boolean {
  const leftTitle = normalizeEvidenceIdentity(left.title);
  const rightTitle = normalizeEvidenceIdentity(right.title);
  if (!leftTitle || leftTitle !== rightTitle) return false;
  if (left.url === right.url) return true;
  if (left.level !== "public-offer" || right.level !== "public-offer") {
    return false;
  }

  const samePublishedDate = sameKnownDate(left.publishedAt, right.publishedAt);
  const sameValidityDate = sameKnownDate(left.validThrough, right.validThrough);
  if (!samePublishedDate && !sameValidityDate) return false;

  const leftLocation = normalizeEvidenceIdentity(left.locationText ?? "");
  const rightLocation = normalizeEvidenceIdentity(right.locationText ?? "");
  return !leftLocation || !rightLocation || leftLocation === rightLocation;
}

function sameKnownDate(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && left.slice(0, 10) === right.slice(0, 10));
}

function normalizeEvidenceIdentity(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTrustedPublicOfferEvidence(evidence: OpportunityEvidence): boolean {
  if (evidence.level !== "public-offer" || !evidence.sourceKind) return false;
  if (evidence.sourceKind === "employer-site") {
    return evidence.directEmployer !== false;
  }
  if (evidence.sourceKind === "employer-ats") {
    return evidence.directEmployer === true;
  }
  return evidence.sourceKind === "official-job-service";
}

function buildCaution(
  inspection: SiteInspection,
  isDemo: boolean,
): string | undefined {
  if (isDemo) {
    return "Résultat fictif généré uniquement pour illustrer l’application.";
  }
  if (
    inspection.evidence.some(
      (evidence) =>
        evidence.level === "public-offer" &&
        evidence.sourceKind === "official-job-service",
    )
  ) {
    return undefined;
  }
  if (inspection.status === "blocked") {
    return "Le site a refusé l’analyse automatisée ; consultez-le directement pour vérifier les recrutements.";
  }
  if (inspection.status === "unreachable") {
    return "Le site était inaccessible pendant cette recherche ; son absence d’offre n’est pas concluante.";
  }
  if (inspection.status === "not-requested") {
    return inspection.note;
  }
  if (
    inspection.evidence.some(
      (evidence) =>
        evidence.directEmployer === false ||
        evidence.sourceKind === "unknown" ||
        evidence.sourceKind === "intermediary" ||
        evidence.sourceKind === "school-cfa" ||
        evidence.sourceKind === "staffing",
    )
  ) {
    return "Un lien tiers a été repéré, mais son rattachement à l’employeur n’est pas confirmé ; vérifiez-le avant de candidater.";
  }
  return undefined;
}

function compareMatches(left: EmployerMatch, right: EmployerMatch): number {
  return right.score.total - left.score.total || left.distanceKm - right.distanceKm;
}

function formatTravelModes(modes: TravelMode[]): string {
  const labels: Record<TravelMode, string> = {
    TRANSIT: "transports en commun",
    DRIVE: "voiture",
    BICYCLE: "vélo",
    WALK: "marche",
    TWO_WHEELER: "deux-roues motorisé",
  };
  return [...new Set(modes)].map((mode) => labels[mode]).join(", ");
}

function isSiteScanEnabled(): boolean {
  return process.env.ENABLE_SITE_SCAN?.trim().toLowerCase() !== "false";
}

function readSiteScanLimit(): number {
  const configured = Number.parseInt(process.env.SITE_SCAN_LIMIT ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_WEBSITES_PER_SEARCH;
  return Math.max(1, Math.min(MAX_WEBSITES_PER_SEARCH, configured));
}

function normalizeEmployerBudget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return MAX_EMPLOYER_BUDGET;
  return Math.max(1, Math.min(MAX_EMPLOYER_BUDGET, Math.floor(value)));
}

/** Validate CV-produced codes and rederive edited/free-form profiles server-side. */
function resolveCandidateProfile(
  input: SearchInput,
): CandidateProfile | undefined {
  const candidate = input.profile;
  if (!candidate) return undefined;

  const normalizedTargetRoles = normalizedValues(candidate.targetRoles);
  const normalizedSkills = normalizedValues(candidate.skills);
  const normalizedDiploma = candidate.diploma?.trim() || undefined;
  const submittedRomeCodes = normalizedValues(candidate.romeCodes)
    .map((code) => code.toUpperCase())
    .filter((code) =>
      (CV_PROFILE_ROME_CODES as readonly string[]).includes(code),
    );
  const derivedRomeCodes = deriveRomeCodesForProfile({
    diploma: normalizedDiploma,
    targetRoles: normalizedTargetRoles,
    skills: normalizedSkills,
  });
  const explicitMcoDiploma =
    deriveRomeCodesForProfile({
      diploma: normalizedDiploma,
      targetRoles: [],
      skills: [],
    }).length > 0;
  const normalized: CandidateProfile = {
    ...candidate,
    headline: candidate.headline.trim(),
    ...(normalizedDiploma
      ? { diploma: normalizedDiploma }
      : { diploma: undefined }),
    targetRoles: normalizedTargetRoles,
    skills: normalizedSkills,
    sectors: normalizedValues(candidate.sectors),
    keywords: normalizedValues(candidate.keywords),
    romeCodes:
      explicitMcoDiploma && submittedRomeCodes.length > 0
        ? submittedRomeCodes
        : derivedRomeCodes,
    explanations: normalizedValues(candidate.explanations),
  };

  const usefulSignals =
    normalized.targetRoles.length +
    normalized.skills.length +
    normalized.sectors.length +
    normalized.romeCodes.length;
  return usefulSignals > 0 ? normalized : undefined;
}

function normalizedValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    const key = value.toLocaleLowerCase("fr");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function searchPersonalization(
  profile: CandidateProfile | undefined,
): SearchPersonalization {
  return profile
    ? {
        mode: "cv-profile",
        label: profile.headline,
        confidence: profile.confidence,
      }
    : {
        mode: "bts-mco-default",
        label: "BTS Management commercial opérationnel",
      };
}
