import { haversineDistanceKm } from "@/lib/geo";
import { safePublicHttpUrl } from "@/lib/public-url";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type {
  CandidateProfile,
  Coordinates,
  ResolvedOrigin,
  SearchOrigin,
  TravelEstimate,
  TravelMode,
} from "@/lib/types";

const GEOCODING_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const NEARBY_SEARCH_ENDPOINT =
  "https://places.googleapis.com/v1/places:searchNearby";
const ROUTE_MATRIX_ENDPOINT =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_GOOGLE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_NEARBY_RESULTS_PER_GROUP = 20;
const NEARBY_SEARCH_CONCURRENCY = 4;
const ROUTE_MATRIX_MAX_DESTINATIONS = 25;
const ROUTE_MATRIX_CONCURRENCY = 5;
const ENV_PROXY_AGENT = new EnvHttpProxyAgent();

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface GoogleMapsProviderOptions {
  /** Test hook. Production traffic uses the environment-aware proxy agent. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** Cancels upstream work when the browser abandons the search. */
  signal?: AbortSignal;
  /** Extra server-derived Places categories; the baseline cohorts still run. */
  preferredPlaceTypes?: readonly string[];
}

const proxyFetch: FetchLike = async (input, init) =>
  (await undiciFetch(input, {
    ...init,
    dispatcher: ENV_PROXY_AGENT,
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;

interface NearbySearchGroup {
  id: "profile" | "retail" | "services" | "hospitality";
  label: string;
  relevance: number;
  includedTypes: readonly string[];
}

/**
 * Primary types accepted by Places API (New), split so each request returns a
 * useful and distinct pool instead of letting one dense category hide others.
 */
export const GOOGLE_NEARBY_SEARCH_GROUPS = [
  {
    id: "retail",
    label: "commerces",
    relevance: 3,
    includedTypes: [
      "auto_parts_store",
      "bicycle_store",
      "book_store",
      "cell_phone_store",
      "clothing_store",
      "convenience_store",
      "department_store",
      "discount_store",
      "electronics_store",
      "florist",
      "furniture_store",
      "gift_shop",
      "grocery_store",
      "hardware_store",
      "home_goods_store",
      "home_improvement_store",
      "jewelry_store",
      "pet_store",
      "pharmacy",
      "shoe_store",
      "shopping_mall",
      "sporting_goods_store",
      "store",
      "supermarket",
      "wholesaler",
    ],
  },
  {
    id: "services",
    label: "services aux clients",
    relevance: 2,
    includedTypes: [
      "bank",
      "barber_shop",
      "beauty_salon",
      "bowling_alley",
      "car_dealer",
      "car_rental",
      "courier_service",
      "gym",
      "hair_salon",
      "insurance_agency",
      "laundry",
      "movie_theater",
      "nail_salon",
      "post_office",
      "real_estate_agency",
      "spa",
      "storage",
      "tailor",
      "telecommunications_service_provider",
      "tourist_information_center",
      "travel_agency",
    ],
  },
  {
    id: "hospitality",
    label: "hôtellerie et restauration",
    relevance: 1,
    includedTypes: [
      "bakery",
      "bar",
      "bed_and_breakfast",
      "cafe",
      "campground",
      "catering_service",
      "coffee_shop",
      "fast_food_restaurant",
      "food_court",
      "hostel",
      "hotel",
      "lodging",
      "meal_takeaway",
      "motel",
      "restaurant",
      "resort_hotel",
    ],
  },
] as const satisfies readonly NearbySearchGroup[];

const ALLOWED_NEARBY_PLACE_TYPES = new Set<string>(
  GOOGLE_NEARBY_SEARCH_GROUPS.flatMap(({ includedTypes }) => includedTypes),
);

const PROFILE_PLACE_TYPE_RULES: ReadonlyArray<{
  terms: readonly string[];
  types: readonly string[];
}> = [
  {
    terms: [
      "commerce",
      "distribution",
      "magasin",
      "merchandising",
      "retail",
      "vendeur",
      "vente",
    ],
    types: [
      "store",
      "supermarket",
      "department_store",
      "shopping_mall",
      "clothing_store",
      "sporting_goods_store",
      "electronics_store",
      "home_goods_store",
      "hardware_store",
      "cell_phone_store",
    ],
  },
  {
    terms: ["banque", "bancaire", "assurance", "finance", "clientele"],
    types: ["bank", "insurance_agency"],
  },
  {
    terms: ["automobile", "automotive", "vehicule"],
    types: ["car_dealer", "car_rental", "auto_parts_store"],
  },
  {
    terms: ["beaute", "coiffure", "esthetique", "bien etre"],
    types: ["beauty_salon", "hair_salon", "barber_shop", "spa"],
  },
  {
    terms: ["hotellerie", "hotel", "restauration", "restaurant", "tourisme"],
    types: [
      "hotel",
      "restaurant",
      "fast_food_restaurant",
      "cafe",
      "coffee_shop",
      "travel_agency",
      "tourist_information_center",
    ],
  },
  {
    terms: ["immobilier", "immo", "location immobiliere"],
    types: ["real_estate_agency"],
  },
  {
    terms: ["logistique", "transport", "livraison"],
    types: ["courier_service", "storage", "wholesaler"],
  },
  {
    terms: ["sport", "fitness"],
    types: ["gym", "sporting_goods_store"],
  },
  {
    terms: ["telecom", "telephonie", "telephone"],
    types: ["telecommunications_service_provider", "cell_phone_store"],
  },
];

const NEARBY_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.businessStatus",
].join(",");

const ROUTE_FIELD_MASK = [
  "originIndex",
  "destinationIndex",
  "status",
  "condition",
  "distanceMeters",
  "duration",
].join(",");

export class GoogleMapsError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "GoogleMapsError";
    this.code = code;
    this.status = status;
  }
}

