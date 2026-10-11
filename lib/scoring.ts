import { expandCvProfileConcept } from "@/lib/cv-profile";
import { MCO_PROFILE } from "@/lib/mco-profile";
import type {
  ApplicationPotential,
  CandidateProfile,
  MatchBreakdown,
  OpportunityLevel,
  SiteInspection,
  TravelEstimate,
  TravelMode,
} from "@/lib/types";

export const SCORE_WEIGHTS = {
  opportunity: 35,
  btsMcoFit: 30,
  cvFit: 15,
  commute: 20,
} as const;

export interface ScoreEmployerInput {
  name: string;
  category: string;
  placeTypes?: readonly string[];
  websiteUrl?: string;
  siteInspection: SiteInspection;
  travel?: Partial<Record<TravelMode, TravelEstimate>>;
  profile?: CandidateProfile;
  opportunityLevel?: OpportunityLevel;
}

export interface ScoreResult {
  score: MatchBreakdown;
  reasons: string[];
  opportunityLevel: OpportunityLevel;
  applicationPotential: ApplicationPotential;
}

const OPPORTUNITY_POINTS: Record<Exclude<OpportunityLevel, "public-offer">, number> = {
  "recruitment-page": 22,
  prospecting: 8,
};

const RETAIL_CATEGORY_TERMS = [
  "supermarket",
  "shopping mall",
  "department store",
  "clothing store",
  "shoe store",
  "sporting goods",
  "book store",
  "electronics store",
  "cell phone store",
  "furniture store",
  "home goods",
  "hardware store",
  "beauty salon",
  "jewelry store",
  "pet store",
  "convenience store",
  "grocery store",
  "store",
  "supermarche",
  "hypermarch",
  "centre commercial",
  "grand magasin",
  "magasin",
  "boutique",
  "commerce",
  "distribution",
  "retail",
  "vente",
  "banque",
  "assurance",
  "telephonie",
  "restauration",
  "hotel",
];

const STRONG_MCO_PLACE_TYPES = new Set([
  "auto_parts_store",
  "bank",
  "bicycle_store",
  "book_store",
  "car_dealer",
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
  "insurance_agency",
  "jewelry_store",
  "pet_store",
  "shoe_store",
  "sporting_goods_store",
  "store",
  "supermarket",
  "telecommunications_service_provider",
  "travel_agency",
]);

const MEDIUM_MCO_PLACE_TYPES = new Set([
  "bar",
  "bakery",
  "bed_and_breakfast",
  "bowling_alley",
  "cafe",
  "campground",
  "car_rental",
  "catering_service",
  "coffee_shop",
  "fast_food_restaurant",
  "gym",
  "hostel",
  "hotel",
  "lodging",
  "meal_takeaway",
  "motel",
  "movie_theater",
  "real_estate_agency",
  "resort_hotel",
  "restaurant",
  "wholesaler",
]);

const CONTEXTUAL_MCO_PLACE_TYPES = new Set([
  "barber_shop",
  "beauty_salon",
  "courier_service",
  "food_court",
  "hair_salon",
  "laundry",
  "nail_salon",
  "pharmacy",
  "post_office",
  "shopping_mall",
  "spa",
  "storage",
  "tailor",
  "tourist_information_center",
]);

const STRONG_MCO_CATEGORY_TERMS = [
  "supermarche",
  "hypermarche",
  "grand magasin",
  "commerce de detail",
  "magasin",
  "boutique",
  "distribution",
  "retail",
  "telephonie",
  "concession automobile",
  "car dealer",
  "agence bancaire",
  "banque",
  "assurance",
  "agence de voyage",
];

const MEDIUM_MCO_CATEGORY_TERMS = [
  "agence immobiliere",
  "commerce de gros",
  "grossiste",
  "hotel",
  "restauration",
  "restaurant",
  "fast food",
  "cafe",
  "boulangerie",
  "gym",
  "fitness",
];

