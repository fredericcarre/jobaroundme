import { describe, expect, it } from "vitest";

import {
  buildResultsCsv,
  compareEmployerMatches,
  escapeCsvCell,
  formatResultsForClipboard,
} from "@/components/search-experience";
import type { EmployerMatch, OpportunityEvidence } from "@/lib/types";

function evidence(
  title: string,
  url: string,
  level: OpportunityEvidence["level"] = "public-offer",
): OpportunityEvidence {
  return {
    level,
    title,
    url,
    excerpt: "Preuve publique",
    confidence: 0.9,
    sourceKind: "employer-site",
    sourceLabel: "Site employeur",
    directEmployer: true,
    specificity: "specific",
  };
}

function employer(
  id: string,
  evidences: OpportunityEvidence[],
  overrides: Partial<EmployerMatch> = {},
): EmployerMatch {
  return {
    id,
    name: `Entreprise ${id}`,
    category: "Commerce",
    address: "1 rue du Marché, Nantes",
    coordinates: { lat: 47.2184, lng: -1.5536 },
    distanceKm: 3.4,
    rating: 4.2,
    reviewCount: 18,
    websiteUrl: `https://${id}.example/`,
    googleMapsUrl: `https://maps.google.com/?q=${id}`,
    travel: {
      TRANSIT: {
        mode: "TRANSIT",
        durationMinutes: 17,
        distanceKm: 4.1,
        status: "available",
      },
    },
    opportunityLevel: evidences[0]?.level ?? "prospecting",
    applicationPotential: {
      score: 78,
      level: "high",
      confidence: "medium",
      websiteStatus: "found-and-checked",
      reasons: ["Activité commerciale adaptée au BTS MCO", "Site public analysé"],
      recommendedAction: "Contacter le responsable du magasin avec un CV ciblé.",
    },
    siteInspection: {
      status: "checked",
      pagesChecked: 2,
      evidence: evidences,
      matchedKeywords: ["alternance"],
    },
    score: {
      opportunity: 35,
      btsMcoFit: 20,
      cvFit: 18,
      commute: 14,
      total: 87,
    },
    reasons: ["Offre pertinente"],
    ...overrides,
  };
}

describe("escapeCsvCell", () => {
  it.each([
    ["=1+1", `"'=1+1"`],
    [" \t+CMD", `"' \t+CMD"`],
    ["\r@IMPORT", `"'\r@IMPORT"`],
    ["valeur sûre", `"valeur sûre"`],
    [`avec "guillemets"`, `"avec ""guillemets"""`],
  ])("neutralise et échappe %j", (value, expected) => {
    expect(escapeCsvCell(value)).toBe(expected);
  });
});

