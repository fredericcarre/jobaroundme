import { describe, expect, it } from "vitest";

import { analyzeCvProfile } from "@/lib/cv-profile";
import {
  SCORE_WEIGHTS,
  scoreEmployerMatch,
  type ScoreEmployerInput,
} from "@/lib/scoring";
import type {
  CandidateProfile,
  OpportunityLevel,
  SiteInspection,
} from "@/lib/types";

const SALES_PROFILE: CandidateProfile = {
  headline: "Conseiller de vente · BTS MCO",
  diploma: "BTS MCO",
  targetRoles: ["Conseiller de vente"],
  skills: ["Relation client", "Merchandising"],
  sectors: ["Commerce de détail"],
  keywords: ["vente", "alternance"],
  romeCodes: ["D1501"],
  confidence: "high",
  explanations: [],
};

function inspection(
  level?: OpportunityLevel,
  matchedKeywords: string[] = [],
): SiteInspection {
  return {
    status: "checked",
    pagesChecked: 1,
    evidence: level
      ? [
          {
            level,
            title: level === "public-offer" ? "Alternance conseiller de vente" : "Carrières",
            url: "https://shop.example/carrieres",
            excerpt: "Relation client, merchandising et gestion opérationnelle",
            confidence: 0.9,
            ...(level !== "prospecting"
              ? {
                  sourceKind: "employer-site" as const,
                  directEmployer: true,
                }
              : {}),
          },
        ]
      : [],
    matchedKeywords,
  };
}

