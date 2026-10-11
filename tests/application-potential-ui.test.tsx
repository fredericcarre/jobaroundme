import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResultCard } from "@/components/result-card";
import type { EmployerMatch } from "@/lib/types";

function blockedProspect(): EmployerMatch {
  return {
    id: "prospect-blocked",
    name: "Commerce du Centre",
    category: "Magasin de sport",
    address: "10 place du Marché, Nantes",
    coordinates: { lat: 47.2184, lng: -1.5536 },
    distanceKm: 2.1,
    websiteUrl: "https://commerce.example/",
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=commerce",
    travel: {},
    opportunityLevel: "prospecting",
    applicationPotential: {
      score: 81,
      level: "high",
      confidence: "medium",
      websiteStatus: "blocked",
      reasons: [
        "Activité de vente adaptée au BTS MCO",
        "Commerce local actif",
        "Cette troisième raison ne doit pas encombrer la fiche",
      ],
      recommendedAction: "Passer sur place avec un CV et demander le responsable du magasin.",
    },
    siteInspection: {
      status: "blocked",
      pagesChecked: 0,
      evidence: [],
      matchedKeywords: [],
    },
    score: {
      opportunity: 8,
      btsMcoFit: 28,
      cvFit: 13,
      commute: 19,
      total: 68,
    },
    reasons: ["Commerce adapté"],
  };
}

describe("potentiel de candidature dans une fiche", () => {
  it("sépare le potentiel, l’état du site et le signal public sans surinterpréter un blocage", () => {
    const html = renderToStaticMarkup(
      <ResultCard
        favorite={false}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
        rank={1}
        result={blockedProspect()}
        selected={false}
        travelModes={[]}
        usesCvProfile={true}
      />,
    );

    expect(html).toContain("Potentiel de candidature");
    expect(html).toContain("Fort");
    expect(html).toContain("81");
    expect(html).toContain("Indice de priorité, pas une prévision d’embauche.");
    expect(html).toContain("Site trouvé · analyse bloquée");
    expect(html).toContain("Activité de vente adaptée au BTS MCO");
    expect(html).toContain("Commerce local actif");
    expect(html).not.toContain("Cette troisième raison");
    expect(html).toContain("Action conseillée");
    expect(html).toContain("Passer sur place avec un CV");
    expect(html).toContain("Signal public");
    expect(html).toContain("Le site a limité la vérification automatique");
    expect(html.toLocaleLowerCase("fr-FR")).not.toContain("aucune offre");
    expect(html).not.toContain('href="https://commerce.example/"');
    expect(html).toContain("Préparer une visite");
  });
});