export interface GooglePlaceCandidate {
  placeId: string;
  /** Google Places identifier used for routing; absent for external sources. */
  googlePlaceId?: string;
  /** Places query cohort, used to keep downstream inspection representative. */
  searchGroup?: NearbySearchGroup["id"];
  name: string;
  category: string;
  /** Stable Places API types used for deterministic business-fit analysis. */
  placeTypes?: string[];
  address: string;
  coordinates: Coordinates;
  distanceKm: number;
  rating?: number;
  reviewCount?: number;
  websiteUrl?: string;
  googleMapsUrl: string;
}

export interface NearbyGooglePlacesResult {
  places: GooglePlaceCandidate[];
  failedGroups: Array<{
    id: NearbySearchGroup["id"];
    label: string;
  }>;
}

interface GoogleGeocodingResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
  }>;
}

interface NearbySearchResponse {
  places?: GooglePlace[];
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
}

interface RouteMatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  status?: { code?: number; message?: string };
  condition?: string;
  distanceMeters?: number;
  duration?: string;
}

export function googleMapsApiKey(): string | undefined {
  const value = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  return value || undefined;
}

export function hasGoogleMapsApiKey(): boolean {
  return googleMapsApiKey() !== undefined;
}

export async function resolveGoogleOrigin(
  origin: SearchOrigin,
  apiKey = requireApiKey(),
  options: GoogleMapsProviderOptions = {},
): Promise<ResolvedOrigin> {
  if (origin.kind === "coordinates") {
    assertCoordinates(origin.coordinates);
    return {
      label:
        cleanProviderText(origin.label, 320) ||
        formatCoordinates(origin.coordinates),
      coordinates: origin.coordinates,
    };
  }

  const endpoint = new URL(GEOCODING_ENDPOINT);
  endpoint.searchParams.set("address", origin.address);
  endpoint.searchParams.set("language", "fr");
  endpoint.searchParams.set("region", "fr");
  endpoint.searchParams.set("key", apiKey);

  const response = await fetchJson<GoogleGeocodingResponse>(
    endpoint,
    { method: "GET" },
    "geocoding",
    options,
  );

  if (response.status === "ZERO_RESULTS") {
    throw new GoogleMapsError(
      "GEOCODING_NOT_FOUND",
      "L’adresse n’a pas pu être localisée.",
    );
  }
  if (response.status !== "OK") {
    throw new GoogleMapsError(
      "GEOCODING_REJECTED",
      `Le service de géocodage a refusé la requête (${response.status || "UNKNOWN"}).`,
    );
  }

  const firstResult = response.results?.[0];
  const location = firstResult?.geometry?.location;
  if (!isFiniteNumber(location?.lat) || !isFiniteNumber(location?.lng)) {
    throw new GoogleMapsError(
      "GEOCODING_INVALID_RESPONSE",
      "Le service de géocodage a renvoyé une réponse incomplète.",
    );
  }

  const coordinates = { lat: location.lat, lng: location.lng };
  assertCoordinates(coordinates);

  return {
    label:
      cleanProviderText(firstResult?.formatted_address, 320) || origin.address,
    coordinates,
  };
}

