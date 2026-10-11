import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResultCard } from "@/components/result-card";
import type { EmployerMatch } from "@/lib/types";

describe("ResultCard URL safety", () => {
  it("affiche les libellés sans rendre les URL privées cliquables", () => {
    const result: EmployerMatch = {
      id: "unsafe-links",
      name: "Commerce Exemple",
      category: "Commerce",
      address: "2 rue Exemple, Nantes",
      coordinates: { lat: 47.22, lng: -1.55 },
      distanceKm: 1,
      websiteUrl: "http://127.0.0.1/admin",
      googleMapsUrl: "http://169.254.169.254/latest/meta-data",
      travel: {},
      opportunityLevel: "public-offer",
      applicationPotential: {
        score: 90,
        level: "high",
        confidence: "high",
        websiteStatus: "found-and-checked",
        reasons: ["Une offre publique correspond au profil"],
        recommendedAction: "Consulter l’offre et vérifier ses conditions.",
      },
      siteInspection: {
        status: "checked",
        pagesChecked: 1,
        recruitmentPageUrl: "http://[::a00:1]/jobs",
        matchedKeywords: [],
        evidence: [
          {
            level: "public-offer",
            title: "Offre principale",
            url: "http://[::7f00:1]/admin",
            excerpt: "Offre non fiable",
            confidence: 0.9,
          },
          {
            level: "public-offer",
            title: "Autre offre",
            url: "https://user:secret@example.com/jobs/2",
            excerpt: "Autre offre non fiable",
            confidence: 0.8,
          },
        ],
      },
      score: {
        opportunity: 0,
        btsMcoFit: 0,
        cvFit: 0,
        commute: 0,
        total: 0,
      },
      reasons: [],
    };

    const html = renderToStaticMarkup(
      <ResultCard
        favorite={false}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
        rank={1}
        result={result}
        selected={false}
        travelModes={[]}
        usesCvProfile={false}
      />,
    );

    expect(html).toContain("Offre principale");
    expect(html).toContain("Autre offre");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("169.254.169.254");
  });

  it("rend la page recrutement inspectée accessible avec une offre LBA principale", () => {
    const result: EmployerMatch = {
      id: "official-and-careers",
      name: "Commerce Exemple",
      category: "Commerce",
      address: "2 rue Exemple, Nantes",
      coordinates: { lat: 47.22, lng: -1.55 },
      distanceKm: 1,
      websiteUrl: "https://commerce.example/",
      googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=commerce",
      travel: {},
      opportunityLevel: "public-offer",
      applicationPotential: {
        score: 90,
        level: "high",
        confidence: "high",
        websiteStatus: "found-and-checked",
        reasons: ["Une offre publique correspond au profil"],
        recommendedAction: "Consulter l’offre et préparer sa candidature.",
      },
      siteInspection: {
        status: "checked",
        pagesChecked: 2,
        recruitmentPageUrl: "https://commerce.example/carrieres",
        matchedKeywords: ["alternance"],
        evidence: [
          {
            level: "public-offer",
            title: "Alternance officielle LBA",
            url: "https://labonnealternance.apprentissage.beta.gouv.fr/offres/1",
            excerpt: "Offre publique",
            confidence: 0.98,
            sourceKind: "official-job-service",
            sourceLabel: "La Bonne Alternance",
          },
          {
            level: "recruitment-page",
            title: "Page carrières",
            url: "https://commerce.example/carrieres",
            excerpt: "Page recrutement de l’employeur",
            confidence: 0.9,
            sourceKind: "employer-site",
            directEmployer: true,
          },
        ],
      },
      score: {
        opportunity: 31,
        btsMcoFit: 20,
        cvFit: 18,
        commute: 14,
        total: 83,
      },
      reasons: ["Offre publique"],
    };

    const html = renderToStaticMarkup(
      <ResultCard
        favorite={false}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
        rank={1}
        result={result}
        selected={false}
        travelModes={[]}
        usesCvProfile={true}
      />,
    );

    expect(html).toContain("Alternance officielle LBA");
    expect(html).toContain("https://commerce.example/carrieres");
    expect(html).toContain("Consulter la page recrutement");
    expect(html).not.toContain("autre offre");
  });
});
