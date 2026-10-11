import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateCoverage,
  limitEmployerCandidates,
  mergeOfficialEvidence,
  searchEmployers,
  selectWebsiteScanCandidates,
} from "@/lib/search-service";
import type { GooglePlaceCandidate } from "@/lib/google-maps";
import type {
  EmployerMatch,
  OpportunityEvidence,
  SiteInspection,
} from "@/lib/types";

const ORIGINAL_SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_API_KEY;

beforeEach(() => {
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_SERVER_KEY === undefined) {
    delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  } else {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = ORIGINAL_SERVER_KEY;
  }
  vi.unstubAllGlobals();
});

describe("searchEmployers sans clé Google", () => {
  it("retourne uniquement des données explicitement fictives et ne contacte pas le réseau", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT", "BICYCLE", "TWO_WHEELER"],
    });

    expect(response.mode).toBe("demo");
    expect(response.origin.label).toContain("position fictive de démonstration");
    expect(response.notices[0]).toContain("tous les employeurs");
    expect(response.notices[0]).toContain("fictifs");
    expect(response.results).toHaveLength(9);
    for (const result of response.results) {
      expect(result.isDemo).toBe(true);
      expect(result.name).toContain("[Démo]");
      expect(result.address).toContain("fictive");
      expect(result.caution).toContain("fictif");
      expect(result.travel.TWO_WHEELER?.status).toBe("available");
      for (const evidence of result.siteInspection.evidence) {
        expect(evidence.sourceKind).toBe("employer-site");
        expect(evidence.directEmployer).toBe(true);
        expect(evidence.specificity).toMatch(/^(specific|generic)$/);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("préfère le profil structuré et expose le mode de personnalisation", async () => {
    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
      profile: {
        headline: "Conseiller de vente · BTS MCO",
        diploma: "BTS MCO",
        targetRoles: ["Conseiller de vente"],
        skills: ["Relation client", "Merchandising"],
        sectors: ["Commerce de détail"],
        keywords: ["alternance"],
        romeCodes: ["D1501", "Z9999"],
        confidence: "high",
        explanations: [],
      },
    });

    expect(response.personalization).toEqual({
      mode: "cv-profile",
      label: "Conseiller de vente · BTS MCO",
      confidence: "high",
    });
    expect(response.results[0].reasons[1]).toContain("Profil métier");
    expect(response.results[0].reasons[2]).toContain("Compétences CV");
    expect(response.notices.some((notice) => notice.includes("profil CV"))).toBe(true);
  });

  it("conserve le profil BTS MCO par défaut sans CV exploitable", async () => {
    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
    });

    expect(response.personalization.mode).toBe("bts-mco-default");
    expect(response.results[0].reasons[1]).toContain("BTS MCO");
  });

  it("illustre une prospection sans site et une autre avec site analysé", async () => {
    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
    });

    const withoutWebsite = response.results.find(
      (result) => !result.websiteUrl,
    );
    expect(withoutWebsite?.applicationPotential).toMatchObject({
      level: "medium",
      websiteStatus: "not-listed",
    });
    expect(withoutWebsite?.applicationPotential.recommendedAction).toContain(
      "Passer sur place",
    );

    const checkedWithoutOffer = response.results.find(
      (result) =>
        Boolean(result.websiteUrl) &&
        result.siteInspection.pagesChecked > 0 &&
        result.siteInspection.evidence.length === 0,
    );
    expect(checkedWithoutOffer?.applicationPotential.websiteStatus).toBe(
      "found-and-checked",
    );
  });

  it("recalcule les ROME côté serveur et ignore un code client devenu périmé", async () => {
    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
      profile: {
        headline: "Développeur",
        diploma: "BTS SIO",
        targetRoles: ["Développeur"],
        skills: ["TypeScript"],
        sectors: ["Numérique"],
        keywords: [],
        romeCodes: ["D1501"],
        confidence: "high",
        explanations: [],
      },
    });

    const profileNotice = response.notices.find((notice) =>
      notice.includes("profil CV"),
    );
    expect(profileNotice).toBeDefined();
    expect(profileNotice).not.toContain("métiers ROME");
  });
});

