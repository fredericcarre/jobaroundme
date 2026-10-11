import type { CandidateProfile } from "@/lib/types";

type ConceptDefinition = {
  label: string;
  aliases: readonly string[];
};

type MatchedConcept = {
  label: string;
  index: number;
};

type RomeRule = {
  code: string;
  label: string;
  roles: readonly string[];
  skills: readonly string[];
};

const MAX_ANALYZED_CHARACTERS = 30_000;
const MAX_TARGET_ROLES = 6;
const MAX_SKILLS = 14;
const MAX_SECTORS = 6;
const MAX_KEYWORDS = 24;
const MAX_CONCEPT_MATCH_PHRASES = 24;

const BTS_MCO_LABEL = "BTS Management commercial opérationnel (RNCP 38362)";

/** ROME codes the deterministic profile engine can emit. */
export const CV_PROFILE_ROME_CODES = [
  "D1301",
  "D1401",
  "D1501",
  "D1502",
  "D1503",
  "D1506",
  "M1704",
  "M1705",
] as const;

const BTS_MCO_ALIASES = [
  "bts mco",
  "bts management commercial operationnel",
  "brevet de technicien superieur management commercial operationnel",
  "rncp 38362",
  "rncp38362",
] as const;

const APPRENTICESHIP_ALIASES = [
  "alternance",
  "alternant",
  "alternante",
  "apprentissage",
  "apprenti",
  "apprentie",
  "contrat de professionnalisation",
] as const;

const ROLE_DEFINITIONS: readonly ConceptDefinition[] = [
  {
    label: "Conseiller de vente",
    aliases: [
      "conseiller de vente",
      "conseillere de vente",
      "vendeur conseil",
      "vendeuse conseil",
      "vendeur polyvalent",
      "vendeuse polyvalente",
      "vendeur",
      "vendeuse",
      "conseiller commercial",
      "conseillere commerciale",
      "sales assistant",
      "sales advisor",
    ],
  },
  {
    label: "Employé commercial",
    aliases: [
      "employe commercial",
      "employee commerciale",
      "employe libre service",
      "employee libre service",
      "employe de rayon",
      "employee de rayon",
      "employe polyvalent",
      "employee polyvalente",
      "retail assistant",
    ],
  },
  {
    label: "Chargé de clientèle",
    aliases: [
      "charge de clientele",
      "chargee de clientele",
      "conseiller clientele",
      "conseillere clientele",
      "customer service advisor",
      "customer advisor",
    ],
  },
  {
    label: "Assistant manager",
    aliases: [
      "assistant manager",
      "assistante manager",
      "manager adjoint",
      "manager adjointe",
      "responsable adjoint",
      "responsable adjointe",
      "assistant store manager",
    ],
  },
  {
    label: "Manager de rayon",
    aliases: [
      "manager de rayon",
      "chef de rayon",
      "cheffe de rayon",
      "responsable de rayon",
    ],
  },
  {
    label: "Marchandiseur",
    aliases: [
      "marchandiseur",
      "marchandiseuse",
      "merchandiser",
      "visual merchandiser",
    ],
  },
  {
    label: "Hôte de caisse",
    aliases: [
      "hote de caisse",
      "hotesse de caisse",
      "caissier",
      "caissiere",
      "cashier",
    ],
  },
  {
    label: "Assistant commercial",
    aliases: [
      "assistant commercial",
      "assistante commerciale",
      "sales administrator",
    ],
  },
  {
    label: "Responsable de point de vente",
    aliases: [
      "responsable de point de vente",
      "responsable de magasin",
      "directeur de magasin",
      "directrice de magasin",
      "store manager",
    ],
  },
  {
    label: "Équipier polyvalent",
    aliases: [
      "equipier polyvalent",
      "equipiere polyvalente",
      "equipier de commerce",
      "equipiere de commerce",
      "crew member",
    ],
  },
] as const;