export async function searchNearbyGooglePlaces(
  origin: Coordinates,
  radiusKm: number,
  apiKey = requireApiKey(),
  options: GoogleMapsProviderOptions = {},
): Promise<GooglePlaceCandidate[]> {
  const result = await searchNearbyGooglePlacesDetailed(
    origin,
    radiusKm,
    apiKey,
    options,
  );
  return result.places;
}

export async function searchNearbyGooglePlacesDetailed(
  origin: Coordinates,
  radiusKm: number,
  apiKey = requireApiKey(),
  options: GoogleMapsProviderOptions = {},
): Promise<NearbyGooglePlacesResult> {
  assertCoordinates(origin);
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 50) {
    throw new GoogleMapsError(
      "INVALID_RADIUS",
      "Le rayon doit être compris entre 1 et 50 km.",
    );
  }

  const preferredPlaceTypes = sanitizePreferredPlaceTypes(
    options.preferredPlaceTypes,
  );
  const searchGroups: readonly NearbySearchGroup[] = preferredPlaceTypes.length
    ? [
        {
          id: "profile",
          label: "secteurs correspondant au CV",
          relevance: 4,
          includedTypes: preferredPlaceTypes,
        },
        ...GOOGLE_NEARBY_SEARCH_GROUPS,
      ]
    : GOOGLE_NEARBY_SEARCH_GROUPS;

  const outcomes = await mapSettledWithConcurrency(
    searchGroups,
    NEARBY_SEARCH_CONCURRENCY,
    (group) =>
      requestNearbySearchGroup(origin, radiusKm, group, apiKey, options),
  );

  const successful = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<RankedGooglePlaceCandidate[]> =>
      outcome.status === "fulfilled",
  );
  if (successful.length === 0) {
    const firstFailure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    throw firstFailure?.reason instanceof Error
      ? firstFailure.reason
      : new GoogleMapsError(
          "NEARBY_SEARCH_FAILED",
          "Google Maps n’a renvoyé aucun groupe d’établissements.",
        );
  }

  const failedGroups = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [
          {
            id: searchGroups[index].id,
            label: searchGroups[index].label,
          },
        ]
      : [],
  );

  return {
    places: deduplicateAndRankPlaces(successful.flatMap(({ value }) => value)),
    failedGroups,
  };
}

/**
 * Maps a structured CV profile to a small set of valid Places primary types.
 * This only adds a focused request: the three baseline cohorts always remain.
 */
export function googlePlaceTypesForProfile(
  profile: Pick<
    CandidateProfile,
    "targetRoles" | "skills" | "sectors" | "keywords"
  > | undefined,
): string[] {
  if (!profile) return [];
  const corpus = normalizeDiscoveryText(
    [
      ...profile.targetRoles,
      ...profile.skills,
      ...profile.sectors,
      ...profile.keywords,
    ].join(" "),
  );
  const matches = PROFILE_PLACE_TYPE_RULES.flatMap(({ terms, types }) =>
    terms.some((term) => corpus.includes(normalizeDiscoveryText(term)))
      ? types
      : [],
  );
  return sanitizePreferredPlaceTypes(matches);
}