describe("scoreEmployerMatch", () => {
  it.each([
    ["public-offer", 35],
    ["recruitment-page", 22],
    ["prospecting", 8],
  ] as const)("distingue le niveau %s avec %i points", (opportunityLevel, expected) => {
    const result = scoreEmployerMatch({
      name: "Entreprise Exemple",
      category: "bureau",
      siteInspection: inspection(
        opportunityLevel === "prospecting" ? undefined : opportunityLevel,
      ),
      opportunityLevel,
    });

    expect(result.opportunityLevel).toBe(opportunityLevel);
    expect(result.score.opportunity).toBe(expected);
    expect(result.reasons[0]).toContain(`${expected}/${SCORE_WEIGHTS.opportunity}`);
  });

  it("atteint 100 uniquement lorsque les quatre volets sont au maximum", () => {
    const result = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "clothing_store",
      siteInspection: inspection("public-offer", [
        "alternance",
        "conseiller de vente",
        "relation client",
        "merchandising",
        "gestion opérationnelle",
        "fidélisation",
        "stock",
      ]),
      profile: {
        ...SALES_PROFILE,
        skills: [
          "Relation client",
          "Merchandising",
          "Gestion opérationnelle",
          "Fidélisation",
        ],
        keywords: ["alternance", "vente", "stock"],
      },
      travel: {
        BICYCLE: {
          mode: "BICYCLE",
          durationMinutes: 12,
          distanceKm: 3.2,
          status: "available",
        },
      },
    });

    expect(result.score).toEqual({
      opportunity: 35,
      btsMcoFit: 30,
      cvFit: 15,
      commute: 20,
      total: 100,
    });
    expect(result.reasons).toHaveLength(4);
  });

  it("utilise le trajet disponible le plus court selon des seuils stables", () => {
    const result = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "store",
      siteInspection: inspection(),
      travel: {
        DRIVE: {
          mode: "DRIVE",
          durationMinutes: 48,
          distanceKm: 18,
          status: "available",
        },
        TRANSIT: {
          mode: "TRANSIT",
          durationMinutes: 28,
          distanceKm: 15,
          status: "available",
        },
        WALK: {
          mode: "WALK",
          durationMinutes: 0,
          distanceKm: 0,
          status: "unavailable",
        },
      },
    });

    expect(result.score.commute).toBe(16);
    expect(result.reasons[3]).toContain("28 min en transports en commun");
    expect(result.score.total).toBe(
      result.score.opportunity +
        result.score.btsMcoFit +
        result.score.cvFit +
        result.score.commute,
    );
  });

  it("explique explicitement l’absence de CV et de trajet", () => {
    const result = scoreEmployerMatch({
      name: "Entreprise Exemple",
      category: "inconnue",
      siteInspection: inspection(),
    });

    expect(result.score.cvFit).toBe(0);
    expect(result.score.commute).toBe(0);
    expect(result.reasons[2]).toContain("aucun CV");
    expect(result.reasons[3]).toContain("aucun temps de trajet");
    expect(result.score.total).toBeLessThanOrEqual(100);
  });

  it("privilégie les métiers, secteurs et compétences du profil structuré", () => {
    const relevant = scoreEmployerMatch({
      name: "Boutique Mode",
      category: "clothing_store",
      siteInspection: inspection("public-offer", [
        "conseiller de vente",
        "relation client",
        "merchandising",
      ]),
      profile: SALES_PROFILE,
    });
    const irrelevantInspection = inspection("public-offer");
    irrelevantInspection.evidence[0] = {
      ...irrelevantInspection.evidence[0],
      title: "Alternance développeur Java",
      excerpt: "Développement logiciel, infrastructure et tests automatisés",
    };
    const irrelevant = scoreEmployerMatch({
      name: "Studio Logiciel",
      category: "software company",
      siteInspection: irrelevantInspection,
      profile: SALES_PROFILE,
    });

    expect(relevant.score.btsMcoFit).toBe(30);
    expect(relevant.score.cvFit).toBeGreaterThanOrEqual(6);
    expect(relevant.score.total).toBeGreaterThan(irrelevant.score.total);
    expect(relevant.reasons[1]).toContain("Profil métier");
    expect(relevant.reasons[2]).toContain("Compétences CV");
  });

  it("retrouve dans une offre les alias que l'analyse du CV a canonicalisés", () => {
    const profile = analyzeCvProfile(`
      Conseiller clientèle
      Techniques de vente dans un magasin de sport.
    `);
    const aliasInspection = inspection("public-offer");
    aliasInspection.evidence[0] = {
      ...aliasInspection.evidence[0],
      title: "Alternance conseiller clientèle",
      excerpt: "Pratique des techniques de vente dans un magasin de sport.",
    };

    expect(profile.targetRoles).toEqual(["Chargé de clientèle"]);
    expect(profile.skills).toEqual(["Vente conseil"]);
    expect(profile.sectors).toEqual(["Sport et loisirs"]);

    const result = scoreEmployerMatch({
      name: "Entreprise Exemple",
      category: "services professionnels",
      siteInspection: aliasInspection,
      profile,
    });

    expect(result.score.btsMcoFit).toBeGreaterThan(0);
    expect(result.score.cvFit).toBeGreaterThan(0);
    expect(result.reasons[1]).toContain("Chargé de clientèle");
    expect(result.reasons[2]).toContain("Vente conseil");
  });

  it("combine le socle BTS MCO avec un profil peu détaillé sans dégrader un commerce pertinent", () => {
    const sparseMcoProfile: CandidateProfile = {
      headline: "Profil BTS MCO — commerce et relation client",
      diploma: "BTS Management commercial opérationnel (RNCP 38362)",
      targetRoles: [
        "Conseiller de vente",
        "Employé commercial",
        "Assistant manager",
      ],
      skills: [],
      sectors: [],
      keywords: ["BTS MCO", "alternance"],
      romeCodes: ["D1501", "D1506", "M1704"],
      confidence: "low",
      explanations: [],
    };
    const relevantInspection = inspection(undefined, ["conseiller de vente"]);
    const baseline = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "clothing_store",
      siteInspection: relevantInspection,
    });
    const personalized = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "clothing_store",
      siteInspection: relevantInspection,
      profile: sparseMcoProfile,
    });

    expect(personalized.score.btsMcoFit).toBeGreaterThanOrEqual(
      baseline.score.btsMcoFit,
    );
    expect(personalized.score.btsMcoFit).toBe(SCORE_WEIGHTS.btsMcoFit);
    expect(personalized.reasons[1]).toContain("socle BTS MCO");
    expect(personalized.reasons[1]).toContain("cible du profil");
  });

  it("fait primer une preuve publique sur un niveau fourni plus faible", () => {
    const result = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "store",
      siteInspection: inspection("public-offer"),
      opportunityLevel: "prospecting",
    });

    expect(result.opportunityLevel).toBe("public-offer");
    expect(result.score.opportunity).toBe(35);
  });

  it("priorise une offre employeur directe devant une source publique tierce", () => {
    const official = inspection("public-offer");
    official.evidence[0] = {
      ...official.evidence[0],
      sourceKind: "official-job-service",
      sourceLabel: "France Travail",
      directEmployer: false,
    };
    const direct = inspection("public-offer");
    direct.evidence[0] = {
      ...direct.evidence[0],
      sourceKind: "employer-site",
      directEmployer: true,
    };

    const officialScore = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "store",
      siteInspection: official,
    });
    const directScore = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "store",
      siteInspection: direct,
    });

    expect(officialScore.opportunityLevel).toBe("public-offer");
    expect(officialScore.score.opportunity).toBe(31);
    expect(directScore.score.opportunity).toBe(35);
  });

  it("ne certifie pas une offre provenant d’une source externe non vérifiée", () => {
    const unverified = inspection("public-offer");
    unverified.evidence[0] = {
      ...unverified.evidence[0],
      sourceKind: "unknown",
      directEmployer: false,
    };

    const result = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "store",
      siteInspection: unverified,
    });

    expect(result.opportunityLevel).toBe("prospecting");
    expect(result.score.opportunity).toBe(8);
  });

  it("ne certifie jamais une preuve publique sans provenance explicite", () => {
    const withoutSource = inspection("public-offer");
    delete withoutSource.evidence[0].sourceKind;
    delete withoutSource.evidence[0].directEmployer;

    const result = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "store",
      siteInspection: withoutSource,
      opportunityLevel: "public-offer",
    });

    expect(result.opportunityLevel).toBe("prospecting");
    expect(result.score.opportunity).toBe(8);
    expect(result.reasons[0]).toContain("candidature spontanée");
  });

  it("évalue séparément un commerce fortement adapté même sans site", () => {
    const withoutWebsite = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "Magasin de vêtements",
      placeTypes: ["clothing_store", "store"],
      siteInspection: {
        status: "not-requested",
        pagesChecked: 0,
        evidence: [],
        matchedKeywords: [],
      },
    });
    const withWebsite = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "Magasin de vêtements",
      placeTypes: ["clothing_store", "store"],
      websiteUrl: "https://boutique.example/",
      siteInspection: inspection(),
    });

    expect(withoutWebsite.applicationPotential).toMatchObject({
      score: 60,
      level: "medium",
      confidence: "low",
      websiteStatus: "not-listed",
    });
    expect(withWebsite.applicationPotential).toMatchObject({
      score: 60,
      level: "medium",
      confidence: "high",
      websiteStatus: "found-and-checked",
    });
    expect(withoutWebsite.applicationPotential.recommendedAction).toContain(
      "Passer sur place",
    );
  });

  it("distingue les activités MCO fortes, intermédiaires et contextuelles", () => {
    const scoreFor = (placeTypes: string[]) =>
      scoreEmployerMatch({
        name: "Établissement Exemple",
        category: "Établissement",
        placeTypes,
        siteInspection: {
          status: "not-requested",
          pagesChecked: 0,
          evidence: [],
          matchedKeywords: [],
        },
      }).applicationPotential;

    expect(scoreFor(["telecommunications_service_provider"])).toMatchObject({
      score: 60,
      level: "medium",
    });
    expect(scoreFor(["bank"])).toMatchObject({ score: 60, level: "medium" });
    expect(scoreFor(["insurance_agency"])).toMatchObject({
      score: 60,
      level: "medium",
    });
    expect(scoreFor(["travel_agency"])).toMatchObject({
      score: 60,
      level: "medium",
    });
    expect(scoreFor(["hotel"])).toMatchObject({
      score: 50,
      level: "medium",
    });
    expect(scoreFor(["wholesaler", "store"])).toMatchObject({
      score: 50,
      level: "medium",
    });
    expect(scoreFor(["food_court", "restaurant"])).toMatchObject({
      score: 20,
      level: "low",
    });
    expect(scoreFor(["pharmacy", "store"])).toMatchObject({
      score: 20,
      level: "low",
    });
    expect(scoreFor(["shopping_mall", "store"]).recommendedAction).toContain(
      "cibler les enseignes",
    );
  });

  it("limite la personnalisation CV à 20 points", () => {
    const richInspection = inspection(undefined, [
      "conseiller de vente",
      "relation client",
      "merchandising",
      "gestion opérationnelle",
      "fidélisation",
      "alternance",
      "vente",
      "stock",
    ]);
    const baseline = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "Magasin de vêtements",
      placeTypes: ["clothing_store"],
      websiteUrl: "https://boutique.example/",
      siteInspection: richInspection,
    });
    const personalized = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "Magasin de vêtements",
      placeTypes: ["clothing_store"],
      websiteUrl: "https://boutique.example/",
      siteInspection: richInspection,
      profile: {
        ...SALES_PROFILE,
        skills: [
          "Relation client",
          "Merchandising",
          "Gestion opérationnelle",
          "Fidélisation",
        ],
        keywords: ["alternance", "vente", "stock"],
      },
    });

    expect(personalized.applicationPotential.score).toBe(80);
    expect(
      personalized.applicationPotential.score -
        baseline.applicationPotential.score,
    ).toBe(20);
    expect(personalized.applicationPotential.reasons.join(" ")).toContain(
      "20/20",
    );
  });

  it("utilise les types Places pour le volet BTS MCO même si la catégorie affichée est peu explicite", () => {
    const withoutType = scoreEmployerMatch({
      name: "Les Fleurs du Quartier",
      category: "Fleuriste",
      siteInspection: inspection(),
    });
    const withType = scoreEmployerMatch({
      name: "Les Fleurs du Quartier",
      category: "Fleuriste",
      placeTypes: ["florist", "store"],
      siteInspection: inspection(),
    });

    expect(withoutType.score.btsMcoFit).toBe(0);
    expect(withType.score.btsMcoFit).toBe(10);
    expect(withType.reasons[1]).toContain("secteur commerce/service client");
    expect(withType.applicationPotential).toMatchObject({
      score: 60,
      level: "medium",
    });
  });

  it("fait franchir le seuil fort à un commerce pertinent seulement avec un signal supplémentaire", () => {
    const withoutSignal = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "Commerce",
      placeTypes: ["clothing_store"],
      siteInspection: inspection(),
    });
    const withRecruitmentPage = scoreEmployerMatch({
      name: "Boutique Exemple",
      category: "Commerce",
      placeTypes: ["clothing_store"],
      siteInspection: inspection("recruitment-page"),
    });

    expect(withoutSignal.applicationPotential).toMatchObject({
      score: 60,
      level: "medium",
    });
    expect(withRecruitmentPage.applicationPotential).toMatchObject({
      score: 75,
      level: "high",
    });
  });

  it("oriente les sites non validés vers la fiche Google Maps", () => {
    for (const status of ["not-requested", "blocked", "unreachable"] as const) {
      const result = scoreEmployerMatch({
        name: "Boutique Exemple",
        category: "Commerce",
        placeTypes: ["store"],
        websiteUrl: "https://boutique.example/",
        siteInspection: {
          status,
          pagesChecked: 0,
          evidence: [],
          matchedKeywords: [],
        },
      });

      expect(result.applicationPotential.recommendedAction).toContain(
        "Depuis la fiche Google Maps",
      );
    }
  });

  it("renforce une page recrutement et une piste recruteur sans les confondre avec une offre", () => {
    const recruitmentPage = scoreEmployerMatch({
      name: "Hôtel Exemple",
      category: "Hôtel",
      placeTypes: ["hotel"],
      websiteUrl: "https://hotel.example/",
      siteInspection: inspection("recruitment-page"),
    });
    const recruiterInspection = inspection();
    recruiterInspection.evidence = [
      {
        level: "prospecting",
        title: "Employeur susceptible de recruter",
        url: "https://labonnealternance.apprentissage.beta.gouv.fr/",
        excerpt: "Piste de candidature spontanée",
        confidence: 0.8,
        sourceKind: "official-job-service",
      },
    ];
    const recruiter = scoreEmployerMatch({
      name: "Employeur Exemple",
      category: "Activité à qualifier",
      siteInspection: recruiterInspection,
    });

    expect(recruitmentPage.opportunityLevel).toBe("recruitment-page");
    expect(recruitmentPage.applicationPotential.score).toBe(65);
    expect(recruitmentPage.applicationPotential.level).toBe("medium");
    expect(recruiter.opportunityLevel).toBe("prospecting");
    expect(recruiter.applicationPotential.score).toBe(50);
    expect(recruiter.applicationPotential.recommendedAction).toContain(
      "La Bonne Alternance",
    );
  });

  it("porte une offre publique fiable à 100 sans faire dépendre le potentiel du trajet", () => {
    const baseInput = {
      name: "Boutique Exemple",
      category: "Magasin",
      placeTypes: ["store"],
      websiteUrl: "https://boutique.example/",
      siteInspection: inspection("public-offer"),
    };
    const nearby = scoreEmployerMatch({
      ...baseInput,
      travel: {
        WALK: {
          mode: "WALK",
          durationMinutes: 5,
          distanceKm: 0.4,
          status: "available",
        },
      },
    });
    const farAway = scoreEmployerMatch({
      ...baseInput,
      travel: {
        DRIVE: {
          mode: "DRIVE",
          durationMinutes: 120,
          distanceKm: 90,
          status: "available",
        },
      },
    });

    expect(nearby.applicationPotential.score).toBe(100);
    expect(farAway.applicationPotential).toEqual(nearby.applicationPotential);
    expect(nearby.score.commute).not.toBe(farAway.score.commute);
  });

  it("ignore explicitement la note, les avis et le trajet pour le potentiel de candidature", () => {
    const common = {
      name: "Boutique Exemple",
      category: "Magasin de vêtements",
      placeTypes: ["clothing_store"],
      websiteUrl: "https://boutique.example/",
      siteInspection: inspection(),
    } satisfies ScoreEmployerInput;
    const popularAndNear: ScoreEmployerInput & {
      rating: number;
      reviewCount: number;
    } = {
      ...common,
      rating: 5,
      reviewCount: 10_000,
      travel: {
        WALK: {
          mode: "WALK",
          durationMinutes: 5,
          distanceKm: 0.4,
          status: "available",
        },
      },
    };
    const littleKnownAndFar: ScoreEmployerInput & {
      rating: number;
      reviewCount: number;
    } = {
      ...common,
      rating: 1,
      reviewCount: 0,
      travel: {
        DRIVE: {
          mode: "DRIVE",
          durationMinutes: 120,
          distanceKm: 90,
          status: "available",
        },
      },
    };

    const first = scoreEmployerMatch(popularAndNear);
    const second = scoreEmployerMatch(littleKnownAndFar);

    expect(first.applicationPotential).toEqual(second.applicationPotential);
    expect(first.score.commute).not.toBe(second.score.commute);
  });
});