const SKILL_DEFINITIONS: readonly ConceptDefinition[] = [
  {
    label: "Vente conseil",
    aliases: [
      "vente conseil",
      "techniques de vente",
      "argumentaire de vente",
      "argumentation commerciale",
      "conclusion de vente",
      "sales techniques",
    ],
  },
  {
    label: "Relation client",
    aliases: [
      "relation client",
      "relations clients",
      "service client",
      "satisfaction client",
      "customer service",
      "customer relations",
    ],
  },
  {
    label: "Accueil et conseil client",
    aliases: [
      "accueil client",
      "accueil des clients",
      "conseil client",
      "conseiller les clients",
      "ecoute des besoins",
      "analyse des besoins",
      "customer advice",
    ],
  },
  {
    label: "Fidélisation",
    aliases: [
      "fidelisation",
      "fideliser les clients",
      "programme de fidelite",
      "customer loyalty",
    ],
  },
  {
    label: "Encaissement",
    aliases: [
      "encaissement",
      "tenue de caisse",
      "gestion de caisse",
      "ouverture de caisse",
      "fermeture de caisse",
      "cash register",
      "cash handling",
    ],
  },
  {
    label: "Merchandising",
    aliases: [
      "merchandising",
      "marchandisage",
      "implantation des produits",
      "implantation produit",
      "visual merchandising",
    ],
  },
  {
    label: "Mise en rayon",
    aliases: [
      "mise en rayon",
      "reassort des rayons",
      "reassortiment",
      "facing",
      "shelf stocking",
    ],
  },
  {
    label: "Gestion des stocks",
    aliases: [
      "gestion des stocks",
      "gestion de stock",
      "suivi des stocks",
      "controle des stocks",
      "reception de marchandises",
      "inventory control",
    ],
  },
  {
    label: "Inventaire",
    aliases: ["inventaire", "inventaires", "inventory count", "stocktaking"],
  },
  {
    label: "Animation commerciale",
    aliases: [
      "animation commerciale",
      "animations commerciales",
      "operation promotionnelle",
      "operations promotionnelles",
      "promotion des ventes",
      "sales promotion",
    ],
  },
  {
    label: "Gestion opérationnelle",
    aliases: [
      "gestion operationnelle",
      "gestion du point de vente",
      "ouverture du magasin",
      "fermeture du magasin",
      "store operations",
    ],
  },
  {
    label: "Pilotage de la performance commerciale",
    aliases: [
      "indicateurs commerciaux",
      "indicateurs de performance",
      "tableau de bord commercial",
      "chiffre d affaires",
      "taux de marge",
      "marge commerciale",
      "objectifs de vente",
      "sales kpi",
    ],
  },
  {
    label: "Management d’équipe",
    aliases: [
      "management d equipe",
      "animation d equipe",
      "encadrement d equipe",
      "coordination d equipe",
      "formation des nouveaux",
      "repartition des taches",
      "team management",
      "team supervision",
    ],
  },
  {
    label: "Organisation et planning",
    aliases: [
      "gestion des plannings",
      "gestion du planning",
      "planification des equipes",
      "organisation du travail",
      "workforce planning",
    ],
  },
  {
    label: "E-commerce et omnicanal",
    aliases: [
      "e commerce",
      "commerce en ligne",
      "omnicanal",
      "click and collect",
      "web to store",
      "online retail",
    ],
  },
  {
    label: "Communication commerciale",
    aliases: [
      "communication commerciale",
      "communication en magasin",
      "reseaux sociaux du magasin",
      "supports commerciaux",
    ],
  },
  {
    label: "Prospection commerciale",
    aliases: [
      "prospection commerciale",
      "prospection telephonique",
      "developpement commercial",
      "prise de rendez vous",
      "lead generation",
    ],
  },
  {
    label: "Outils CRM",
    aliases: ["logiciel crm", "outil crm", "salesforce", "hubspot"],
  },
] as const;