const CONTEXTUAL_MCO_CATEGORY_TERMS = [
  "centre commercial",
  "shopping mall",
  "aire de restauration",
  "food court",
  "pharmacie",
  "sante",
  "medical",
  "cabinet",
  "artisan",
  "salon de coiffure",
  "salon de beaute",
  "association",
  "administration",
  "ecole",
  "centre de formation",
  "entrepot",
];

const FRENCH_STOP_WORDS = new Set([
  "avec",
  "dans",
  "pour",
  "vous",
  "votre",
  "nous",
  "notre",
  "leur",
  "leurs",
  "cette",
  "comme",
  "plus",
  "tout",
  "tous",
  "toute",
  "toutes",
  "mais",
  "donc",
  "entre",
  "ainsi",
  "poste",
  "offre",
  "emploi",
  "entreprise",
  "experience",
  "competence",
  "travail",
  "equipe",
  "annee",
  "depuis",
  "chez",
  "suis",
  "etre",
  "fait",
  "faire",
]);

function normalizeText(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9+# ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function containsKeyword(text: string, keyword: string) {
  return normalizeText(text).includes(normalizeText(keyword));
}

function unique<T>(values: readonly T[]) {
  return [...new Set(values)];
}

function usableProfile(
  profile: CandidateProfile | undefined,
): CandidateProfile | undefined {
  if (!profile) return undefined;
  return profile.targetRoles.length > 0 ||
    profile.skills.length > 0 ||
    profile.sectors.length > 0 ||
    profile.keywords.length > 0
    ? profile
    : undefined;
}

function deriveOpportunityLevel(input: ScoreEmployerInput): OpportunityLevel {
  const trustedPublicOffer = input.siteInspection.evidence.some(
    (evidence) => evidence.level === "public-offer" && isTrustedPublicOffer(evidence),
  );
  if (trustedPublicOffer) return "public-offer";
  const trustedRecruitmentPage = input.siteInspection.evidence.some(
    (evidence) => isTrustedRecruitmentPage(evidence),
  );
  if (trustedRecruitmentPage || input.siteInspection.recruitmentPageUrl) {
    return "recruitment-page";
  }
  return "prospecting";
}

function isTrustedRecruitmentPage(
  evidence: SiteInspection["evidence"][number],
) {
  if (evidence.level !== "recruitment-page") return false;
  if (evidence.sourceKind === "employer-site") {
    return evidence.directEmployer !== false;
  }
  return (
    evidence.sourceKind === "employer-ats" && evidence.directEmployer === true
  );
}

function isTrustedPublicOffer(
  evidence: SiteInspection["evidence"][number],
) {
  if (!evidence.sourceKind) return false;
  if (evidence.sourceKind === "employer-site") {
    return evidence.directEmployer !== false;
  }
  if (evidence.sourceKind === "employer-ats") {
    return evidence.directEmployer === true;
  }
  return evidence.sourceKind === "official-job-service";
}

function opportunityPoints(input: ScoreEmployerInput, level: OpportunityLevel) {
  if (level !== "public-offer") return OPPORTUNITY_POINTS[level];
  const points = input.siteInspection.evidence
    .filter(
      (evidence) =>
        evidence.level === "public-offer" && isTrustedPublicOffer(evidence),
    )
    .map((evidence) => {
      if (evidence.sourceKind === "employer-site") return 35;
      if (evidence.sourceKind === "employer-ats") return 33;
      return 31;
    });
  return points.length ? Math.max(...points) : 18;
}

function opportunityReason(level: OpportunityLevel, points: number) {
  if (level === "public-offer") {
    return `Opportunité ${points}/${SCORE_WEIGHTS.opportunity} : une offre publique a été repérée.`;
  }
  if (level === "recruitment-page") {
    return `Opportunité ${points}/${SCORE_WEIGHTS.opportunity} : l’entreprise dispose d’un espace recrutement, sans offre compatible publique confirmée.`;
  }
  return `Opportunité ${points}/${SCORE_WEIGHTS.opportunity} : aucune offre publique ni page recrutement n’a été confirmée ; piste de candidature spontanée.`;
}