describe("exports de résultats", () => {
  const firstEvidence = evidence(
    "Alternance conseiller de vente",
    "https://alpha.example/offres/vente",
  );
  const secondEvidence = evidence(
    "Page carrières magasin",
    "https://alpha.example/carrieres",
    "recruitment-page",
  );

  it("copie le titre et l’URL de chaque preuve", () => {
    const text = formatResultsForClipboard([
      employer("alpha", [firstEvidence, secondEvidence]),
    ]);

    expect(text).toContain(
      "Alternance conseiller de vente — https://alpha.example/offres/vente",
    );
    expect(text).toContain("Page carrières magasin — https://alpha.example/carrieres");
    expect(text).toContain("Potentiel de candidature : Fort — indice 78/100");
    expect(text).toContain("pas une probabilité d’embauche");
    expect(text).toContain("Site trouvé : Oui — Site trouvé · analysé");
    expect(text).toContain("Pourquoi : Activité commerciale adaptée au BTS MCO");
    expect(text).toContain("Action conseillée : Contacter le responsable du magasin");
    expect(text).toContain("Site entreprise — https://alpha.example/");
    expect(text).toContain("Source : Site employeur");
    expect(text).toContain("Google Maps — https://maps.google.com/?q=alpha");
  });

  it("produit une ligne par preuve et une ligne pour un employeur sans preuve", () => {
    const csv = buildResultsCsv([
      employer("alpha", [firstEvidence, secondEvidence], {
        name: " \t=HYPERLINK(\"https://bad.example\")",
      }),
      employer("beta", []),
    ]);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(4);
    expect(csv).toContain(`"Alternance conseiller de vente"`);
    expect(csv).toContain(`"Page carrières magasin"`);
    expect(csv).toContain(`"https://alpha.example/offres/vente"`);
    expect(csv).toContain(`"https://alpha.example/carrieres"`);
    expect(lines[0]).toContain(`"Potentiel de candidature"`);
    expect(lines[0]).toContain(`"Lecture de l’indice"`);
    expect(lines[0]).toContain(`"État du site"`);
    expect(csv).toContain(`"Site trouvé · analysé"`);
    expect(csv).toContain(`"Indice de priorité explicable, pas une probabilité d’embauche."`);
    expect(csv).toContain(`"Contacter le responsable du magasin avec un CV ciblé."`);
    expect(lines[1]).toContain(`"' \t=HYPERLINK(""https://bad.example"")"`);
    expect(lines[2]).toContain(`"' \t=HYPERLINK(""https://bad.example"")"`);
    expect(lines[3]).toContain(`"Entreprise beta"`);
  });

  it("retire des exports toutes les URL littérales privées ou non vérifiées", () => {
    const unsafe = employer(
      "unsafe",
      [evidence("Offre à vérifier", "http://127.0.0.1/admin")],
      {
        websiteUrl: "http://169.254.169.254/latest/meta-data",
        googleMapsUrl: "http://[::7f00:1]/maps",
        applicationPotential: {
          score: 45,
          level: "to-qualify",
          confidence: "low",
          websiteStatus: "found-not-checked",
          reasons: ["Informations à compléter"],
          recommendedAction: "Vérifier le commerce avant de le contacter.",
        },
        siteInspection: {
          status: "not-requested",
          pagesChecked: 0,
          recruitmentPageUrl: "https://user:secret@example.com/jobs",
          evidence: [evidence("Offre à vérifier", "http://127.0.0.1/admin")],
          matchedKeywords: [],
        },
      },
    );

    const clipboard = formatResultsForClipboard([unsafe]);
    const csv = buildResultsCsv([unsafe]);

    expect(clipboard).toContain("Offre à vérifier");
    expect(clipboard).not.toContain("127.0.0.1");
    expect(clipboard).not.toContain("169.254.169.254");
    expect(clipboard).not.toContain("user:secret");
    expect(csv).not.toContain("127.0.0.1");
    expect(csv).not.toContain("169.254.169.254");
    expect(csv).not.toContain("user:secret");
  });

  it("marque explicitement les exports de démonstration comme fictifs", () => {
    const demo = employer("demo", [firstEvidence], { isDemo: true });

    const clipboard = formatResultsForClipboard([demo]);
    const csv = buildResultsCsv([demo]);

    expect(clipboard).toMatch(/^MODE DÉMONSTRATION — DONNÉES FICTIVES/u);
    expect(csv.split("\n")[0]).toContain(`"Mode"`);
    expect(csv).toContain(`"MODE DÉMONSTRATION — DONNÉES FICTIVES"`);
  });

  it("trie les commerces par indice de potentiel puis par score global", () => {
    const lowerPotential = employer("lower", [], {
      score: {
        opportunity: 8,
        btsMcoFit: 20,
        cvFit: 10,
        commute: 20,
        total: 58,
      },
      applicationPotential: {
        score: 55,
        level: "medium",
        confidence: "medium",
        websiteStatus: "found-and-checked",
        reasons: ["Commerce adapté"],
        recommendedAction: "Contacter le responsable.",
      },
    });
    const higherPotential = employer("higher", [], {
      score: {
        opportunity: 8,
        btsMcoFit: 15,
        cvFit: 8,
        commute: 10,
        total: 41,
      },
      applicationPotential: {
        score: 82,
        level: "high",
        confidence: "high",
        websiteStatus: "not-listed",
        reasons: ["Enseigne structurée"],
        recommendedAction: "Se présenter sur place.",
      },
    });

    const sorted = [lowerPotential, higherPotential].sort((left, right) =>
      compareEmployerMatches(left, right, "potential", []),
    );

    expect(sorted.map(({ id }) => id)).toEqual(["higher", "lower"]);
  });
});
