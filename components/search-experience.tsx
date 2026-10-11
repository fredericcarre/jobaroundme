"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  APPLICATION_POTENTIAL_COPY,
  POTENTIAL_CONFIDENCE_COPY,
  websiteStatusLabel,
  websiteWasFound,
} from "@/components/application-potential";
import { MCO_PROFILE } from "@/lib/mco-profile";
import { deriveRomeCodesForProfile } from "@/lib/cv-profile";
import { safePublicHttpUrl } from "@/lib/public-url";
import type {
  CandidateProfile,
  EmployerMatch,
  OpportunityLevel,
  SearchInput,
  SearchResponse,
  TravelMode,
} from "@/lib/types";

import {
  ArrowIcon,
  BikeIcon,
  CarIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  FileIcon,
  ListIcon,
  LocationIcon,
  LogoMark,
  MapIcon,
  HeartIcon,
  ScooterIcon,
  SearchIcon,
  ShieldIcon,
  SparkIcon,
  TargetIcon,
  TransitIcon,
  UploadIcon,
  WalkIcon,
} from "@/components/icons";
import { ResultCard } from "@/components/result-card";
import { ResultsMap } from "@/components/results-map";

const RADIUS_OPTIONS = [5, 10, 20, 30, 50] as const;
const MAX_CV_FILE_SIZE = 5 * 1024 * 1024;
const PROFILE_ITEM_MAX_LENGTH = 120;
const PROFILE_MANUAL_EXPLANATION =
  "Profil ajusté manuellement après l’analyse du CV ; les valeurs corrigées guident la recherche.";
const POTENTIAL_DISCLAIMER =
  "Indice de priorité explicable, pas une probabilité d’embauche.";

const PROFILE_FIELD_LIMITS = {
  targetRoles: 12,
  skills: 40,
  sectors: 16,
} as const;

const TRANSPORT_OPTIONS: Array<{
  mode: TravelMode;
  label: string;
  shortLabel: string;
  icon: ReactNode;
}> = [
  { mode: "TRANSIT", label: "Transports en commun", shortLabel: "Transports", icon: <TransitIcon /> },
  { mode: "DRIVE", label: "Voiture", shortLabel: "Voiture", icon: <CarIcon /> },
  { mode: "BICYCLE", label: "Vélo", shortLabel: "Vélo", icon: <BikeIcon /> },
  { mode: "WALK", label: "À pied", shortLabel: "À pied", icon: <WalkIcon /> },
  { mode: "TWO_WHEELER", label: "Deux-roues motorisé", shortLabel: "Deux-roues", icon: <ScooterIcon /> },
];

export type SortOrder = "score" | "potential" | "commute" | "distance" | "rating";
type OpportunityFilter = "all" | OpportunityLevel;
type MobileView = "list" | "map";
type EditableProfileField = keyof typeof PROFILE_FIELD_LIMITS;
type ProfileDraft = Record<EditableProfileField, string>;

interface SearchSnapshot {
  fingerprint: string;
  input: SearchInput;
  profileAdjusted: boolean;
}

interface CvData {
  fileName: string;
  pages?: number;
  characters: number;
  retention?: string;
  profile?: CandidateProfile;
}

interface ApiError {
  error?: string;
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SearchResponse>;
  return (
    (candidate.mode === "live" || candidate.mode === "demo") &&
    typeof candidate.partial === "boolean" &&
    Boolean(candidate.origin) &&
    Array.isArray(candidate.results) &&
    Array.isArray(candidate.notices)
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown, fallback: string) {
  if (value && typeof value === "object") {
    const message = (value as ApiError).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function stringList(value: unknown, maximum: number, itemMaximum = PROFILE_ITEM_MAX_LENGTH) {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const values: string[] = [];
  for (const rawItem of value) {
    if (typeof rawItem !== "string") continue;
    const item = rawItem.trim().slice(0, itemMaximum);
    const key = item.toLocaleLowerCase("fr-FR");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    values.push(item);
    if (values.length >= maximum) break;
  }
  return values;
}

function readCandidateProfile(value: unknown): CandidateProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.headline !== "string" || !candidate.headline.trim()) return undefined;

  const confidence = candidate.confidence;
  return {
    headline: candidate.headline.trim().slice(0, 180),
    ...(typeof candidate.diploma === "string" && candidate.diploma.trim()
      ? { diploma: candidate.diploma.trim().slice(0, 180) }
      : {}),
    targetRoles: stringList(candidate.targetRoles, PROFILE_FIELD_LIMITS.targetRoles),
    skills: stringList(candidate.skills, PROFILE_FIELD_LIMITS.skills),
    sectors: stringList(candidate.sectors, PROFILE_FIELD_LIMITS.sectors),
    keywords: stringList(candidate.keywords, 40),
    romeCodes: stringList(candidate.romeCodes, 10, 5)
      .map((code) => code.toUpperCase())
      .filter((code) => /^[A-Z][0-9]{4}$/u.test(code)),
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : "low",
    explanations: stringList(candidate.explanations, 16, 280),
  };
}

function hasProfessionalSignals(
  profile: CandidateProfile | undefined,
): profile is CandidateProfile {
  return Boolean(
    profile &&
      (profile.targetRoles.length > 0 ||
        profile.skills.length > 0 ||
        profile.sectors.length > 0 ||
        profile.romeCodes.length > 0),
  );
}

function profileDraftFrom(profile: CandidateProfile): ProfileDraft {
  return {
    targetRoles: profile.targetRoles.join(", "),
    skills: profile.skills.join(", "),
    sectors: profile.sectors.join(", "),
  };
}

function profileDraftMaxLength(field: EditableProfileField) {
  const itemCount = PROFILE_FIELD_LIMITS[field];
  return itemCount * PROFILE_ITEM_MAX_LENGTH + Math.max(0, itemCount - 1);
}

function boundProfileDraft(value: string, field: EditableProfileField) {
  return value
    .split(",")
    .slice(0, PROFILE_FIELD_LIMITS[field])
    .map((item) => item.slice(0, PROFILE_ITEM_MAX_LENGTH))
    .join(",");
}

function normalizedProfileValues(value: string, maximum: number) {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const rawValue of value.split(",")) {
    const item = rawValue.trim().slice(0, PROFILE_ITEM_MAX_LENGTH);
    const key = item.toLocaleLowerCase("fr-FR");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    values.push(item);
    if (values.length >= maximum) break;
  }

  return values;
}

function uniqueProfileValues(values: readonly string[], maximum: number) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = rawValue.trim().slice(0, PROFILE_ITEM_MAX_LENGTH);
    const key = value.toLocaleLowerCase("fr-FR");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= maximum) break;
  }

  return result;
}