function employerCorpus(input: ScoreEmployerInput) {
  return [
    input.name,
    input.category,
    ...input.siteInspection.matchedKeywords,
    ...input.siteInspection.evidence
      .filter(
        (evidence) =>
          evidence.level === "public-offer" && isTrustedPublicOffer(evidence),
      )
      .flatMap(({ title, excerpt }) => [title, excerpt]),
  ].join(" ");
}

function scoreMcoFit(input: ScoreEmployerInput) {
  const corpus = employerCorpus(input);
  const normalizedCategory = normalizeText(input.category);
  const retailFit = RETAIL_CATEGORY_TERMS.some((term) =>
    normalizedCategory.includes(normalizeText(term)),
  );
  const structuralFit = structuralMcoFit(input);
  const matchingRoles = MCO_PROFILE.roleKeywords.filter((keyword) =>
    containsKeyword(corpus, keyword),
  );
  const matchingApprenticeship = MCO_PROFILE.apprenticeshipKeywords.filter((keyword) =>
    containsKeyword(corpus, keyword),
  );
  const matchingGroups = MCO_PROFILE.competencyGroups.filter(({ keywords }) =>
    keywords.some((keyword) => containsKeyword(corpus, keyword)),
  );

  const categoryPoints =
    retailFit || structuralFit.level === "strong"
      ? 10
      : structuralFit.level === "medium"
        ? 6
        : structuralFit.level === "contextual"
          ? 2
          : 0;
  const rolePoints = matchingRoles.length > 0 ? 8 : 0;
  const apprenticeshipPoints = matchingApprenticeship.length > 0 ? 6 : 0;
  const competencyPoints = Math.min(6, matchingGroups.length * 2);
  const points = Math.min(
    SCORE_WEIGHTS.btsMcoFit,
    categoryPoints + rolePoints + apprenticeshipPoints + competencyPoints,
  );

  const signals = [
    retailFit || structuralFit.level === "strong"
      ? "secteur commerce/service client"
      : structuralFit.level === "medium"
        ? "secteur avec relation client à confirmer"
        : structuralFit.level === "contextual"
          ? "missions commerciales à vérifier"
          : undefined,
    matchingRoles[0] ? `métier « ${matchingRoles[0]} »` : undefined,
    matchingApprenticeship[0] ? `alternance « ${matchingApprenticeship[0]} »` : undefined,
    ...matchingGroups.map(({ label }) => label.toLowerCase()),
  ].filter((value): value is string => Boolean(value));

  return { points, signals: unique(signals), personalized: false as const };
}

function tokens(text: string) {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter(
        (token) =>
          token.length >= 4 &&
          !/^\d+$/.test(token) &&
          !FRENCH_STOP_WORDS.has(token),
      ),
  );
}

function matchesProfileConcept(corpus: string, concept: string): boolean {
  const corpusTokens = tokens(corpus);

  return expandCvProfileConcept(concept).some((phrase) => {
    if (containsKeyword(corpus, phrase)) return true;
    const conceptTokens = [...tokens(phrase)];
    if (conceptTokens.length === 0) return false;
    const matches = conceptTokens.filter((token) => corpusTokens.has(token)).length;
    return matches >= Math.max(1, Math.ceil(conceptTokens.length * 0.7));
  });
}

function scoreCandidateTargetFit(
  input: ScoreEmployerInput,
  profile: CandidateProfile,
) {
  const corpus = employerCorpus(input);
  const normalizedCategory = normalizeText(input.category);
  const matchingRoles = profile.targetRoles.filter((role) =>
    matchesProfileConcept(corpus, role),
  );
  const matchingSectors = profile.sectors.filter((sector) => {
    if (matchesProfileConcept(corpus, sector)) return true;
    const normalizedSector = normalizeText(sector);
    const commerceSector = [
      "commerce",
      "distribution",
      "retail",
      "vente",
    ].some((term) => normalizedSector.includes(term));
    return (
      commerceSector &&
      RETAIL_CATEGORY_TERMS.some((term) =>
        normalizedCategory.includes(normalizeText(term)),
      )
    );
  });

  const rolePoints = matchingRoles.length > 0 ? 20 : 0;
  const sectorPoints = Math.min(10, matchingSectors.length * 10);
  const points = Math.min(
    SCORE_WEIGHTS.btsMcoFit,
    rolePoints + sectorPoints,
  );
  const signals = unique([
    ...matchingRoles.slice(0, 2).map((role) => `métier « ${role} »`),
    ...matchingSectors.slice(0, 2).map((sector) => `secteur « ${sector} »`),
  ]);
  return { points, signals, personalized: true as const };
}