const SECTOR_DEFINITIONS: readonly ConceptDefinition[] = [
  {
    label: "Grande distribution",
    aliases: [
      "grande distribution",
      "supermarche",
      "hypermarche",
      "retail alimentaire",
    ],
  },
  {
    label: "Commerce de détail",
    aliases: ["commerce de detail", "retail", "boutique specialisee"],
  },
  {
    label: "Mode et textile",
    aliases: [
      "secteur de la mode",
      "magasin de mode",
      "mode et textile",
      "textile",
      "habillement",
      "pret a porter",
      "chaussures",
    ],
  },
  {
    label: "Beauté et cosmétique",
    aliases: [
      "beaute",
      "cosmetique",
      "parfumerie",
      "esthetique",
      "beauty retail",
    ],
  },
  {
    label: "Sport et loisirs",
    aliases: ["articles de sport", "magasin de sport", "sport et loisirs"],
  },
  {
    label: "Banque et assurance",
    aliases: ["banque", "assurance", "services bancaires", "banking"],
  },
  {
    label: "Téléphonie et électronique",
    aliases: [
      "telephonie",
      "smartphone",
      "electronique grand public",
      "produits electroniques",
    ],
  },
  {
    label: "Automobile",
    aliases: ["automobile", "concession automobile", "vente de vehicules"],
  },
  {
    label: "Hôtellerie-restauration",
    aliases: [
      "hotellerie",
      "restauration",
      "restaurant",
      "fast food",
      "restauration rapide",
      "hospitality",
    ],
  },
  {
    label: "Alimentation",
    aliases: [
      "commerce alimentaire",
      "epicerie",
      "boulangerie",
      "produits alimentaires",
    ],
  },
  {
    label: "Bricolage et équipement de la maison",
    aliases: [
      "bricolage",
      "ameublement",
      "decoration interieure",
      "equipement de la maison",
    ],
  },
  {
    label: "E-commerce",
    aliases: ["e commerce", "commerce en ligne", "pure player", "marketplace"],
  },
] as const;

const ROME_RULES: readonly RomeRule[] = [
  {
    code: "D1301",
    label: "Management de magasin de détail",
    roles: ["Assistant manager", "Responsable de point de vente"],
    skills: [
      "Management d’équipe",
      "Gestion opérationnelle",
      "Organisation et planning",
      "Pilotage de la performance commerciale",
    ],
  },
  {
    code: "D1401",
    label: "Assistanat commercial",
    roles: ["Assistant commercial"],
    skills: ["Prospection commerciale", "Outils CRM"],
  },
  {
    code: "D1501",
    label: "Animation de vente",
    roles: [
      "Conseiller de vente",
      "Employé commercial",
      "Hôte de caisse",
      "Équipier polyvalent",
    ],
    skills: [
      "Vente conseil",
      "Accueil et conseil client",
      "Animation commerciale",
      "Encaissement",
    ],
  },
  {
    code: "D1502",
    label: "Management de rayon produits alimentaires",
    roles: ["Manager de rayon"],
    skills: [],
  },
  {
    code: "D1503",
    label: "Management de rayon produits non alimentaires",
    roles: ["Manager de rayon"],
    skills: [],
  },
  {
    code: "D1506",
    label: "Marchandisage",
    roles: ["Marchandiseur", "Employé commercial"],
    skills: [
      "Merchandising",
      "Mise en rayon",
      "Gestion des stocks",
      "Inventaire",
    ],
  },
  {
    code: "M1704",
    label: "Management relation clientèle",
    roles: ["Chargé de clientèle"],
    skills: [
      "Relation client",
      "Fidélisation",
      "Outils CRM",
    ],
  },
  {
    code: "M1705",
    label: "Marketing",
    roles: [],
    skills: [
      "Animation commerciale",
      "E-commerce et omnicanal",
      "Communication commerciale",
      "Pilotage de la performance commerciale",
    ],
  },
] as const;

const NEGATED_CONTEXTS = [
  /sans (?:aucune )?experience(?: professionnelle)? (?:en|de|dans|comme)?$/,
  /aucune experience(?: professionnelle)? (?:en|de|dans|comme)?$/,
  /pas d experience(?: professionnelle)? (?:en|de|dans|comme)?$/,
  /ne (?:maitrise|connais|pratique) pas$/,
  /non maitrise$/,
] as const;