function sanitizePreferredPlaceTypes(
  values: readonly string[] | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => ALLOWED_NEARBY_PLACE_TYPES.has(value)),
    ),
  ].slice(0, 30);
}

function normalizeDiscoveryText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface RankedGooglePlaceCandidate {
  candidate: GooglePlaceCandidate;
  relevance: number;
}

async function requestNearbySearchGroup(
  origin: Coordinates,
  radiusKm: number,
  group: NearbySearchGroup,
  apiKey: string,
  options: GoogleMapsProviderOptions,
): Promise<RankedGooglePlaceCandidate[]> {
  const response = await fetchJson<NearbySearchResponse>(
    NEARBY_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: googleHeaders(apiKey, NEARBY_FIELD_MASK),
      body: JSON.stringify({
        includedTypes: group.includedTypes,
        maxResultCount: MAX_NEARBY_RESULTS_PER_GROUP,
        rankPreference: "POPULARITY",
        languageCode: "fr",
        regionCode: "FR",
        locationRestriction: {
          circle: {
            center: {
              latitude: origin.lat,
              longitude: origin.lng,
            },
            radius: radiusKm * 1_000,
          },
        },
      }),
    },
    `nearby-search-${group.id}`,
    options,
  );

  return (response.places ?? [])
    .filter(
      (place) =>
        place.businessStatus !== "CLOSED_PERMANENTLY" &&
        place.businessStatus !== "CLOSED_TEMPORARILY",
    )
    .map((place) => mapGooglePlace(place, origin))
    .filter((place): place is GooglePlaceCandidate => place !== undefined)
    .filter((place) => place.distanceKm <= radiusKm + 0.05)
    .map((candidate) => ({
      candidate: { ...candidate, searchGroup: group.id },
      relevance: group.relevance,
    }));
}

function deduplicateAndRankPlaces(
  places: RankedGooglePlaceCandidate[],
): GooglePlaceCandidate[] {
  const byPlaceId = new Map<string, RankedGooglePlaceCandidate>();

  for (const incoming of places) {
    const existing = byPlaceId.get(incoming.candidate.placeId);
    if (!existing) {
      byPlaceId.set(incoming.candidate.placeId, incoming);
      continue;
    }

    const preferred = incoming.relevance > existing.relevance ? incoming : existing;
    const fallback = preferred === incoming ? existing : incoming;
    byPlaceId.set(incoming.candidate.placeId, {
      relevance: Math.max(existing.relevance, incoming.relevance),
      candidate: mergePlaceCandidates(preferred.candidate, fallback.candidate),
    });
  }

  return [...byPlaceId.values()]
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        placePopularity(right.candidate) - placePopularity(left.candidate) ||
        left.candidate.distanceKm - right.candidate.distanceKm ||
        left.candidate.name.localeCompare(right.candidate.name, "fr"),
    )
    .map(({ candidate }) => candidate);
}

function mergePlaceCandidates(
  preferred: GooglePlaceCandidate,
  fallback: GooglePlaceCandidate,
): GooglePlaceCandidate {
  return {
    ...fallback,
    ...preferred,
    ...(preferred.rating !== undefined || fallback.rating !== undefined
      ? { rating: preferred.rating ?? fallback.rating }
      : {}),
    ...(preferred.reviewCount !== undefined || fallback.reviewCount !== undefined
      ? { reviewCount: preferred.reviewCount ?? fallback.reviewCount }
      : {}),
    ...(preferred.websiteUrl || fallback.websiteUrl
      ? { websiteUrl: preferred.websiteUrl ?? fallback.websiteUrl }
      : {}),
    ...(preferred.placeTypes?.length || fallback.placeTypes?.length
      ? {
          placeTypes: [
            ...new Set([
              ...(preferred.placeTypes ?? []),
              ...(fallback.placeTypes ?? []),
            ]),
          ],
        }
      : {}),
  };
}

function placePopularity(place: GooglePlaceCandidate): number {
  return (place.rating ?? 0) * Math.log10((place.reviewCount ?? 0) + 10);
}