function isBtsMcoProfile(profile: CandidateProfile) {
  const explicitProfileText = normalizeText(
    [profile.diploma, profile.headline, ...profile.keywords]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );

  return (
    explicitProfileText.includes("bts mco") ||
    explicitProfileText.includes("management commercial operationnel") ||
    explicitProfileText.includes("rncp 38362") ||
    explicitProfileText.includes("rncp38362")
  );
}

function scoreTargetFit(input: ScoreEmployerInput) {
  const profile = usableProfile(input.profile);
  if (!profile) return scoreMcoFit(input);

  const personalizedFit = scoreCandidateTargetFit(input, profile);
  if (!isBtsMcoProfile(profile)) return personalizedFit;

  const mcoFit = scoreMcoFit(input);
  return {
    points: Math.min(
      SCORE_WEIGHTS.btsMcoFit,
      mcoFit.points + personalizedFit.points,
    ),
    signals: unique([
      ...mcoFit.signals.map((signal) => `socle BTS MCO : ${signal}`),
      ...personalizedFit.signals.map(
        (signal) => `cible du profil : ${signal}`,
      ),
    ]),
    personalized: true as const,
  };
}

function scoreCvFit(input: ScoreEmployerInput) {
  const profile = usableProfile(input.profile);
  if (profile) {
    const corpus = employerCorpus(input);
    const matchingSkills = profile.skills.filter((skill) =>
      matchesProfileConcept(corpus, skill),
    );
    const matchingKeywords = profile.keywords.filter((keyword) =>
      matchesProfileConcept(corpus, keyword),
    );
    const skillPoints = Math.min(12, matchingSkills.length * 3);
    const keywordPoints = Math.min(3, matchingKeywords.length);
    return {
      points: Math.min(SCORE_WEIGHTS.cvFit, skillPoints + keywordPoints),
      matches: unique([...matchingSkills, ...matchingKeywords]).slice(0, 5),
      supplied: true,
      personalized: true,
    };
  }

  return {
    points: 0,
    matches: [] as string[],
    supplied: false,
    personalized: false,
  };
}

type StructuralMcoFit = {
  level: "strong" | "medium" | "contextual" | "unknown";
  baseScore: number;
  reason: string;
  source: "place-type" | "category" | "unknown";
};

