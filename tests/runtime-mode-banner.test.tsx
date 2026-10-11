import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RuntimeModeBanner } from "@/components/runtime-mode-banner";

describe("RuntimeModeBanner", () => {
  it("prévient avant la recherche que la démonstration ne consulte aucune donnée réelle", () => {
    const html = renderToStaticMarkup(
      <RuntimeModeBanner
        laBonneAlternanceConfigured={false}
        liveSearchConfigured={false}
        siteScanEnabled
      />,
    );

    expect(html).toContain('data-search-mode="demo"');
    expect(html).toContain("Aucune entreprise ni offre réelle n’est interrogée.");
    expect(html).toContain("Les fiches affichées sont fictives.");
  });

  it("nomme les sources réellement actives", () => {
    const withLba = renderToStaticMarkup(
      <RuntimeModeBanner
        laBonneAlternanceConfigured
        liveSearchConfigured
        siteScanEnabled
      />,
    );
    const withoutLba = renderToStaticMarkup(
      <RuntimeModeBanner
        laBonneAlternanceConfigured={false}
        liveSearchConfigured
        siteScanEnabled={false}
      />,
    );

    expect(withLba).toContain('data-search-mode="live"');
    expect(withLba).toContain("Mode réel configuré");
    expect(withLba).toContain(
      "L’application tentera ensuite de vérifier une sélection de sites publics d’employeurs.",
    );
    expect(withLba).not.toContain(
      "Les sites publics des employeurs seront ensuite vérifiés.",
    );
    expect(withLba).toContain(
      "La Bonne Alternance est configurée et pourra être consultée selon le profil.",
    );
    expect(withoutLba).toContain(
      "La Bonne Alternance n’est pas configurée sur ce serveur.",
    );
    expect(withoutLba).toContain(
      "La vérification des sites employeurs est désactivée sur ce serveur.",
    );
  });
});