export async function computeGoogleRouteMatrix(
  origin: Coordinates,
  destinations: GooglePlaceCandidate[],
  modes: TravelMode[],
  apiKey = requireApiKey(),
  options: GoogleMapsProviderOptions = {},
): Promise<{
  travelByPlaceId: Map<string, Partial<Record<TravelMode, TravelEstimate>>>;
  failedModes: TravelMode[];
}> {
  assertCoordinates(origin);
  const travelByPlaceId = new Map<
    string,
    Partial<Record<TravelMode, TravelEstimate>>
  >(destinations.map((destination) => [destination.placeId, {}]));
  const failedModes = new Set<TravelMode>();
  const batches = chunk(destinations, ROUTE_MATRIX_MAX_DESTINATIONS);
  const tasks = [...new Set(modes)].flatMap((mode) =>
    batches.map((batch) => ({ mode, destinations: batch })),
  );

  await mapWithConcurrency(tasks, ROUTE_MATRIX_CONCURRENCY, async (task) => {
    const { mode, destinations: batch } = task;
    try {
      const elements = await requestRouteMatrix(
        origin,
        batch,
        mode,
        apiKey,
        options,
      );
      applyRouteElements(elements, batch, mode, travelByPlaceId);
    } catch (error) {
      if (!(error instanceof GoogleMapsError)) throw error;
      failedModes.add(mode);
      for (const destination of batch) {
        travelByPlaceId.get(destination.placeId)![mode] = unavailableTravel(
          mode,
          destination.distanceKm,
        );
      }
    }
  });

  return {
    travelByPlaceId,
    failedModes: [...new Set(modes)].filter((mode) => failedModes.has(mode)),
  };
}

async function requestRouteMatrix(
  origin: Coordinates,
  destinations: GooglePlaceCandidate[],
  mode: TravelMode,
  apiKey: string,
  options: GoogleMapsProviderOptions,
): Promise<RouteMatrixElement[]> {
  if (destinations.length === 0) return [];

  const body: Record<string, unknown> = {
    origins: [
      {
        waypoint: {
          location: {
            latLng: { latitude: origin.lat, longitude: origin.lng },
          },
        },
      },
    ],
    destinations: destinations.map((destination) => ({
      waypoint: destination.googlePlaceId
        ? { placeId: destination.googlePlaceId }
        : {
            location: {
              latLng: {
                latitude: destination.coordinates.lat,
                longitude: destination.coordinates.lng,
              },
            },
          },
    })),
    travelMode: mode,
    languageCode: "fr-FR",
    regionCode: "FR",
  };

  const departureTime = nextWorkdayDepartureTime(
    options.now?.() ?? new Date(),
  );
  if (mode === "DRIVE" || mode === "TWO_WHEELER") {
    body.routingPreference = "TRAFFIC_AWARE";
    body.departureTime = departureTime;
  } else if (mode === "TRANSIT") {
    body.departureTime = departureTime;
  }

  const response = await fetchJson<unknown>(
    ROUTE_MATRIX_ENDPOINT,
    {
      method: "POST",
      headers: googleHeaders(apiKey, ROUTE_FIELD_MASK),
      body: JSON.stringify(body),
    },
    `route-matrix-${mode.toLowerCase()}`,
    options,
  );

  return validateRouteMatrixResponse(response, destinations.length);
}

/**
 * Compute Route Matrix is the only Google endpoint used here whose successful
 * response is a top-level array. Keep the response unknown until every element
 * has been checked: an HTTP 200 can still contain a proxy error object, a
 * truncated matrix, or values that do not match the protobuf JSON contract.
 */