function structuralMcoFit(input: ScoreEmployerInput): StructuralMcoFit {
  const placeTypes = new Set(
    (input.placeTypes ?? []).map((value) => value.trim().toLowerCase()),
  );
  const category = normalizeText(input.category);

  if ([...placeTypes].some((value) => CONTEXTUAL_MCO_PLACE_TYPES.has(value))) {
    return {
      level: "contextual",
      baseScore: 20,
      reason:
        "Ce type d’établissement est réglementé, artisanal, non commercial ou ne désigne pas directement un employeur : les missions MCO doivent être vérifiées.",
      source: "place-type",
    };
  }
  // A wholesaler can expose genuine B2B sales and customer-management work,
  // but a generic `store` type must not turn it into a direct retail match.
  if (placeTypes.has("wholesaler")) {
    return {
      level: "medium",
      baseScore: 50,
      reason:
        "Le commerce de gros peut proposer des missions commerciales B2B ou de relation client, à confirmer selon l’organisation et le poste local.",
      source: "place-type",
    };
  }
  if ([...placeTypes].some((value) => STRONG_MCO_PLACE_TYPES.has(value))) {
    return {
      level: "strong",
      baseScore: 60,
      reason:
        "L’activité correspond directement à une unité commerciale où la vente, la relation client et l’animation de l’offre sont centrales en BTS MCO.",
      source: "place-type",
    };
  }
  if ([...placeTypes].some((value) => MEDIUM_MCO_PLACE_TYPES.has(value))) {
    return {
      level: "medium",
      baseScore: 50,
      reason:
        "L’activité peut accueillir des missions de relation client ou de management, sous réserve du poste proposé et de l’organisation locale.",
      source: "place-type",
    };
  }
  if (CONTEXTUAL_MCO_CATEGORY_TERMS.some((term) => category.includes(term))) {
    return {
      level: "contextual",
      baseScore: 20,
      reason:
        "La catégorie indique une activité réglementée, artisanale, non commerciale ou indirecte : les missions MCO doivent être vérifiées.",
      source: "category",
    };
  }
  if (STRONG_MCO_CATEGORY_TERMS.some((term) => category.includes(term))) {
    return {
      level: "strong",
      baseScore: 60,
      reason:
        "La catégorie correspond à une unité commerciale où la vente, la relation client et l’animation de l’offre sont centrales en BTS MCO.",
      source: "category",
    };
  }
  if (MEDIUM_MCO_CATEGORY_TERMS.some((term) => category.includes(term))) {
    return {
      level: "medium",
      baseScore: 50,
      reason:
        "La catégorie peut accueillir des missions de relation client ou de management, sous réserve du poste proposé et de l’organisation locale.",
      source: "category",
    };
  }
  return {
    level: "unknown",
    baseScore: 35,
    reason:
      "La catégorie disponible ne suffit pas à confirmer l’adéquation avec les missions du BTS MCO.",
    source: "unknown",
  };
}

function applicationWebsiteStatus(
  input: ScoreEmployerInput,
): ApplicationPotential["websiteStatus"] {
  if (!input.websiteUrl) return "not-listed";
  if (input.siteInspection.status === "blocked") return "blocked";
  if (input.siteInspection.status === "unreachable") return "unreachable";
  if (
    input.siteInspection.status === "checked" &&
    input.siteInspection.pagesChecked > 0
  ) {
    return "found-and-checked";
  }
  return "found-not-checked";
}

function applicationCvBonus(input: ScoreEmployerInput): number {
  const profile = usableProfile(input.profile);
  if (!profile) return 0;
  const targetFit = scoreCandidateTargetFit(input, profile);
  const cvFit = scoreCvFit(input);
  const targetPoints = Math.round(
    (targetFit.points / SCORE_WEIGHTS.btsMcoFit) * 12,
  );
  const skillPoints = Math.round((cvFit.points / SCORE_WEIGHTS.cvFit) * 8);
  return Math.min(20, targetPoints + skillPoints);
}

function potentialLevel(score: number): ApplicationPotential["level"] {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  if (score >= 30) return "to-qualify";
  return "low";
}

function applicationConfidence(
  fit: StructuralMcoFit,
  websiteStatus: ApplicationPotential["websiteStatus"],
  hasHiringSignal: boolean,
): ApplicationPotential["confidence"] {
  if (hasHiringSignal) return "high";
  if (websiteStatus === "found-and-checked") {
    return fit.source === "place-type" ? "high" : "medium";
  }
  if (
    fit.source === "place-type" &&
    websiteStatus === "found-not-checked"
  ) {
    return "medium";
  }
  return "low";
}

function websiteAssessmentReason(
  websiteStatus: ApplicationPotential["websiteStatus"],
): string {
  if (websiteStatus === "found-and-checked") {
    return "Le site public de l’employeur a été consulté pendant cette recherche.";
  }
  if (websiteStatus === "found-not-checked") {
    return "Un site public a été trouvé, mais il n’a pas été inspecté pendant cette recherche.";
  }
  if (websiteStatus === "blocked") {
    return "Un site public a été trouvé, mais il a refusé l’analyse automatisée.";
  }
  if (websiteStatus === "unreachable") {
    return "Un site public a été trouvé, mais il était inaccessible pendant cette recherche.";
  }
  return "Aucun site public n’est indiqué par les sources consultées ; cela ne réduit pas l’adéquation métier, mais rend l’évaluation moins certaine.";
}

