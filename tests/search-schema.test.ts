import { describe, expect, it } from "vitest";

import { searchInputSchema } from "@/lib/search-schema";

describe("searchInputSchema", () => {
  it("accepte une recherche BTS MCO locale raisonnable", () => {
    const result = searchInputSchema.safeParse({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 20,
      travelModes: ["TRANSIT", "BICYCLE"],
    });

    expect(result.success).toBe(true);
  });

  it("refuse le texte brut d’un CV dans l’API de recherche", () => {
    const result = searchInputSchema.safeParse({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 20,
      travelModes: ["TRANSIT"],
      cvText: "Conseil client et mise en rayon",
    });

    expect(result.success).toBe(false);
  });

  it("accepte un profil CV structuré et normalise ses codes ROME", () => {
    const result = searchInputSchema.safeParse({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 20,
      travelModes: ["TRANSIT"],
      profile: {
        headline: "Conseiller de vente",
        diploma: "BTS MCO",
        targetRoles: ["Conseiller de vente"],
        skills: ["Relation client", "Merchandising"],
        sectors: ["Commerce de détail"],
        keywords: ["alternance"],
        romeCodes: [" d1501 "],
        confidence: "high",
        explanations: ["Métier explicitement présent dans le CV."],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile?.romeCodes).toEqual(["D1501"]);
    }
  });

  it("refuse les profils manipulés ou démesurés à la frontière API", () => {
    const base = {
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 20,
      travelModes: ["TRANSIT"],
      profile: {
        headline: "Profil",
        targetRoles: [],
        skills: [],
        sectors: [],
        keywords: [],
        confidence: "low",
        explanations: [],
      },
    };

    expect(
      searchInputSchema.safeParse({
        ...base,
        profile: { ...base.profile, romeCodes: ["D1501,OTHER"] },
      }).success,
    ).toBe(false);
    expect(
      searchInputSchema.safeParse({
        ...base,
        profile: {
          ...base.profile,
          skills: Array.from({ length: 41 }, (_, index) => `Compétence ${index}`),
          romeCodes: [],
        },
      }).success,
    ).toBe(false);
  });

  it("refuse un rayon supérieur aux limites de Nearby Search", () => {
    const result = searchInputSchema.safeParse({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 51,
      travelModes: ["TRANSIT"],
    });

    expect(result.success).toBe(false);
  });

  it("refuse une recherche sans mode de transport", () => {
    const result = searchInputSchema.safeParse({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: [],
    });

    expect(result.success).toBe(false);
  });
});