function validateRouteMatrixResponse(
  value: unknown,
  destinationCount: number,
): RouteMatrixElement[] {
  if (!Array.isArray(value) || value.length !== destinationCount) {
    throw invalidRouteMatrixResponse();
  }

  const seenDestinationIndexes = new Set<number>();
  const elements: RouteMatrixElement[] = [];

  for (const rawElement of value) {
    if (!isRecord(rawElement)) {
      throw invalidRouteMatrixResponse();
    }

    const originIndex = rawElement.originIndex;
    const destinationIndex = rawElement.destinationIndex;
    if (
      originIndex !== 0 ||
      !Number.isInteger(destinationIndex) ||
      (destinationIndex as number) < 0 ||
      (destinationIndex as number) >= destinationCount ||
      seenDestinationIndexes.has(destinationIndex as number)
    ) {
      throw invalidRouteMatrixResponse();
    }

    const status = rawElement.status;
    if (status !== undefined && !isRouteMatrixStatus(status)) {
      throw invalidRouteMatrixResponse();
    }
    const condition = rawElement.condition;
    if (condition !== undefined && typeof condition !== "string") {
      throw invalidRouteMatrixResponse();
    }
    const distanceMeters = rawElement.distanceMeters;
    if (
      distanceMeters !== undefined &&
      (!isFiniteNumber(distanceMeters) || distanceMeters < 0)
    ) {
      throw invalidRouteMatrixResponse();
    }
    const duration = rawElement.duration;
    if (duration !== undefined && typeof duration !== "string") {
      throw invalidRouteMatrixResponse();
    }

    seenDestinationIndexes.add(destinationIndex as number);
    elements.push({
      originIndex,
      destinationIndex: destinationIndex as number,
      ...(status !== undefined ? { status } : {}),
      ...(condition !== undefined ? { condition } : {}),
      ...(distanceMeters !== undefined ? { distanceMeters } : {}),
      ...(duration !== undefined ? { duration } : {}),
    });
  }

  return elements;
}

function isRouteMatrixStatus(
  value: unknown,
): value is NonNullable<RouteMatrixElement["status"]> {
  if (!isRecord(value)) return false;
  const { code, message } = value;
  return (
    (code === undefined || Number.isInteger(code)) &&
    (message === undefined || typeof message === "string")
  );
}

function invalidRouteMatrixResponse(): GoogleMapsError {
  return new GoogleMapsError(
    "ROUTE_MATRIX_INVALID_RESPONSE",
    "Le service Google Maps a renvoyé une matrice d’itinéraires incomplète ou invalide.",
  );
}

function applyRouteElements(
  elements: RouteMatrixElement[],
  destinations: GooglePlaceCandidate[],
  mode: TravelMode,
  travelByPlaceId: Map<
    string,
    Partial<Record<TravelMode, TravelEstimate>>
  >,
): void {
  const seen = new Set<number>();

  for (const element of elements) {
    const index = element.destinationIndex;
    if (
      !Number.isInteger(index) ||
      index === undefined ||
      index < 0 ||
      index >= destinations.length
    ) {
      continue;
    }
    seen.add(index);
    const destination = destinations[index];
    const distanceMeters = element.distanceMeters;
    const routeExists =
      (element.status?.code === undefined || element.status.code === 0) &&
      element.condition === "ROUTE_EXISTS" &&
      isFiniteNumber(distanceMeters) &&
      distanceMeters >= 0;
    const durationSeconds = parseGoogleDurationSeconds(element.duration);

    travelByPlaceId.get(destination.placeId)![mode] = routeExists && durationSeconds !== undefined
      ? {
          mode,
          durationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)),
          distanceKm: roundToOneDecimal(distanceMeters / 1_000),
          status: "available",
        }
      : unavailableTravel(mode, destination.distanceKm);
  }

  destinations.forEach((destination, index) => {
    if (!seen.has(index)) {
      travelByPlaceId.get(destination.placeId)![mode] = unavailableTravel(
        mode,
        destination.distanceKm,
      );
    }
  });
}

