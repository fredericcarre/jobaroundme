import { describe, expect, it } from "vitest";

import { mapResultLabel, schematicLayout } from "@/components/results-map";
import type { EmployerMatch, ResolvedOrigin } from "@/lib/types";

function employer(
  id: string,
  coordinates: EmployerMatch["coordinates"],
): EmployerMatch {
  return { id, coordinates } as EmployerMatch;
}

describe("schematicLayout", () => {
  it("place le départ dans le même repère géographique que les résultats", () => {
    const origin: ResolvedOrigin = {
      label: "Départ",
      coordinates: { lat: 48, lng: 2 },
    };

    const layout = schematicLayout(
      [employer("nord-est", { lat: 49, lng: 3 })],
      origin,
    );

    expect(layout.origin).toEqual({ left: 10, top: 88 });
    expect(layout.points[0]).toMatchObject({ left: 90, top: 10 });
  });

  it("conserve des positions finies lorsque toutes les coordonnées sont identiques", () => {
    const origin: ResolvedOrigin = {
      label: "Départ",
      coordinates: { lat: 48.8566, lng: 2.3522 },
    };

    const layout = schematicLayout(
      [employer("meme-adresse", origin.coordinates)],
      origin,
    );

    expect(layout.origin).toEqual({ left: 10, top: 10 });
    expect(layout.points[0]).not.toMatchObject(layout.origin);
    expect(Number.isFinite(layout.origin.left)).toBe(true);
    expect(Number.isFinite(layout.origin.top)).toBe(true);
  });

  it("décale les établissements partageant exactement la même adresse", () => {
    const origin: ResolvedOrigin = {
      label: "Départ",
      coordinates: { lat: 48.85, lng: 2.34 },
    };
    const coordinates = { lat: 48.86, lng: 2.35 };

    const layout = schematicLayout(
      [employer("premier", coordinates), employer("second", coordinates)],
      origin,
    );

    expect(layout.points[0]).not.toMatchObject(layout.points[1]);
  });

  it("annonce le potentiel de prospection dans le libellé de carte", () => {
    const result = {
      opportunityLevel: "prospecting",
      applicationPotential: { level: "high" },
    } as EmployerMatch;

    expect(mapResultLabel(result)).toBe("À prospecter · potentiel fort");
  });
});