function recommendedApplicationAction(
  input: ScoreEmployerInput,
  fit: StructuralMcoFit,
  websiteStatus: ApplicationPotential["websiteStatus"],
  opportunityLevel: OpportunityLevel,
  hasOfficialRecruiterSignal: boolean,
): string {
  const normalizedTypes = new Set(input.placeTypes ?? []);
  if (
    normalizedTypes.has("shopping_mall") ||
    normalizeText(input.category).includes("centre commercial")
  ) {
    return "Ouvrir Google Maps et cibler les enseignes présentes dans ce centre, puis contacter chaque magasin plutôt que le centre lui-même.";
  }
  if (opportunityLevel === "public-offer") {
    return "Consulter l’offre publique, vérifier qu’elle accepte le BTS MCO, puis candidater depuis la source indiquée.";
  }
  if (opportunityLevel === "recruitment-page") {
    return "Ouvrir la page recrutement, envoyer une candidature ciblée et appeler l’établissement pour demander le responsable de l’unité commerciale.";
  }
  if (hasOfficialRecruiterSignal) {
    return "Ouvrir la piste La Bonne Alternance, puis contacter directement l’établissement avec un CV et un message adapté à son activité.";
  }
  if (fit.level === "contextual") {
    return "Vérifier d’abord qu’un poste comporte bien de la vente, de la relation client ou du management, puis contacter l’établissement si ces missions existent.";
  }
  if (websiteStatus === "not-listed") {
    return "Passer sur place à une heure calme avec un CV, demander le responsable et proposer une candidature spontanée adaptée à l’activité du commerce.";
  }
  if (websiteStatus === "found-and-checked") {
    return "Utiliser les coordonnées du site pour envoyer une candidature spontanée, puis relancer directement le responsable de l’établissement.";
  }
  return "Depuis la fiche Google Maps, vérifier le site indiqué, puis appeler ou passer sur place avec un CV.";
}

function scoreApplicationPotential(
  input: ScoreEmployerInput,
  opportunityLevel: OpportunityLevel,
): ApplicationPotential {
  const fit = structuralMcoFit(input);
  const websiteStatus = applicationWebsiteStatus(input);
  const trustedPublicOffer = input.siteInspection.evidence.some(
    (evidence) =>
      evidence.level === "public-offer" && isTrustedPublicOffer(evidence),
  );
  const trustedRecruitmentPage = input.siteInspection.evidence.some(
    isTrustedRecruitmentPage,
  ) || Boolean(input.siteInspection.recruitmentPageUrl);
  const hasOfficialRecruiterSignal = input.siteInspection.evidence.some(
    (evidence) =>
      evidence.level === "prospecting" &&
      evidence.sourceKind === "official-job-service",
  );
  const cvBonus = applicationCvBonus(input);
  const hiringSignalBonus = trustedRecruitmentPage || hasOfficialRecruiterSignal
    ? 15
    : 0;
  const score = trustedPublicOffer
    ? 100
    : Math.min(99, fit.baseScore + cvBonus + hiringSignalBonus);

  const reasons = [fit.reason];
  if (cvBonus > 0) {
    reasons.push(
      `Le profil CV ajoute ${cvBonus}/20 à la priorité grâce aux métiers, secteurs ou compétences concordants.`,
    );
  }
  if (trustedPublicOffer) {
    reasons.push(
      "Une offre publique issue d’une source fiable a été repérée ; elle reste à vérifier avant toute candidature.",
    );
  } else if (trustedRecruitmentPage) {
    reasons.push(
      "Une page recrutement de l’employeur confirme un canal de candidature, sans garantir une place disponible.",
    );
  } else if (hasOfficialRecruiterSignal) {
    reasons.push(
      "La Bonne Alternance signale cet employeur comme piste de candidature spontanée, sans offre publique confirmée.",
    );
  }
  reasons.push(websiteAssessmentReason(websiteStatus));

  return {
    score,
    level: potentialLevel(score),
    confidence: applicationConfidence(
      fit,
      websiteStatus,
      trustedPublicOffer || trustedRecruitmentPage || hasOfficialRecruiterSignal,
    ),
    websiteStatus,
    reasons,
    recommendedAction: recommendedApplicationAction(
      input,
      fit,
      websiteStatus,
      opportunityLevel,
      hasOfficialRecruiterSignal,
    ),
  };
}