function mapGooglePlace(
  place: GooglePlace,
  origin: Coordinates,
): GooglePlaceCandidate | undefined {
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  const name = cleanProviderText(place.displayName?.text, 180);
  const placeId = cleanProviderText(place.id, 260);
  if (
    !name ||
    !placeId ||
    !isFiniteNumber(latitude) ||
    !isFiniteNumber(longitude)
  ) {
    return undefined;
  }

  const coordinates = { lat: latitude, lng: longitude };
  try {
    assertCoordinates(coordinates);
  } catch {
    return undefined;
  }
  const placeTypes = cleanPlaceTypes(place.types);

  return {
    placeId,
    googlePlaceId: placeId,
    name,
    category:
      cleanProviderText(place.primaryTypeDisplayName?.text, 140) ||
      cleanProviderText(humanizePlaceType(place.types?.[0]), 140) ||
      "Commerce",
    ...(placeTypes.length > 0 ? { placeTypes } : {}),
    address:
      cleanProviderText(place.formattedAddress, 320) ||
      "Adresse non communiquée",
    coordinates,
    distanceKm: roundToOneDecimal(haversineDistanceKm(origin, coordinates)),
    ...(isFiniteNumber(place.rating) ? { rating: place.rating } : {}),
    ...(Number.isInteger(place.userRatingCount) && place.userRatingCount! >= 0
      ? { reviewCount: place.userRatingCount }
      : {}),
    ...(safePublicHttpUrl(place.websiteUri)
      ? { websiteUrl: safePublicHttpUrl(place.websiteUri) }
      : {}),
    googleMapsUrl:
      safeGoogleMapsUrl(place.googleMapsUri) ||
      googleMapsSearchUrl(name, coordinates),
  };
}

function cleanPlaceTypes(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" &&
          value.length <= 80 &&
          /^[a-z][a-z0-9_]*$/.test(value),
      ),
    ),
  ].slice(0, 30);
}

function googleHeaders(apiKey: string, fieldMask: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": fieldMask,
  };
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The useful error is the HTTP or size error that triggered cancellation.
  }
}

async function readBoundedGoogleJson<T>(
  response: Response,
  operation: string,
  signal: AbortSignal,
): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_GOOGLE_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response);
    throw new GoogleMapsError(
      "GOOGLE_RESPONSE_TOO_LARGE",
      `Le service Google Maps a renvoyé une réponse trop volumineuse (${operation}).`,
      response.status,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new GoogleMapsError(
      "GOOGLE_INVALID_JSON",
      `Le service Google Maps a renvoyé une réponse illisible (${operation}).`,
      response.status,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abortReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abortReader, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_GOOGLE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GoogleMapsError(
          "GOOGLE_RESPONSE_TOO_LARGE",
          `Le service Google Maps a renvoyé une réponse trop volumineuse (${operation}).`,
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T;
  } catch (error) {
    throw new GoogleMapsError(
      "GOOGLE_INVALID_JSON",
      `Le service Google Maps a renvoyé une réponse illisible (${operation}).`,
      response.status,
      error,
    );
  }
}

async function fetchJson<T>(
  endpoint: string | URL,
  init: RequestInit,
  operation: string,
  options: GoogleMapsProviderOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = clampInteger(
    options.timeoutMs,
    REQUEST_TIMEOUT_MS,
    500,
    30_000,
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const response = await (options.fetchImpl ?? proxyFetch)(endpoint, {
      ...init,
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new GoogleMapsError(
        "GOOGLE_HTTP_ERROR",
        `Le service Google Maps est indisponible (${operation}, HTTP ${response.status}).`,
        response.status,
      );
    }

    return await readBoundedGoogleJson<T>(response, operation, signal);
  } catch (error) {
    if (error instanceof GoogleMapsError) throw error;
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (controller.signal.aborted) {
      throw new GoogleMapsError(
        "GOOGLE_TIMEOUT",
        `Le service Google Maps n’a pas répondu à temps (${operation}).`,
        undefined,
        error,
      );
    }
    throw new GoogleMapsError(
      "GOOGLE_NETWORK_ERROR",
      `Impossible de joindre le service Google Maps (${operation}).`,
      undefined,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await task(items[index], index);
      }
    }),
  );
}

async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const outcomes = new Array<PromiseSettledResult<R>>(items.length);
  await mapWithConcurrency(items, concurrency, async (item, index) => {
    try {
      outcomes[index] = { status: "fulfilled", value: await task(item, index) };
    } catch (reason) {
      outcomes[index] = { status: "rejected", reason };
    }
  });
  return outcomes;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