function searchFingerprint(input: SearchInput) {
  return JSON.stringify({
    origin:
      input.origin.kind === "coordinates"
        ? {
            kind: input.origin.kind,
            lat: input.origin.coordinates.lat,
            lng: input.origin.coordinates.lng,
          }
        : {
            kind: input.origin.kind,
            address: input.origin.address.trim().toLocaleLowerCase("fr-FR"),
          },
    radiusKm: input.radiusKm,
    travelModes: [...input.travelModes].sort(),
    profile: input.profile ?? null,
  });
}

function confidenceLabel(confidence: CandidateProfile["confidence"]) {
  if (confidence === "high") return "élevée";
  if (confidence === "medium") return "moyenne";
  return "faible";
}

export function escapeCsvCell(value: string | number) {
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function evidenceSourceForExport(
  evidence: EmployerMatch["siteInspection"]["evidence"][number],
) {
  if (evidence.sourceLabel) return evidence.sourceLabel;
  if (evidence.sourceKind === "employer-site") return "Site de l’employeur";
  if (evidence.sourceKind === "employer-ats") return "Outil de recrutement de l’employeur";
  if (evidence.sourceKind === "official-job-service") return "Service public de l’emploi";
  if (evidence.sourceKind === "school-cfa") return "École ou CFA";
  if (evidence.sourceKind === "staffing") return "Intermédiaire de recrutement";
  if (evidence.sourceKind === "intermediary") return "Intermédiaire";
  return "Source non précisée";
}

const RESULTS_CSV_HEADER = [
  "Mode",
  "Rang",
  "Entreprise",
  "Catégorie",
  "Adresse",
  "Distance (km)",
  "Score",
  "Type de piste",
  "Potentiel de candidature",
  "Indice potentiel",
  "Lecture de l’indice",
  "Confiance potentiel",
  "Raisons du potentiel",
  "Action conseillée",
  "Site trouvé",
  "État du site",
  "Source",
  "Preuve",
  "URL preuve",
  "Publication",
  "Validité",
  "Consultation de la source",
  "Site entreprise",
  "Google Maps",
  "Transports (min)",
  "Voiture (min)",
  "Vélo (min)",
  "Marche (min)",
  "Deux-roues (min)",
] as const;

export function formatResultsForClipboard(results: readonly EmployerMatch[]) {
  const content = results
    .map((result, index) => {
      const evidenceLines = result.siteInspection.evidence.map((evidence) => {
        const url = safePublicHttpUrl(evidence.url);
        return `  • ${evidence.title}${url ? ` — ${url}` : ""} — Source : ${evidenceSourceForExport(evidence)}`;
      });
      const inspectedWebsite =
        result.siteInspection.status === "checked" &&
        result.siteInspection.pagesChecked > 0
          ? safePublicHttpUrl(result.websiteUrl)
          : undefined;
      const recruitmentUrl =
        result.siteInspection.status === "checked" &&
        result.siteInspection.pagesChecked > 0
          ? safePublicHttpUrl(result.siteInspection.recruitmentPageUrl)
          : undefined;
      const links = [
        inspectedWebsite ? `  Site entreprise — ${inspectedWebsite}` : undefined,
        recruitmentUrl && result.siteInspection.evidence.length === 0
          ? `  Page recrutement — ${recruitmentUrl}`
          : undefined,
        safePublicHttpUrl(result.googleMapsUrl)
          ? `  Google Maps — ${safePublicHttpUrl(result.googleMapsUrl)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));
      const potential = APPLICATION_POTENTIAL_COPY[result.applicationPotential.level];
      const potentialLines = [
        `  Potentiel de candidature : ${potential.label} — indice ${result.applicationPotential.score}/100 (confiance ${POTENTIAL_CONFIDENCE_COPY[result.applicationPotential.confidence]})`,
        `  Lecture : ${POTENTIAL_DISCLAIMER}`,
        `  Site trouvé : ${websiteWasFound(result) ? "Oui" : "Non"} — ${websiteStatusLabel(result)}`,
        result.applicationPotential.reasons.length
          ? `  Pourquoi : ${result.applicationPotential.reasons.join(" · ")}`
          : undefined,
        `  Action conseillée : ${result.applicationPotential.recommendedAction}`,
      ].filter((line): line is string => Boolean(line));

      return [
        `${index + 1}. ${result.name} — ${result.category} — ${result.address} — ${result.score.total} points`,
        ...potentialLines,
        ...evidenceLines,
        ...links,
      ].join("\n");
    })
    .join("\n\n");

  return results.some(({ isDemo }) => isDemo)
    ? `MODE DÉMONSTRATION — DONNÉES FICTIVES\n\n${content}`
    : content;
}

export function buildResultsCsv(results: readonly EmployerMatch[]) {
  const rows = results.flatMap((result, index) => {
    const evidences = result.siteInspection.evidence.length
      ? result.siteInspection.evidence
      : [undefined];
    const duration = (mode: TravelMode) => {
      const estimate = result.travel[mode];
      return estimate?.status === "available" ? estimate.durationMinutes : "";
    };
    const inspectedWebsite =
      result.siteInspection.status === "checked" &&
      result.siteInspection.pagesChecked > 0
        ? safePublicHttpUrl(result.websiteUrl)
        : undefined;
    const recruitmentUrl =
      result.siteInspection.status === "checked" &&
      result.siteInspection.pagesChecked > 0
        ? safePublicHttpUrl(result.siteInspection.recruitmentPageUrl)
        : undefined;
    const mapsUrl = safePublicHttpUrl(result.googleMapsUrl);

    return evidences.map((evidence) => [
      result.isDemo ? "MODE DÉMONSTRATION — DONNÉES FICTIVES" : "Données réelles",
      index + 1,
      result.name,
      result.category,
      result.address,
      result.distanceKm,
      result.score.total,
      evidence?.level ?? result.opportunityLevel,
      APPLICATION_POTENTIAL_COPY[result.applicationPotential.level].label,
      result.applicationPotential.score,
      POTENTIAL_DISCLAIMER,
      POTENTIAL_CONFIDENCE_COPY[result.applicationPotential.confidence],
      result.applicationPotential.reasons.join(" | "),
      result.applicationPotential.recommendedAction,
      websiteWasFound(result) ? "Oui" : "Non",
      websiteStatusLabel(result),
      evidence?.sourceLabel ?? evidence?.sourceKind ?? "",
      evidence?.title ?? "",
      safePublicHttpUrl(evidence?.url) ?? (!evidence ? recruitmentUrl : undefined) ?? "",
      evidence?.publishedAt ?? "",
      evidence?.validThrough ?? "",
      evidence?.retrievedAt ?? "",
      inspectedWebsite ?? "",
      mapsUrl ?? "",
      duration("TRANSIT"),
      duration("DRIVE"),
      duration("BICYCLE"),
      duration("WALK"),
      duration("TWO_WHEELER"),
    ]);
  });

  return [RESULTS_CSV_HEADER, ...rows]
    .map((row) => row.map(escapeCsvCell).join(";"))
    .join("\n");
}

function shortestCommute(
  travel: SearchResponse["results"][number]["travel"],
  modes: TravelMode[],
) {
  const durations = modes
    .map((mode) => travel[mode])
    .filter(
      (estimate): estimate is NonNullable<typeof estimate> =>
        Boolean(estimate && estimate.status === "available" && estimate.durationMinutes > 0),
    )
    .map((estimate) => estimate.durationMinutes);

  return durations.length ? Math.min(...durations) : Number.POSITIVE_INFINITY;
}

export function compareEmployerMatches(
  left: EmployerMatch,
  right: EmployerMatch,
  sortOrder: SortOrder,
  modes: TravelMode[],
) {
  if (sortOrder === "potential") {
    return (
      right.applicationPotential.score - left.applicationPotential.score ||
      right.score.total - left.score.total
    );
  }
  if (sortOrder === "distance") return left.distanceKm - right.distanceKm;
  if (sortOrder === "rating") return (right.rating ?? -1) - (left.rating ?? -1);
  if (sortOrder === "commute") {
    return shortestCommute(left.travel, modes) - shortestCommute(right.travel, modes);
  }
  return right.score.total - left.score.total;
}

interface SearchExperienceProps {
  browserMapKey?: string;
}

export function SearchExperience({ browserMapKey }: SearchExperienceProps) {
  const [address, setAddress] = useState("");
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number }>();
  const [radiusKm, setRadiusKm] = useState<number>(10);
  const [travelModes, setTravelModes] = useState<TravelMode[]>(["TRANSIT", "DRIVE"]);
  const [cv, setCv] = useState<CvData>();
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>();
  const [profileAdjusted, setProfileAdjusted] = useState(false);
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [cvStatus, setCvStatus] = useState<"idle" | "uploading" | "ready" | "error">("idle");
  const [cvError, setCvError] = useState<string>();
  const [locationStatus, setLocationStatus] = useState<string>();
  const [locating, setLocating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [response, setResponse] = useState<SearchResponse>();
  const [searchSnapshot, setSearchSnapshot] = useState<SearchSnapshot>();
  const [selectedId, setSelectedId] = useState<string>();
  const [sortOrder, setSortOrder] = useState<SortOrder>("score");
  const [opportunityFilter, setOpportunityFilter] = useState<OpportunityFilter>("all");
  const [highPotentialOnly, setHighPotentialOnly] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const cvAbortRef = useRef<AbortController | null>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchedTravelModes = searchSnapshot?.input.travelModes ?? travelModes;

  const filteredResults = useMemo(() => {
    if (!response) return [];

    const opportunityMatches =
      opportunityFilter === "all"
        ? [...response.results]
        : response.results.filter((result) => result.opportunityLevel === opportunityFilter);
    const potentialMatches = highPotentialOnly
      ? opportunityMatches.filter((result) => result.applicationPotential.level === "high")
      : opportunityMatches;
    const matches = favoritesOnly
      ? potentialMatches.filter((result) => favoriteIds.includes(result.id))
      : potentialMatches;

    return matches.sort((left, right) =>
      compareEmployerMatches(left, right, sortOrder, searchedTravelModes),
    );
  }, [favoriteIds, favoritesOnly, highPotentialOnly, opportunityFilter, response, searchedTravelModes, sortOrder]);

  const currentFavoriteCount = useMemo(
    () =>
      response?.results.filter((result) => favoriteIds.includes(result.id)).length ?? 0,
    [favoriteIds, response],
  );

  const activeSelectedId = filteredResults.some((result) => result.id === selectedId)
    ? selectedId
    : filteredResults[0]?.id;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(window.localStorage.getItem("jobaroundme:favorites") || "[]");
        if (Array.isArray(stored)) {
          setFavoriteIds(stored.filter((item): item is string => typeof item === "string"));
        }
      } catch {
        // The favorites feature stays available for this session if storage is blocked.
      }
    }, 0);

    return () => {
      window.clearTimeout(timer);
      searchAbortRef.current?.abort();
      cvAbortRef.current?.abort();
    };
  }, []);

  const selectResult = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const showResultInList = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("list");
    window.requestAnimationFrame(() => {
      document.getElementById(`result-${id}`)?.focus({ preventScroll: false });
    });
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setFavoriteIds((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      try {
        window.localStorage.setItem("jobaroundme:favorites", JSON.stringify(next));
      } catch {
        // Keep the in-memory favorite even if browser storage is unavailable.
      }
      return next;
    });
  }, []);

  async function copyResults() {
    const text = formatResultsForClipboard(filteredResults);

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }
    window.setTimeout(() => setCopyStatus("idle"), 2200);
  }

  function exportResults() {
    const csv = buildResultsCsv(filteredResults);
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "pistes-jobaroundme.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function toggleTravelMode(mode: TravelMode) {
    setTravelModes((current) => {
      if (current.includes(mode)) {
        return current.filter((item) => item !== mode);
      }
      return [...current, mode];
    });
  }

  function useMyLocation() {
    setLocationStatus(undefined);
    if (!("geolocation" in navigator)) {
      setLocationStatus("La géolocalisation n’est pas disponible dans ce navigateur.");
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoordinates({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setAddress("Ma position actuelle");
        setLocationStatus("Position obtenue. Vous pouvez lancer la recherche.");
        setLocating(false);
      },
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? "Autorisation refusée. Saisissez plutôt une adresse ou une ville."
            : "Votre position n’a pas pu être obtenue. Saisissez une adresse.";
        setCoordinates(undefined);
        setLocationStatus(message);
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  async function uploadCv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    cvAbortRef.current?.abort();
    if (file.size < 1 || file.size > MAX_CV_FILE_SIZE) {
      cvAbortRef.current = null;
      setCv(undefined);
      setProfileDraft(undefined);
      setProfileAdjusted(false);
      setProfileConfirmed(false);
      setProfileEditorOpen(false);
      setCvStatus("error");
      setCvError(
        file.size < 1
          ? "Ce fichier est vide. Choisissez un CV PDF ou TXT contenant du texte."
          : "Ce fichier dépasse 5 Mo. Choisissez un CV PDF ou TXT plus léger.",
      );
      event.currentTarget.value = "";
      return;
    }

    const controller = new AbortController();
    cvAbortRef.current = controller;
    setCv(undefined);
    setProfileDraft(undefined);
    setProfileAdjusted(false);
    setProfileConfirmed(false);
    setProfileEditorOpen(false);
    setCvError(undefined);
    setCvStatus("uploading");

    const formData = new FormData();
    formData.append("cv", file);

    try {
      const uploadResponse = await fetch("/api/cv", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      const data = await readJson(uploadResponse);

      if (!uploadResponse.ok) {
        throw new Error(errorMessage(data, "Le CV n’a pas pu être analysé."));
      }
      if (!data || typeof data !== "object") {
        throw new Error("La réponse d’analyse du CV est invalide.");
      }

      const candidate = data as Partial<CvData>;
      if (
        typeof candidate.fileName !== "string" ||
        typeof candidate.characters !== "number"
      ) {
        throw new Error("La réponse d’analyse du CV est incomplète.");
      }

      const profile = readCandidateProfile(candidate.profile);
      setCv({
        fileName: candidate.fileName,
        pages: candidate.pages,
        characters: candidate.characters,
        retention: candidate.retention,
        profile,
      });
      setProfileDraft(profile ? profileDraftFrom(profile) : undefined);
      setProfileEditorOpen(Boolean(profile));
      setCvStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setCvError(error instanceof Error ? error.message : "Le CV n’a pas pu être analysé.");
      setCvStatus("error");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeCv() {
    cvAbortRef.current?.abort();
    setCv(undefined);
    setProfileDraft(undefined);
    setProfileAdjusted(false);
    setProfileConfirmed(false);
    setProfileEditorOpen(false);
    setCvError(undefined);
    setCvStatus("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function updateProfileField(field: EditableProfileField, rawValue: string) {
    const value = boundProfileDraft(rawValue, field);
    const values = normalizedProfileValues(value, PROFILE_FIELD_LIMITS[field]);
    const previousValues = cv?.profile?.[field] ?? [];
    const changed =
      previousValues.length !== values.length ||
      previousValues.some((item, index) => item !== values[index]);

    setProfileDraft((current) => {
      const base = current ?? (cv?.profile ? profileDraftFrom(cv.profile) : undefined);
      return base ? { ...base, [field]: value } : base;
    });

    if (!changed) return;

    setProfileAdjusted(true);
    setProfileConfirmed(false);
    setCv((current) => {
      if (!current?.profile) return current;

      const previousEditableValues = new Set(
        [
          ...current.profile.targetRoles,
          ...current.profile.skills,
          ...current.profile.sectors,
        ].map((item) => item.toLocaleLowerCase("fr-FR")),
      );
      const targetRoles = field === "targetRoles" ? values : current.profile.targetRoles;
      const skills = field === "skills" ? values : current.profile.skills;
      const sectors = field === "sectors" ? values : current.profile.sectors;
      const preservedKeywords = current.profile.keywords.filter(
        (keyword) => !previousEditableValues.has(keyword.toLocaleLowerCase("fr-FR")),
      );
      const keywords = uniqueProfileValues(
        [...preservedKeywords, ...targetRoles, ...skills, ...sectors],
        40,
      );
      const headline =
        field === "targetRoles"
          ? targetRoles[0] ??
            current.profile.diploma ??
            (sectors[0] ? `Profil ${sectors[0]}` : undefined) ??
            (skills[0] ? `Profil ${skills[0]}` : undefined) ??
            "Profil professionnel à préciser"
          : current.profile.headline;

      return {
        ...current,
        profile: {
          ...current.profile,
          headline,
          targetRoles,
          skills,
          sectors,
          keywords,
          romeCodes:
            field === "targetRoles" || field === "skills"
              ? deriveRomeCodesForProfile({
                  diploma: current.profile.diploma,
                  targetRoles,
                  skills,
                })
              : current.profile.romeCodes,
          explanations: [PROFILE_MANUAL_EXPLANATION],
        },
      };
    });
  }

  function normalizeProfileDraftField(field: EditableProfileField) {
    setProfileDraft((current) =>
      current
        ? {
            ...current,
            [field]: (cv?.profile?.[field] ?? []).join(", "),
          }
        : current,
    );
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchError(undefined);

    if (!coordinates && address.trim().length < 3) {
      setSearchError("Saisissez une adresse, une ville ou utilisez votre position.");
      return;
    }
    if (!travelModes.length) {
      setSearchError("Choisissez au moins un mode de transport.");
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setOpportunityFilter("all");
    setFavoritesOnly(false);
    setMobileView("list");
    if (cv?.profile) {
      setProfileEditorOpen(false);
    }

    const payload: SearchInput = {
      origin: coordinates
        ? { kind: "coordinates", coordinates, label: "Ma position actuelle" }
        : { kind: "address", address: address.trim() },
      radiusKm,
      travelModes: [...travelModes],
      ...(hasProfessionalSignals(cv?.profile) ? { profile: cv?.profile } : {}),
    };

    try {
      const searchResponse = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await readJson(searchResponse);

      if (!searchResponse.ok) {
        throw new Error(
          errorMessage(data, "La recherche n’a pas pu être terminée. Réessayez dans un instant."),
        );
      }
      if (!isSearchResponse(data)) {
        throw new Error("La réponse de recherche est incomplète. Réessayez.");
      }

      setResponse(data);
      setSearchSnapshot({
        input: payload,
        fingerprint: searchFingerprint(payload),
        profileAdjusted,
      });
      setSelectedId(data.results[0]?.id);
      window.requestAnimationFrame(() => resultsHeadingRef.current?.focus());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSearchError(
        error instanceof Error
          ? error.message
          : "La recherche n’a pas pu être terminée. Réessayez dans un instant.",
      );
    } finally {
      if (searchAbortRef.current === controller) setSearching(false);
    }
  }

  const hasResultsState = searching || Boolean(response);
  const incompleteEmptySearch = Boolean(
    response?.partial && response.results.length === 0,
  );
  const hasUsableCvProfile = hasProfessionalSignals(cv?.profile);
  const searchUsedCv = response?.personalization.mode === "cv-profile";
  const searchUsedAdjustedProfile = Boolean(searchUsedCv && searchSnapshot?.profileAdjusted);
  const nextRadiusKm = response
    ? RADIUS_OPTIONS.find((radius) => radius > response.radiusKm)
    : undefined;
  const currentInput: SearchInput = {
    origin: coordinates
      ? { kind: "coordinates", coordinates, label: "Ma position actuelle" }
      : { kind: "address", address: address.trim() },
    radiusKm,
    travelModes,
    ...(hasUsableCvProfile ? { profile: cv.profile } : {}),
  };
  const criteriaChanged = Boolean(
    response &&
      searchSnapshot &&
      searchSnapshot.fingerprint !== searchFingerprint(currentInput),
  );

  return (
    <div className={`experience${hasResultsState ? " has-results" : ""}`}>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="JobAroundMe — accueil">
          <LogoMark />
          <span>JobAroundMe</span>
        </a>
        <nav aria-label="Navigation principale">
          {hasResultsState ? (
            <>
              <a href="#recherche">Modifier les critères</a>
              {response && <a href="#resultats">Voir les résultats</a>}
            </>
          ) : (
            <>
              <a href="#methode">Comment ça marche</a>
              <a href="#profil-mco">Le BTS MCO</a>
            </>
          )}
        </nav>
        <span className="header-pill">Recherche locale d’alternance</span>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__glow hero__glow--one" />
          <div className="hero__glow hero__glow--two" />
          <div className="hero-copy">
            <p className="eyebrow"><SparkIcon /> Recherche locale · BTS MCO</p>
            <h1 id="hero-title">Le bon commerce est peut-être à <em>12 minutes.</em></h1>
            <p className="hero-intro">
              Commencez par un CV pour faire ressortir les entreprises et les offres les plus
              proches du profil, puis comparez les trajets et les sources.
            </p>
            <div className="hero-trust">
              <span><CheckIcon /> Recherche adaptée au profil</span>
              <span><CheckIcon /> Offres et pages carrières distinguées</span>
            </div>
          </div>

          <form
            aria-busy={searching}
            className="search-panel"
            id="recherche"
            onSubmit={submitSearch}
          >
            <div className="search-panel__heading">
              <div>
                <span className="step-kicker">Votre recherche</span>
                <h2>{response ? "Ajuster les critères" : "Préparer votre recherche"}</h2>
              </div>
              {response && (
                <span className="current-search">
                  <LocationIcon /> {response.origin.label}
                </span>
              )}
            </div>

            <div className="search-steps">
              <section
                className={`search-step search-step--cv${cvStatus === "ready" ? " is-complete" : ""}`}
                aria-labelledby="cv-step-title"
              >
                <div className="search-step__header">
                  <span className="search-step__number" aria-hidden="true">
                    {cvStatus === "ready" ? <CheckIcon /> : "1"}
                  </span>
                  <div className="search-step__copy">
                    <span className="step-kicker">Étape 1 · recommandée</span>
                    <h2 id="cv-step-title">Commencez par le CV</h2>
                    <p>
                      Nous en retenons l’intitulé, les métiers et les compétences utiles pour
                      classer les pistes les plus proches du profil.
                    </p>
                  </div>
                  {!cv && cvStatus !== "uploading" && (
                    <a className="skip-cv-link" href="#search-location">
                      Continuer sans CV
                    </a>
                  )}
                </div>

                <div className="cv-zone">
                  <span aria-live="polite" className="visually-hidden" role="status">
                    {cvStatus === "uploading"
                      ? "Lecture du CV en cours."
                      : cvStatus === "ready" && cv
                        ? `${cv.fileName} a été analysé. Vérifiez le profil avant la recherche.`
                        : ""}
                  </span>
                  <input
                    accept=".pdf,.txt,application/pdf,text/plain"
                    aria-describedby={cvError ? "cv-upload-error cv-upload-help" : "cv-upload-help"}
                    aria-invalid={cvStatus === "error"}
                    className="visually-hidden"
                    id="cv-upload"
                    onChange={uploadCv}
                    ref={fileInputRef}
                    type="file"
                  />
                {cvStatus === "ready" && cv ? (
                  <div className="cv-ready-shell">
                    <div className="cv-ready">
                      <span className="cv-ready__icon"><FileIcon /></span>
                      <span>
                        <strong>{cv.fileName}</strong>
                        <small>
                          {cv.pages ? `${cv.pages} page${cv.pages > 1 ? "s" : ""} · ` : ""}
                          {cv.characters.toLocaleString("fr-FR")} caractères lus
                        </small>
                      </span>
                      <button aria-label="Retirer le CV" onClick={removeCv} type="button"><CloseIcon /></button>
                    </div>

                    {cv.profile ? (
                      <div
                        className="cv-profile"
                        aria-label="Résumé du profil retenu dans le CV"
                        role="group"
                      >
                        <div className="cv-profile__headline">
                          <div className="cv-profile__status">
                            <span aria-live="polite">
                              <CheckIcon />
                              {profileConfirmed
                                ? "Profil vérifié"
                                : profileAdjusted
                                  ? "Corrections appliquées"
                                  : "Profil extrait"}
                            </span>
                            {profileAdjusted ? (
                              <span className="profile-confidence profile-confidence--manual">
                                Ajusté manuellement
                              </span>
                            ) : (
                              <span
                                className={`profile-confidence profile-confidence--${cv.profile.confidence}`}
                              >
                                Confiance {confidenceLabel(cv.profile.confidence)}
                              </span>
                            )}
                          </div>
                          <strong>{cv.profile.headline}</strong>
                        </div>
                        <dl>
                          {cv.profile.targetRoles.length > 0 && (
                            <div>
                              <dt>Métiers</dt>
                              <dd className="profile-tags">
                                {cv.profile.targetRoles.slice(0, 4).map((role) => (
                                  <span key={role}>{role}</span>
                                ))}
                              </dd>
                            </div>
                          )}
                          {cv.profile.skills.length > 0 && (
                            <div>
                              <dt>Compétences</dt>
                              <dd className="profile-tags">
                                {cv.profile.skills.slice(0, 6).map((skill) => (
                                  <span key={skill}>{skill}</span>
                                ))}
                              </dd>
                            </div>
                          )}
                          {cv.profile.diploma && (
                            <div>
                              <dt>Formation</dt>
                              <dd>{cv.profile.diploma}</dd>
                            </div>
                          )}
                          {cv.profile.sectors.length > 0 && (
                            <div>
                              <dt>Secteurs</dt>
                              <dd>{cv.profile.sectors.slice(0, 3).join(" · ")}</dd>
                            </div>
                          )}
                        </dl>
                        <details
                          className="cv-profile__editor"
                          onToggle={(event) => setProfileEditorOpen(event.currentTarget.open)}
                          open={profileEditorOpen}
                        >
                          <summary>Vérifier ou corriger le profil</summary>
                          <p id="profile-editor-help">
                            Séparez les valeurs par des virgules. Les doublons sont ignorés ; chaque
                            valeur est limitée à {PROFILE_ITEM_MAX_LENGTH} caractères.
                          </p>
                          <div className="profile-editor__fields">
                            <label htmlFor="profile-target-roles">
                              <span>
                                Métiers cibles
                                <small>
                                  {cv.profile.targetRoles.length}/{PROFILE_FIELD_LIMITS.targetRoles}
                                </small>
                              </span>
                              <input
                                aria-describedby="profile-editor-help"
                                autoComplete="off"
                                id="profile-target-roles"
                                maxLength={profileDraftMaxLength("targetRoles")}
                                onBlur={() => normalizeProfileDraftField("targetRoles")}
                                onChange={(event) =>
                                  updateProfileField("targetRoles", event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                                type="text"
                                value={
                                  profileDraft?.targetRoles ??
                                  cv.profile.targetRoles.join(", ")
                                }
                              />
                            </label>
                            <label htmlFor="profile-sectors">
                              <span>
                                Secteurs
                                <small>
                                  {cv.profile.sectors.length}/{PROFILE_FIELD_LIMITS.sectors}
                                </small>
                              </span>
                              <input
                                aria-describedby="profile-editor-help"
                                autoComplete="off"
                                id="profile-sectors"
                                maxLength={profileDraftMaxLength("sectors")}
                                onBlur={() => normalizeProfileDraftField("sectors")}
                                onChange={(event) =>
                                  updateProfileField("sectors", event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                                type="text"
                                value={profileDraft?.sectors ?? cv.profile.sectors.join(", ")}
                              />
                            </label>
                            <label className="profile-editor__skills" htmlFor="profile-skills">
                              <span>
                                Compétences
                                <small>
                                  {cv.profile.skills.length}/{PROFILE_FIELD_LIMITS.skills}
                                </small>
                              </span>
                              <input
                                aria-describedby="profile-editor-help"
                                autoComplete="off"
                                id="profile-skills"
                                maxLength={profileDraftMaxLength("skills")}
                                onBlur={() => normalizeProfileDraftField("skills")}
                                onChange={(event) =>
                                  updateProfileField("skills", event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                                type="text"
                                value={profileDraft?.skills ?? cv.profile.skills.join(", ")}
                              />
                            </label>
                          </div>
                          <div className="profile-editor__actions">
                            <button
                              className={profileConfirmed ? "is-confirmed" : undefined}
                              onClick={() => {
                                setProfileConfirmed(true);
                                setProfileEditorOpen(false);
                              }}
                              type="button"
                            >
                              <CheckIcon />
                              {profileConfirmed ? "Profil vérifié" : "Terminer la vérification"}
                            </button>
                            <span>
                              Ces informations seront appliquées à la prochaine recherche.
                            </span>
                          </div>
                        </details>
                        {cv.profile.explanations.length > 0 && (
                          <details className="cv-profile__explanation">
                            <summary>
                              {profileAdjusted
                                ? "Détail de l’ajustement"
                                : "Pourquoi ce profil a-t-il été retenu ?"}
                            </summary>
                            <ul>
                              {cv.profile.explanations.map((explanation) => (
                                <li key={explanation}>{explanation}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    ) : (
                      <div className="cv-profile-fallback">
                        <strong>CV lu, profil à préciser</strong>
                        <span>
                          Les signaux professionnels sont trop limités pour personnaliser la
                          recherche. Le profil BTS MCO sera utilisé par défaut.
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <label className={`cv-upload${cvStatus === "uploading" ? " is-loading" : ""}`} htmlFor="cv-upload">
                    {cvStatus === "uploading" ? <span className="mini-spinner" /> : <UploadIcon />}
                    <span>
                      <strong>
                        {cvStatus === "uploading"
                          ? "Lecture du CV en cours…"
                          : cvStatus === "error"
                            ? "Réessayer avec un CV"
                            : "Choisir un CV"}
                      </strong>
                      <small>PDF ou TXT · 5 Mo maximum</small>
                    </span>
                  </label>
                )}
                {cvError && <p className="cv-error" id="cv-upload-error" role="alert">{cvError}</p>}
                <p className="privacy-note" id="cv-upload-help">
                  <ShieldIcon />
                  <span>
                    Le fichier est analysé en mémoire et n’est pas conservé. Pour le CV d’un tiers,
                    par exemple votre enfant, assurez-vous d’avoir son accord avant l’envoi.
                  </span>
                </p>
                </div>
              </section>

              <section
                className="search-step search-step--location"
                id="search-location"
                aria-labelledby="location-step-title"
              >
                <div className="search-step__header">
                  <span className="search-step__number" aria-hidden="true">2</span>
                  <div className="search-step__copy">
                    <span className="step-kicker">Étape 2</span>
                    <h2 id="location-step-title">Choisissez la zone et les trajets</h2>
                    <p>Indiquez d’où partir pour chercher des entreprises réellement accessibles.</p>
                  </div>
                </div>

                <div className="criteria-grid">
                  <div className="field-group field-group--location">
                    <label htmlFor="search-address">Point de départ</label>
                    <div className={`input-shell${coordinates ? " has-location" : ""}`}>
                      <LocationIcon />
                      <input
                        autoComplete="street-address"
                        id="search-address"
                        onChange={(event) => {
                          setAddress(event.target.value);
                          setCoordinates(undefined);
                          setLocationStatus(undefined);
                        }}
                        placeholder="Adresse, ville ou code postal"
                        type="text"
                        value={address}
                      />
                      <button
                        aria-label="Utiliser ma position actuelle"
                        className="locate-button"
                        disabled={locating}
                        onClick={useMyLocation}
                        title="Utiliser ma position"
                        type="button"
                      >
                        {locating ? <span className="mini-spinner" /> : <TargetIcon />}
                      </button>
                    </div>
                    {locationStatus && <small className="field-message" role="status">{locationStatus}</small>}
                  </div>

                  <fieldset className="field-group field-group--radius">
                    <legend>Rayon</legend>
                    <div className="segmented-control">
                      {RADIUS_OPTIONS.map((radius) => (
                        <label className={radiusKm === radius ? "is-selected" : ""} key={radius}>
                          <input
                            checked={radiusKm === radius}
                            name="radius"
                            onChange={() => setRadiusKm(Number(radius))}
                            type="radio"
                            value={radius}
                          />
                          {radius} km
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>

                <fieldset className="field-group transport-field">
                  <legend>Modes de transport</legend>
                  <div className="transport-options">
                    {TRANSPORT_OPTIONS.map((option) => (
                      <label
                        className={travelModes.includes(option.mode) ? "is-selected" : ""}
                        key={option.mode}
                        title={option.label}
                      >
                        <input
                          checked={travelModes.includes(option.mode)}
                          onChange={() => toggleTravelMode(option.mode)}
                          type="checkbox"
                        />
                        {option.icon}
                        <span>{option.shortLabel}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <p className="data-sharing-note">
                  <span aria-hidden="true"><ShieldIcon /></span>
                  En mode réel, l’adresse ou les coordonnées sont transmises à Google pour les
                  lieux et les trajets. Si La Bonne Alternance est configurée, le serveur lui
                  envoie les coordonnées, le rayon, le niveau de diplôme 5 et les codes ROME
                  ciblés. Le fichier CV et son texte brut ne sont jamais transmis à ces services.
                </p>

                <div className="search-action">
                  <p
                    className={criteriaChanged ? "criteria-changed" : undefined}
                    role={criteriaChanged ? "status" : undefined}
                  >
                    {criteriaChanged
                      ? "Ces critères diffèrent des résultats affichés. Relancez la recherche pour les appliquer."
                      : hasUsableCvProfile
                        ? "Le classement tiendra compte du profil résumé à l’étape 1."
                        : "La recherche utilisera le profil BTS MCO de référence."}
                  </p>
                  <button
                    className="search-button"
                    disabled={searching || cvStatus === "uploading"}
                    ref={searchButtonRef}
                    type="submit"
                  >
                    {searching ? <span className="button-spinner" /> : <SearchIcon />}
                    <span>
                      {searching
                        ? "Recherche en cours…"
                        : criteriaChanged
                          ? "Mettre à jour les résultats"
                          : hasUsableCvProfile
                            ? "Rechercher pour ce profil"
                            : "Trouver des pistes BTS MCO"}
                    </span>
                    {!searching && <ArrowIcon />}
                  </button>
                </div>
              </section>
            </div>

            {searchError && (
              <div className="form-error" role="alert">
                <strong>La recherche n’a pas abouti.</strong>
                <span>{searchError}</span>
              </div>
            )}
          </form>
        </section>

        {searching && <SearchLoading />}

        {response && (
          <section
            className="results-section"
            id="resultats"
            aria-labelledby="results-heading"
          >
            <div className="results-summary">
              <div>
                <div className="results-summary__eyebrow">
                  {response.mode === "demo" ? (
                    <span className="demo-label">Démonstration</span>
                  ) : (
                    <span className="live-label"><span /> Données réelles</span>
                  )}
                  {searchUsedCv && (
                    <span className="profile-applied-label">
                      {searchUsedAdjustedProfile ? "Profil ajusté appliqué" : "Profil CV appliqué"}
                    </span>
                  )}
                  <span>{response.radiusKm} km autour de {response.origin.label}</span>
                  <span>
                    {searchedTravelModes
                      .map((mode) => TRANSPORT_OPTIONS.find((option) => option.mode === mode)?.shortLabel)
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <h2 id="results-heading" ref={resultsHeadingRef} tabIndex={-1}>
                  {response.results.length
                    ? `${response.results.length} piste${response.results.length > 1 ? "s" : ""} à explorer`
                    : incompleteEmptySearch
                      ? "La recherche n’a pas pu couvrir toutes les sources"
                      : "Aucune piste trouvée avec ces critères"}
                </h2>
                <p>
                  {response.results.length
                    ? searchUsedCv
                      ? "Classées selon le profil du CV et l’accessibilité — vérifiez toujours les conditions sur la source."
                      : "Classées pour faciliter votre tri — vérifiez toujours l’offre et ses conditions sur la source."
                    : incompleteEmptySearch
                      ? "Une ou plusieurs sources n’ont pas répondu. Réessayez avant de conclure qu’aucune piste n’existe dans ce rayon."
                    : nextRadiusKm
                      ? `Le prochain rayon disponible est ${nextRadiusKm} km.`
                      : "Le rayon maximal a été exploré. Essayez une adresse voisine ou d’autres modes de transport."}
                </p>
                {searchUsedCv &&
                  !searchUsedAdjustedProfile &&
                  response.personalization.confidence && (
                    <p className="results-profile-confidence">
                      Profil appliqué avec une confiance{" "}
                      {confidenceLabel(response.personalization.confidence)}.
                    </p>
                  )}
              </div>
              <dl className="coverage-stats" aria-label="Couverture de la recherche">
                <div><dt>{response.coverage.employersFound}</dt><dd>pistes retenues</dd></div>
                <div><dt>{response.coverage.routesCalculated}</dt><dd>trajets calculés</dd></div>
                <div><dt>{response.coverage.websitesFound}</dt><dd>sites trouvés</dd></div>
                <div><dt>{response.coverage.websitesChecked}</dt><dd>sites analysés</dd></div>
                <div><dt>{response.coverage.publicOffersDetected}</dt><dd>offres publiques</dd></div>
              </dl>
            </div>

            {response.mode === "demo" && (
              <div className="demo-notice" role="status">
                <SparkIcon />
                <div>
                  <strong>Vous regardez des données de démonstration.</strong>
                  <p>Ces exemples servent à montrer le parcours. Ils ne signalent pas des postes réellement ouverts.</p>
                </div>
              </div>
            )}

            {response.notices.length > 0 && (
              <aside className="search-notices" aria-label="Limites et précautions de la recherche">
                <strong>À garder en tête</strong>
                <ul>
                  {response.notices.map((notice) => <li key={notice}>{notice}</li>)}
                </ul>
              </aside>
            )}

            {response.results.length > 0 ? (
              <>
                <div className="result-toolbar">
                  <div
                    className="result-filter-pills"
                    aria-label="Filtrer les pistes"
                    role="group"
                  >
                    {([
                      ["all", "Toutes"],
                      ["public-offer", "Offres publiées"],
                      ["recruitment-page", "Pages recrutement"],
                      ["prospecting", "À prospecter"],
                    ] as Array<[OpportunityFilter, string]>).map(([value, label]) => (
                      <button
                        aria-pressed={opportunityFilter === value}
                        className={opportunityFilter === value ? "is-selected" : ""}
                        key={value}
                        onClick={() => setOpportunityFilter(value)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      aria-pressed={highPotentialOnly}
                      className={highPotentialOnly ? "is-selected" : ""}
                      onClick={() => setHighPotentialOnly((current) => !current)}
                      type="button"
                    >
                      Potentiel fort
                    </button>
                    <button
                      aria-pressed={favoritesOnly}
                      className={`favorites-filter${favoritesOnly ? " is-selected" : ""}`}
                      disabled={currentFavoriteCount === 0 && !favoritesOnly}
                      onClick={() => setFavoritesOnly((current) => !current)}
                      title={currentFavoriteCount ? undefined : "Aucun favori dans ces résultats"}
                      type="button"
                    >
                      <HeartIcon /> Favoris ({currentFavoriteCount})
                    </button>
                  </div>
                  <span className="current-result-count" aria-live="polite">
                    {filteredResults.length} piste{filteredResults.length === 1 ? "" : "s"}{" "}
                    affichée{filteredResults.length === 1 ? "" : "s"}
                  </span>
                  <div className="result-export-tools">
                    <button
                      aria-describedby="copy-results-status"
                      disabled={!filteredResults.length}
                      onClick={copyResults}
                      type="button"
                    >
                      {copyStatus === "success"
                        ? "Copié !"
                        : copyStatus === "error"
                          ? "Copie impossible"
                          : "Copier"}
                    </button>
                    <button disabled={!filteredResults.length} onClick={exportResults} type="button">
                      <DownloadIcon /> CSV
                    </button>
                  </div>
                  <span
                    aria-live="polite"
                    className="visually-hidden"
                    id="copy-results-status"
                    role="status"
                  >
                    {copyStatus === "success"
                      ? "Les pistes affichées ont été copiées dans le presse-papiers."
                      : copyStatus === "error"
                        ? "La copie dans le presse-papiers a échoué."
                        : ""}
                  </span>
                  <label className="sort-control">
                    <span>Trier par</span>
                    <select
                      aria-label="Trier les pistes"
                      onChange={(event) => setSortOrder(event.target.value as SortOrder)}
                      value={sortOrder}
                    >
                      <option value="score">Meilleure correspondance</option>
                      <option value="potential">Potentiel de candidature</option>
                      <option value="commute">Trajet le plus court</option>
                      <option value="distance">Distance directe</option>
                      <option value="rating">Note Google</option>
                    </select>
                  </label>
                  <div className="mobile-view-switch" aria-label="Choisir la vue" role="group">
                    <button
                      aria-pressed={mobileView === "list"}
                      className={mobileView === "list" ? "is-selected" : ""}
                      onClick={() => setMobileView("list")}
                      type="button"
                    ><ListIcon /> Liste</button>
                    <button
                      aria-pressed={mobileView === "map"}
                      className={mobileView === "map" ? "is-selected" : ""}
                      onClick={() => setMobileView("map")}
                      type="button"
                    ><MapIcon /> Carte</button>
                  </div>
                </div>

                {filteredResults.length ? (
                  <div className={`results-layout mobile-view--${mobileView}`}>
                    <div className="results-list" aria-label="Liste des pistes" role="list">
                      {filteredResults.map((result, index) => (
                        <ResultCard
                          usesCvProfile={searchUsedCv}
                          favorite={favoriteIds.includes(result.id)}
                          key={result.id}
                          onSelect={selectResult}
                          onToggleFavorite={toggleFavorite}
                          rank={index + 1}
                          result={result}
                          selected={result.id === activeSelectedId}
                          travelModes={searchedTravelModes}
                        />
                      ))}
                    </div>
                    <div className="map-column">
                      <ResultsMap
                        browserMapKey={browserMapKey}
                        onSelect={selectResult}
                        onShowInList={showResultInList}
                        origin={response.origin}
                        results={filteredResults}
                        selectedId={activeSelectedId}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="filtered-empty">
                    <SearchIcon />
                    <h3>{favoritesOnly ? "Aucun favori dans ce filtre" : "Aucune piste dans ce filtre"}</h3>
                    <p>
                      {favoritesOnly
                        ? "Ajoutez des pistes aux favoris ou revenez à l’ensemble des résultats."
                        : "Affichez toutes les pistes pour revenir aux résultats de la recherche."}
                    </p>
                    <button
                      onClick={() => {
                        setOpportunityFilter("all");
                        setHighPotentialOnly(false);
                        setFavoritesOnly(false);
                      }}
                      type="button"
                    >
                      Voir toutes les pistes
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="no-results">
                <div className="no-results__illustration"><LocationIcon /><span /></div>
                <div>
                  <h3>
                    {incompleteEmptySearch
                      ? "Recherche incomplète"
                      : nextRadiusKm
                        ? "Élargissez un peu le terrain"
                        : "Rayon maximal exploré"}
                  </h3>
                  <p>
                    {incompleteEmptySearch
                      ? "Certaines sources étaient indisponibles. Relancez la recherche avant d’élargir le rayon."
                      : nextRadiusKm
                      ? `Aucune piste exploitable dans ce rayon. Essayez maintenant ${nextRadiusKm} km.`
                      : "Aucune piste exploitable jusqu’à 50 km. Modifiez le point de départ ou les modes de transport."}
                  </p>
                  {incompleteEmptySearch ? (
                    <a className="no-results__link" href="#recherche">
                      Revenir aux critères et réessayer
                    </a>
                  ) : nextRadiusKm ? (
                    <button
                      onClick={() => {
                        setRadiusKm(nextRadiusKm);
                        window.requestAnimationFrame(() => searchButtonRef.current?.focus());
                      }}
                      type="button"
                    >
                      Préparer la recherche à {nextRadiusKm} km
                    </button>
                  ) : (
                    <a className="no-results__link" href="#recherche">
                      Modifier les critères
                    </a>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {!hasResultsState && (
          <>
            <section className="method-section" id="methode" aria-labelledby="method-title">
              <div className="section-heading">
                <p className="eyebrow">Une recherche lisible</p>
                <h2 id="method-title">Du CV aux entreprises accessibles.</h2>
                <p>JobAroundMe part du profil, du lieu et de sources publiques pour aider à décider où chercher en premier.</p>
              </div>
              <div className="method-grid">
                <article>
                  <span className="method-number">01</span>
                  <div className="method-icon"><FileIcon /></div>
                  <h3>Votre CV d’abord</h3>
                  <p>Les métiers, compétences et formations utiles orientent le classement des pistes.</p>
                </article>
                <article>
                  <span className="method-number">02</span>
                  <div className="method-icon"><LocationIcon /></div>
                  <h3>Autour de vous</h3>
                  <p>Les entreprises du rayon choisi sont comparées selon vos modes de transport.</p>
                </article>
                <article>
                  <span className="method-number">03</span>
                  <div className="method-icon"><SearchIcon /></div>
                  <h3>Des pistes vérifiables</h3>
                  <p>Offre publique, page carrières ou simple piste : chaque niveau est nommé et relié à sa source.</p>
                </article>
              </div>
              <p className="method-caveat">
                Le service aide à explorer, sans garantir l’exhaustivité des entreprises ni la disponibilité d’un poste.
              </p>
            </section>

            <section className="mco-section" id="profil-mco" aria-labelledby="mco-title">
              <div className="mco-intro">
                <span className="mco-badge">BTS MCO</span>
                <h2 id="mco-title">Management commercial opérationnel.</h2>
                <p>{MCO_PROFILE.description}</p>
                <div className="mco-sources">
                  <span>Profil fondé sur :</span>
                  {MCO_PROFILE.sources.map((source) => (
                    <a href={source.url} key={source.url} rel="noopener noreferrer" target="_blank">
                      {source.label}
                    </a>
                  ))}
                </div>
              </div>
              <div className="competency-list">
                {MCO_PROFILE.competencyGroups.map((group, index) => (
                  <article key={group.label}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h3>{group.label}</h3>
                      <p>{group.keywords.slice(0, 4).join(" · ")}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="site-footer">
        <a className="brand brand--footer" href="#top"><LogoMark /><span>JobAroundMe</span></a>
        <p>Un outil d’exploration locale pour préparer une recherche d’alternance.</p>
        <a href="#recherche">Lancer une recherche <ArrowIcon /></a>
      </footer>
    </div>
  );
}

function SearchLoading() {
  return (
    <section className="search-loading" aria-live="polite" aria-label="Recherche en cours">
      <div className="loading-message">
        <span className="radar-loader"><span /><span /></span>
        <div>
          <strong>On explore les environs…</strong>
          <p>Repérage des entreprises, calcul des trajets et consultation des pages publiques.</p>
        </div>
      </div>
      <div className="loading-layout" aria-hidden="true">
        <div className="loading-cards">
          {[0, 1, 2].map((item) => (
            <div className="skeleton-card" key={item}>
              <span /><strong /><p /><div />
            </div>
          ))}
        </div>
        <div className="skeleton-map"><span /><span /><span /></div>
      </div>
    </section>
  );
}