describe("sélection des sites à inspecter", () => {
  it("répartit le budget entre commerces, services, hôtellerie et sources externes", () => {
    const candidates: GooglePlaceCandidate[] = [
      ...Array.from({ length: 4 }, (_, index) =>
        candidate(`retail-${index}`, "retail"),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        candidate(`services-${index}`, "services"),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        candidate(`hospitality-${index}`, "hospitality"),
      ),
      candidate("external-0"),
    ];

    expect(
      selectWebsiteScanCandidates(candidates, 8).map(({ placeId }) => placeId),
    ).toEqual([
      "retail-0",
      "services-0",
      "hospitality-0",
      "external-0",
      "retail-1",
      "services-1",
      "hospitality-1",
      "retail-2",
    ]);
  });
});

describe("plafond global des employeurs", () => {
  it("conserve d’abord les entreprises ayant une preuve officielle", () => {
    const places = [
      candidate("maps-0", "retail"),
      candidate("maps-1", "services"),
      candidate("official-offer"),
      candidate("recruitment-page"),
    ];
    const evidence = new Map([
      [
        "official-offer",
        [
          {
            level: "public-offer" as const,
            title: "Alternance vente",
            url: "https://example.test/offre",
            excerpt: "Offre active",
            confidence: 0.9,
          },
        ],
      ],
      [
        "recruitment-page",
        [
          {
            level: "recruitment-page" as const,
            title: "Recrutement",
            url: "https://example.test/recrutement",
            excerpt: "Page carrière",
            confidence: 0.7,
          },
        ],
      ],
    ]);

    expect(
      limitEmployerCandidates(places, 2, evidence).map(({ placeId }) => placeId),
    ).toEqual(["official-offer", "recruitment-page"]);
  });

  it("réserve de la place à chaque cohorte après les preuves prioritaires", () => {
    const places = [
      ...Array.from({ length: 20 }, (_, index) =>
        candidate(`profile-${index}`, "profile"),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        candidate(`retail-${index}`, "retail"),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        candidate(`services-${index}`, "services"),
      ),
      ...Array.from({ length: 20 }, (_, index) =>
        candidate(`hospitality-${index}`, "hospitality"),
      ),
    ];

    const retained = limitEmployerCandidates(places, 40);
    const counts = retained.reduce<Record<string, number>>((result, place) => {
      const group = place.searchGroup ?? "external";
      result[group] = (result[group] ?? 0) + 1;
      return result;
    }, {});

    expect(counts).toEqual({
      profile: 10,
      retail: 10,
      services: 10,
      hospitality: 10,
    });
  });
});

describe("couverture de la recherche", () => {
  it("sépare les sites trouvés des pages effectivement consultées", () => {
    const results = [
      {
        websiteUrl: "https://checked.example/",
        travel: {},
        siteInspection: { pagesChecked: 2, evidence: [] },
      },
      {
        websiteUrl: "https://blocked.example/",
        travel: {},
        siteInspection: { pagesChecked: 0, evidence: [] },
      },
      {
        travel: {},
        siteInspection: { pagesChecked: 0, evidence: [] },
      },
    ] as unknown as EmployerMatch[];

    expect(calculateCoverage(results)).toMatchObject({
      employersFound: 3,
      websitesFound: 2,
      websitesChecked: 1,
    });
  });

  it("compte chaque offre publique fiable et ignore les pseudo-offres de source inconnue", () => {
    const results = [
      {
        travel: {},
        siteInspection: {
          status: "checked",
          evidence: [
            {
              level: "public-offer",
              title: "Alternance conseiller de vente",
              url: "https://commerce.example/offres/conseiller-vente",
              excerpt: "Offre publiée par l’employeur",
              confidence: 0.95,
              sourceKind: "employer-site",
              directEmployer: true,
              publishedAt: "2026-10-01",
              locationText: "10 rue du Commerce 44000 Nantes",
            },
            {
              level: "public-offer",
              title: "Alternance conseiller de vente",
              url: "https://service-public.example/offres/duplicata",
              excerpt: "La même offre reprise par une autre source",
              confidence: 0.9,
              sourceKind: "official-job-service",
              publishedAt: "2026-10-01T08:00:00.000Z",
              locationText: "10 rue du Commerce 44000 Nantes",
            },
            {
              level: "public-offer",
              title: "Alternance manager commercial",
              url: "https://labonnealternance.apprentissage.beta.gouv.fr/offre/1",
              excerpt: "Offre issue du service public",
              confidence: 0.9,
              sourceKind: "official-job-service",
            },
            {
              level: "public-offer",
              title: "Alternance non vérifiée",
              url: "https://annonces.example/offre-generique",
              excerpt: "Annonce sans provenance fiable",
              confidence: 0.8,
              sourceKind: "unknown",
              directEmployer: false,
            },
          ],
        },
      },
    ] as unknown as EmployerMatch[];

    expect(calculateCoverage(results).publicOffersDetected).toBe(2);
  });
});