function requireApiKey(): string {
  const apiKey = googleMapsApiKey();
  if (!apiKey) {
    throw new GoogleMapsError(
      "GOOGLE_API_KEY_MISSING",
      "La clé serveur Google Maps n’est pas configurée.",
    );
  }
  return apiKey;
}

function assertCoordinates(coordinates: Coordinates): void {
  if (
    !Number.isFinite(coordinates.lat) ||
    !Number.isFinite(coordinates.lng) ||
    coordinates.lat < -90 ||
    coordinates.lat > 90 ||
    coordinates.lng < -180 ||
    coordinates.lng > 180
  ) {
    throw new GoogleMapsError(
      "INVALID_COORDINATES",
      "Les coordonnées géographiques sont invalides.",
    );
  }
}

function unavailableTravel(
  mode: TravelMode,
  distanceKm: number,
): TravelEstimate {
  return {
    mode,
    durationMinutes: 0,
    distanceKm,
    status: "unavailable",
  };
}

function parseGoogleDurationSeconds(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function humanizePlaceType(type: string | undefined): string | undefined {
  if (!type) return undefined;
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function cleanProviderText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function safeGoogleMapsUrl(value: string | undefined): string | undefined {
  const safeUrl = safePublicHttpUrl(value);
  if (!safeUrl) return undefined;
  const hostname = new URL(safeUrl).hostname.toLowerCase();
  return hostname === "google.com" || hostname.endsWith(".google.com")
    ? safeUrl
    : undefined;
}

function googleMapsSearchUrl(name: string, coordinates: Coordinates): string {
  const query = encodeURIComponent(`${name} ${coordinates.lat},${coordinates.lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function formatCoordinates(coordinates: Coordinates): string {
  return `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const PARIS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Returns 08:30 in Paris on the current workday when it is still upcoming,
 * otherwise 08:30 on the next Monday-Friday. This makes commute estimates
 * representative of a school/work journey instead of the server clock.
 */
export function nextWorkdayDepartureTime(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new GoogleMapsError(
      "INVALID_DEPARTURE_TIME",
      "La date de référence du trajet est invalide.",
    );
  }

  const parisNow = parisDateParts(now);
  let calendarDay = new Date(
    Date.UTC(parisNow.year, parisNow.month - 1, parisNow.day),
  );
  const currentWeekday = calendarDay.getUTCDay();
  const isWorkday = currentWeekday >= 1 && currentWeekday <= 5;
  const isBeforeDeparture = parisNow.hour * 60 + parisNow.minute < 8 * 60 + 30;

  if (!isWorkday || !isBeforeDeparture) {
    do {
      calendarDay = new Date(calendarDay.getTime() + 24 * 60 * 60 * 1_000);
    } while (
      calendarDay.getUTCDay() === 0 ||
      calendarDay.getUTCDay() === 6
    );
  }

  return parisLocalTimeToUtc(
    calendarDay.getUTCFullYear(),
    calendarDay.getUTCMonth() + 1,
    calendarDay.getUTCDate(),
    8,
    30,
  ).toISOString();
}

function parisDateParts(date: Date): ZonedDateParts {
  const parts = Object.fromEntries(
    PARIS_DATE_TIME_FORMATTER.formatToParts(date).flatMap((part) =>
      part.type === "literal" ? [] : [[part.type, Number(part.value)]],
    ),
  ) as Partial<Record<keyof ZonedDateParts, number>>;
  const required: Array<keyof ZonedDateParts> = [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
  ];
  if (required.some((key) => !Number.isFinite(parts[key]))) {
    throw new GoogleMapsError(
      "INVALID_DEPARTURE_TIME",
      "La date de référence du trajet ne peut pas être convertie.",
    );
  }
  return parts as ZonedDateParts;
}

function parisLocalTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = targetAsUtc;

  // Iterating twice resolves the Paris UTC offset, including DST changes.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = parisDateParts(new Date(instant));
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = targetAsUtc - observedAsUtc;
    if (correction === 0) break;
    instant += correction;
  }

  return new Date(instant);
}
