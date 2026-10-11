export const TRAVEL_MODES = [
  "TRANSIT",
  "DRIVE",
  "BICYCLE",
  "WALK",
  "TWO_WHEELER",
] as const;

export type TravelMode = (typeof TRAVEL_MODES)[number];

export interface Coordinates {
  lat: number;
  lng: number;
}

export type SearchOrigin =
  | { kind: "address"; address: string }
  | { kind: "coordinates"; coordinates: Coordinates; label?: string };

export interface SearchInput {
  origin: SearchOrigin;
  radiusKm: number;
  travelModes: TravelMode[];
  /** Structured preview returned by the CV analysis endpoint. */
  profile?: CandidateProfile;
}

/**
 * Search-oriented facts extracted from a CV.
 *
 * Every value is either a canonical label backed by an explicit expression in
 * the CV or a documented professional fallback (for example, the usual target
 * roles associated with an explicitly named BTS MCO). Personal and sensitive
 * attributes are deliberately outside this contract.
 */
export interface CandidateProfile {
  headline: string;
  diploma?: string;
  targetRoles: string[];
  skills: string[];
  sectors: string[];
  keywords: string[];
  romeCodes: string[];
  confidence: "high" | "medium" | "low";
  explanations: string[];
}

export interface ResolvedOrigin {
  label: string;
  coordinates: Coordinates;
}

export interface TravelEstimate {
  mode: TravelMode;
  durationMinutes: number;
  distanceKm: number;
  status: "available" | "unavailable";
}

export type OpportunityLevel = "public-offer" | "recruitment-page" | "prospecting";

export interface OpportunityEvidence {
  level: OpportunityLevel;
  title: string;
  url: string;
  excerpt: string;
  confidence: number;
  sourceKind?:
    | "employer-site"
    | "employer-ats"
    | "official-job-service"
    | "intermediary"
    | "school-cfa"
    | "staffing"
    | "unknown";
  /** Human-readable publisher, for example France Travail or La Bonne Alternance. */
  sourceLabel?: string;
  directEmployer?: boolean;
  specificity?: "specific" | "generic";
  publishedAt?: string;
  validThrough?: string;
  /** Time at which this source was retrieved; distinct from publication dates. */
  retrievedAt?: string;
  locationText?: string;
}

export interface SiteInspection {
  status: "checked" | "blocked" | "unreachable" | "not-requested";
  checkedAt?: string;
  pagesChecked: number;
  recruitmentPageUrl?: string;
  evidence: OpportunityEvidence[];
  matchedKeywords: string[];
  note?: string;
}

export interface MatchBreakdown {
  opportunity: number;
  btsMcoFit: number;
  cvFit: number;
  commute: number;
  total: number;
}

/**
 * Priority for a direct application to this employer.
 *
 * `score` is a deterministic ranking index, not a statistical probability of
 * being hired or of an apprenticeship position existing.
 */
export interface ApplicationPotential {
  score: number;
  level: "high" | "medium" | "low" | "to-qualify";
  confidence: "high" | "medium" | "low";
  websiteStatus:
    | "found-and-checked"
    | "found-not-checked"
    | "blocked"
    | "unreachable"
    | "not-listed";
  reasons: string[];
  recommendedAction: string;
}

export interface EmployerMatch {
  id: string;
  name: string;
  category: string;
  address: string;
  coordinates: Coordinates;
  distanceKm: number;
  rating?: number;
  reviewCount?: number;
  websiteUrl?: string;
  googleMapsUrl: string;
  travel: Partial<Record<TravelMode, TravelEstimate>>;
  opportunityLevel: OpportunityLevel;
  applicationPotential: ApplicationPotential;
  siteInspection: SiteInspection;
  score: MatchBreakdown;
  reasons: string[];
  caution?: string;
  isDemo?: boolean;
}

export interface SearchCoverage {
  employersFound: number;
  routesCalculated: number;
  websitesFound: number;
  websitesChecked: number;
  publicOffersDetected: number;
}

export interface SearchPersonalization {
  mode: "cv-profile" | "bts-mco-default";
  label: string;
  confidence?: CandidateProfile["confidence"];
}

export interface SearchResponse {
  mode: "live" | "demo";
  /** True when at least one configured upstream source failed for this run. */
  partial: boolean;
  origin: ResolvedOrigin;
  radiusKm: number;
  generatedAt: string;
  results: EmployerMatch[];
  coverage: SearchCoverage;
  personalization: SearchPersonalization;
  notices: string[];
}