describe("fusion des preuves", () => {
  it("réserve une place aux offres officielles lorsque le plafond est atteint", () => {
    const siteEvidence: OpportunityEvidence[] = Array.from(
      { length: 12 },
      (_, index) => ({
        level: "public-offer",
        title: `Offre employeur ${index + 1}`,
        url: `https://commerce.example/offres/${index + 1}`,
        excerpt: "Offre publiée sur le site employeur",
        confidence: 0.95,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "specific",
      }),
    );
    const inspection: SiteInspection = {
      status: "checked",
      pagesChecked: 2,
      evidence: siteEvidence,
      matchedKeywords: ["vente"],
    };
    const officialEvidence: OpportunityEvidence = {
      level: "public-offer",
      title: "Alternance officielle LBA",
      url: "https://labonnealternance.apprentissage.beta.gouv.fr/offres/1",
      excerpt: "Offre issue du service public",
      confidence: 0.98,
      sourceKind: "official-job-service",
      sourceLabel: "La Bonne Alternance",
      directEmployer: false,
      specificity: "specific",
    };

    const merged = mergeOfficialEvidence(
      inspection,
      [officialEvidence],
      ["alternance"],
    );

    expect(merged.evidence).toHaveLength(12);
    expect(merged.evidence).toContain(officialEvidence);
    expect(
      merged.evidence.filter(
        ({ sourceKind }) => sourceKind === "employer-site",
      ),
    ).toHaveLength(11);
  });

  it("conserve une piste officielle de prospection malgré douze preuves du site", () => {
    const siteEvidence: OpportunityEvidence[] = Array.from(
      { length: 12 },
      (_, index) => ({
        level: "public-offer",
        title: `Offre directe ${index + 1}`,
        url: `https://commerce.example/offres/${index + 1}`,
        excerpt: "Offre publiée sur le site employeur",
        confidence: 0.95,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "specific",
      }),
    );
    const officialProspecting: OpportunityEvidence = {
      level: "prospecting",
      title: "Entreprise susceptible de recruter en alternance",
      url: "https://labonnealternance.apprentissage.beta.gouv.fr/recherche-apprentissage",
      excerpt: "Signal de recrutement potentiel issu du service public",
      confidence: 0.78,
      sourceKind: "official-job-service",
      sourceLabel: "La Bonne Alternance",
      directEmployer: false,
      specificity: "generic",
    };

    const merged = mergeOfficialEvidence(
      {
        status: "checked",
        pagesChecked: 2,
        evidence: siteEvidence,
        matchedKeywords: ["vente"],
      },
      [officialProspecting],
      ["alternance"],
    );

    expect(merged.evidence).toHaveLength(12);
    expect(merged.evidence).toContain(officialProspecting);
    expect(
      merged.evidence.filter(
        ({ sourceKind }) => sourceKind === "employer-site",
      ),
    ).toHaveLength(11);
  });
});

function candidate(
  placeId: string,
  searchGroup?: GooglePlaceCandidate["searchGroup"],
): GooglePlaceCandidate {
  return {
    placeId,
    ...(searchGroup ? { searchGroup } : {}),
    name: placeId,
    category: "Commerce",
    address: "Nantes",
    coordinates: { lat: 47.22, lng: -1.55 },
    distanceKm: 1,
    websiteUrl: `https://${placeId}.example/`,
    googleMapsUrl: "https://www.google.com/maps",
  };
}