function bestTravelEstimate(
  travel: Partial<Record<TravelMode, TravelEstimate>> | undefined,
) {
  return Object.values(travel ?? {})
    .filter(
      (estimate): estimate is TravelEstimate =>
        Boolean(estimate) &&
        estimate.status === "available" &&
        Number.isFinite(estimate.durationMinutes) &&
        estimate.durationMinutes >= 0,
    )
    .sort((left, right) => left.durationMinutes - right.durationMinutes)[0];
}

function commutePoints(durationMinutes: number) {
  if (durationMinutes <= 15) return 20;
  if (durationMinutes <= 30) return 16;
  if (durationMinutes <= 45) return 12;
  if (durationMinutes <= 60) return 8;
  if (durationMinutes <= 90) return 4;
  return 1;
}

function modeLabel(mode: TravelMode) {
  const labels: Record<TravelMode, string> = {
    TRANSIT: "transports en commun",
    DRIVE: "voiture",
    BICYCLE: "vélo",
    WALK: "marche",
    TWO_WHEELER: "deux-roues motorisé",
  };
  return labels[mode];
}

/** Compute a deterministic 100-point score and an explanation for every component. */
export function scoreEmployerMatch(input: ScoreEmployerInput): ScoreResult {
  const opportunityLevel = deriveOpportunityLevel(input);
  const opportunity = opportunityPoints(input, opportunityLevel);
  const mcoFit = scoreTargetFit(input);
  const cvFit = scoreCvFit(input);
  const bestTravel = bestTravelEstimate(input.travel);
  const commute = bestTravel ? commutePoints(bestTravel.durationMinutes) : 0;
  const applicationPotential = scoreApplicationPotential(
    input,
    opportunityLevel,
  );

  const score: MatchBreakdown = {
    opportunity,
    btsMcoFit: mcoFit.points,
    cvFit: cvFit.points,
    commute,
    total: opportunity + mcoFit.points + cvFit.points + commute,
  };

  const reasons = [
    opportunityReason(opportunityLevel, opportunity),
    mcoFit.signals.length > 0
      ? `${mcoFit.personalized ? "Profil métier" : "BTS MCO"} ${mcoFit.points}/${SCORE_WEIGHTS.btsMcoFit} : ${mcoFit.signals.join(", ")}.`
      : mcoFit.personalized
        ? `Profil métier 0/${SCORE_WEIGHTS.btsMcoFit} : aucun métier ou secteur ciblé dans le CV n’a été retrouvé.`
        : `BTS MCO 0/${SCORE_WEIGHTS.btsMcoFit} : aucun signal métier ou secteur MCO explicite n’a été trouvé.`,
    cvFit.supplied
      ? cvFit.matches.length > 0
        ? `${cvFit.personalized ? "Compétences CV" : "CV"} ${cvFit.points}/${SCORE_WEIGHTS.cvFit} : correspondances ${cvFit.matches.join(", ")}.`
        : `${cvFit.personalized ? "Compétences CV" : "CV"} 0/${SCORE_WEIGHTS.cvFit} : aucune correspondance suffisamment précise n’a été trouvée.`
      : `CV 0/${SCORE_WEIGHTS.cvFit} : aucun CV n’a été fourni pour personnaliser ce volet.`,
    bestTravel
      ? `Trajet ${commute}/${SCORE_WEIGHTS.commute} : ${Math.round(bestTravel.durationMinutes)} min en ${modeLabel(bestTravel.mode)}.`
      : `Trajet 0/${SCORE_WEIGHTS.commute} : aucun temps de trajet n’est disponible.`,
  ];

  return { score, reasons, opportunityLevel, applicationPotential };
}