const ASPIRATIONAL_CONTEXTS = [
  /(?:souhaite|voudrais|veux) (?:apprendre|decouvrir|me former|developper mes competences)(?: en| au| a la| le| la| les)?$/,
  /objectif(?: professionnel)? (?:apprendre|decouvrir|me former)(?: en| au| a la| le| la| les)?$/,
  /(?:a|à) apprendre$/,
] as const;

/** Normalizes OCR/PDF punctuation while preserving word boundaries. */
function normalizeForMatching(value: string) {
  return value
    .slice(0, MAX_ANALYZED_CHARACTERS)
    .replace(/([\p{L}])[-‐‑‒–—]\s*\n\s*([\p{L}])/gu, "$1$2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`´]/g, " ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROFILE_CONCEPT_DEFINITIONS: readonly ConceptDefinition[] = [
  ...ROLE_DEFINITIONS,
  ...SKILL_DEFINITIONS,
  ...SECTOR_DEFINITIONS,
];

function buildConceptPhraseIndex() {
  const index = new Map<string, string[]>();

  for (const definition of PROFILE_CONCEPT_DEFINITIONS) {
    const phrases = unique([definition.label, ...definition.aliases]);
    const lookupKeys = unique(phrases.map(normalizeForMatching).filter(Boolean));

    for (const key of lookupKeys) {
      index.set(
        key,
        unique([...(index.get(key) ?? []), ...phrases]).slice(
          0,
          MAX_CONCEPT_MATCH_PHRASES,
        ),
      );
    }
  }

  return index;
}

const CONCEPT_PHRASES_BY_ALIAS = buildConceptPhraseIndex();

/**
 * Expands a canonical CV concept (or one of its known aliases) to a small,
 * deterministic set of equivalent phrases for downstream matching.
 */
export function expandCvProfileConcept(concept: string): readonly string[] {
  const trimmedConcept = concept.trim();
  if (!trimmedConcept) return [];

  return (
    CONCEPT_PHRASES_BY_ALIAS.get(normalizeForMatching(trimmedConcept)) ?? [
      trimmedConcept,
    ]
  );
}

function phraseIndex(corpus: string, phrase: string, startAt = 0) {
  const needle = normalizeForMatching(phrase);
  if (!needle) return -1;
  return ` ${corpus} `.indexOf(` ${needle} `, startAt);
}

function hasBlockedContext(
  corpus: string,
  index: number,
  includeAspirational: boolean,
) {
  const prefix = corpus.slice(Math.max(0, index - 100), index).trim();
  const patterns = includeAspirational
    ? [...NEGATED_CONTEXTS, ...ASPIRATIONAL_CONTEXTS]
    : NEGATED_CONTEXTS;
  return patterns.some((pattern) => pattern.test(prefix));
}

function firstValidAliasIndex(
  corpus: string,
  aliases: readonly string[],
  options: { blockAspirational: boolean },
) {
  let firstIndex = Number.POSITIVE_INFINITY;

  for (const alias of aliases) {
    const normalizedAlias = normalizeForMatching(alias);
    let searchFrom = 0;

    while (normalizedAlias) {
      const index = phraseIndex(corpus, normalizedAlias, searchFrom);
      if (index < 0) break;

      if (!hasBlockedContext(corpus, index, options.blockAspirational)) {
        firstIndex = Math.min(firstIndex, index);
        break;
      }
      searchFrom = index + normalizedAlias.length + 1;
    }
  }

  return Number.isFinite(firstIndex) ? firstIndex : -1;
}

function matchConcepts(
  corpus: string,
  definitions: readonly ConceptDefinition[],
  options: { blockAspirational: boolean },
) {
  return definitions
    .map((definition, definitionIndex) => ({
      label: definition.label,
      index: firstValidAliasIndex(corpus, definition.aliases, options),
      definitionIndex,
    }))
    .filter((match) => match.index >= 0)
    .sort(
      (left, right) =>
        left.index - right.index || left.definitionIndex - right.definitionIndex,
    ) satisfies Array<MatchedConcept & { definitionIndex: number }>;
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function joinLabels(values: readonly string[]) {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} et ${values.at(-1)}`;
}

function deriveRoles(skills: readonly string[]) {
  const skillSet = new Set(skills);
  const roles: string[] = [];

  if (
    ["Vente conseil", "Relation client", "Accueil et conseil client", "Fidélisation"].some(
      (skill) => skillSet.has(skill),
    )
  ) {
    roles.push("Conseiller de vente");
  }
  if (
    ["Mise en rayon", "Gestion des stocks", "Inventaire", "Encaissement"].some(
      (skill) => skillSet.has(skill),
    )
  ) {
    roles.push("Employé commercial");
  }
  if (skillSet.has("Merchandising")) roles.push("Marchandiseur");
  if (
    ["Management d’équipe", "Organisation et planning", "Gestion opérationnelle"].some(
      (skill) => skillSet.has(skill),
    )
  ) {
    roles.push("Assistant manager");
  }

  return unique(roles).slice(0, MAX_TARGET_ROLES);
}

function buildRomeCodes(
  diplomaDetected: boolean,
  explicitRoles: readonly string[],
  skills: readonly string[],
) {
  const roleSet = new Set(explicitRoles);
  const skillSet = new Set(skills);
  const matches = ROME_RULES.map((rule) => ({
    rule,
    signals: [
      ...rule.roles.filter((role) => roleSet.has(role)),
      ...rule.skills.filter((skill) => skillSet.has(skill)),
    ],
  })).filter(({ signals }) => signals.length > 0);

  if (matches.length > 0) return matches;
  if (!diplomaDetected) return [];

  const coreCodes = new Set([
    "D1301",
    "D1501",
    "D1502",
    "D1503",
    "D1506",
    "M1704",
  ]);
  return ROME_RULES.filter((rule) => coreCodes.has(rule.code)).map((rule) => ({
    rule,
    signals: ["BTS MCO explicitement mentionné"],
  }));
}

function canonicalConceptLabels(
  values: readonly string[],
  definitions: readonly ConceptDefinition[],
): string[] {
  const byAlias = new Map<string, string>();
  for (const definition of definitions) {
    for (const value of [definition.label, ...definition.aliases]) {
      byAlias.set(normalizeForMatching(value), definition.label);
    }
  }

  return unique(
    values
      .map((value) => byAlias.get(normalizeForMatching(value)))
      .filter((value): value is string => Boolean(value)),
  );
}

/** Recompute the supported ROME codes after a candidate edits the profile. */
export function deriveRomeCodesForProfile(
  profile: Pick<CandidateProfile, "diploma" | "targetRoles" | "skills">,
): string[] {
  const diploma = normalizeForMatching(profile.diploma ?? "");
  const diplomaDetected = BTS_MCO_ALIASES.some((alias) =>
    ` ${diploma} `.includes(` ${normalizeForMatching(alias)} `),
  );
  const roles = canonicalConceptLabels(profile.targetRoles, ROLE_DEFINITIONS);
  const skills = canonicalConceptLabels(profile.skills, SKILL_DEFINITIONS);
  return buildRomeCodes(diplomaDetected, roles, skills).map(
    ({ rule }) => rule.code,
  );
}

/**
 * Produces a stable search profile from professional facts explicitly present
 * in the CV. The function never extracts names, contact details, addresses,
 * age, gender, nationality, health or family information.
 */
export function analyzeCvProfile(cvText: string): CandidateProfile {
  const corpus = normalizeForMatching(cvText);
  const diplomaDetected =
    firstValidAliasIndex(corpus, BTS_MCO_ALIASES, {
      blockAspirational: false,
    }) >= 0;
  const apprenticeshipDetected =
    firstValidAliasIndex(corpus, APPRENTICESHIP_ALIASES, {
      blockAspirational: false,
    }) >= 0;

  const explicitRoleMatches = matchConcepts(corpus, ROLE_DEFINITIONS, {
    blockAspirational: false,
  }).slice(0, MAX_TARGET_ROLES);
  const skillMatches = matchConcepts(corpus, SKILL_DEFINITIONS, {
    blockAspirational: true,
  }).slice(0, MAX_SKILLS);
  const sectorMatches = matchConcepts(corpus, SECTOR_DEFINITIONS, {
    blockAspirational: false,
  }).slice(0, MAX_SECTORS);

  const explicitRoles = explicitRoleMatches.map(({ label }) => label);
  const skills = skillMatches.map(({ label }) => label);
  const sectors = sectorMatches.map(({ label }) => label);
  const derivedRoles = deriveRoles(skills);
  const targetRoles = (
    explicitRoles.length > 0
      ? explicitRoles
      : diplomaDetected
        ? ["Conseiller de vente", "Employé commercial", "Assistant manager"]
        : derivedRoles
  ).slice(0, MAX_TARGET_ROLES);

  const romeMatches = buildRomeCodes(diplomaDetected, explicitRoles, skills);
  const romeCodes = romeMatches.map(({ rule }) => rule.code);

  const headline = explicitRoles[0]
    ? diplomaDetected
      ? `${explicitRoles[0]} · BTS MCO`
      : explicitRoles[0]
    : diplomaDetected
      ? "Profil BTS MCO — commerce et relation client"
      : derivedRoles[0]
        ? `${derivedRoles[0]} — profil détecté`
        : skills.length > 0
          ? "Profil commerce et relation client"
          : "Profil professionnel à préciser";

  const confidence: CandidateProfile["confidence"] =
    (explicitRoles.length > 0 && skills.length >= 3) ||
    (diplomaDetected && explicitRoles.length > 0 && skills.length >= 2)
      ? "high"
      : explicitRoles.length > 0 || skills.length >= 2
        ? "medium"
        : "low";

  const keywords = unique([
    ...(diplomaDetected ? ["BTS MCO"] : []),
    ...(apprenticeshipDetected ? ["alternance"] : []),
    ...targetRoles,
    ...skills,
    ...sectors,
  ]).slice(0, MAX_KEYWORDS);

  const explanations: string[] = [];

  if (diplomaDetected) {
    explanations.push(
      "Diplôme détecté à partir d’une mention explicite du BTS MCO ou de RNCP 38362.",
    );
  }
  if (explicitRoles.length > 0) {
    explanations.push(
      `Métiers retenus car leurs intitulés apparaissent dans le CV : ${joinLabels(explicitRoles)}.`,
    );
  } else if (diplomaDetected) {
    explanations.push(
      "Aucun métier précis n’est nommé ; les cibles proposées correspondent aux débouchés commerciaux usuels du BTS MCO.",
    );
  } else if (derivedRoles.length > 0) {
    explanations.push(
      `Métiers proposés à partir des compétences professionnelles détectées : ${joinLabels(derivedRoles)}.`,
    );
  }
  if (skills.length > 0) {
    explanations.push(
      `Compétences appuyées par des expressions professionnelles explicites : ${joinLabels(skills)}.`,
    );
  }
  if (sectors.length > 0) {
    explanations.push(
      `Secteurs cités dans le CV, utilisés comme préférences de recherche : ${joinLabels(sectors)}.`,
    );
  }
  for (const { rule, signals } of romeMatches) {
    explanations.push(
      `ROME ${rule.code} — ${rule.label} : associé à ${joinLabels(signals)} (référentiel France Travail).`,
    );
  }
  explanations.push(
    confidence === "high"
      ? "Confiance élevée : le CV contient un métier et plusieurs compétences concordantes."
      : confidence === "medium"
        ? "Confiance moyenne : le CV fournit quelques signaux professionnels précis."
        : "Confiance faible : le CV fournit peu de signaux professionnels ; les suggestions restent volontairement larges.",
  );

  return {
    headline,
    ...(diplomaDetected ? { diploma: BTS_MCO_LABEL } : {}),
    targetRoles,
    skills,
    sectors,
    keywords,
    romeCodes,
    confidence,
    explanations,
  };
}

