import { describe, expect, it } from "vitest";

import {
  analyzeCvProfile,
  CV_PROFILE_ROME_CODES,
  deriveRomeCodesForProfile,
} from "@/lib/cv-profile";

describe("analyzeCvProfile", () => {
  it("construit un profil BTS MCO explicable à partir de faits professionnels", () => {
    const text = `
      CONSEILLÈRE DE VENTE — alternance
      BTS Management commercial opérationnel

      Expérience dans un magasin de sport
      Accueil client, techniques de vente et encaissement.
      Mise en rayon, inventaires et suivi des stocks.
    `;

    const profile = analyzeCvProfile(text);

    expect(profile.headline).toBe("Conseiller de vente · BTS MCO");
    expect(profile.diploma).toBe(
      "BTS Management commercial opérationnel (RNCP 38362)",
    );
    expect(profile.targetRoles).toEqual(["Conseiller de vente"]);
    expect(profile.skills).toEqual([
      "Accueil et conseil client",
      "Vente conseil",
      "Encaissement",
      "Mise en rayon",
      "Inventaire",
      "Gestion des stocks",
    ]);
    expect(profile.sectors).toEqual(["Sport et loisirs"]);
    expect(profile.keywords).toContain("alternance");
    expect(profile.romeCodes).toEqual(["D1501", "D1506"]);
    expect(profile.confidence).toBe("high");
    expect(profile.explanations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mention explicite du BTS MCO"),
        expect.stringContaining("ROME D1501 — Animation de vente"),
        expect.stringContaining("référentiel France Travail"),
      ]),
    );
  });

  it("ne transforme pas l’intitulé du diplôme en compétence de management", () => {
    const profile = analyzeCvProfile(
      "Étudiant en première année de BTS Management commercial opérationnel.",
    );

    expect(profile.diploma).toBeDefined();
    expect(profile.skills).toEqual([]);
    expect(profile.targetRoles).toEqual([
      "Conseiller de vente",
      "Employé commercial",
      "Assistant manager",
    ]);
    expect(profile.romeCodes).toEqual([
      "D1301",
      "D1501",
      "D1502",
      "D1503",
      "D1506",
      "M1704",
    ]);
    expect(profile.confidence).toBe("low");
    expect(profile.explanations).toContain(
      "Aucun métier précis n’est nommé ; les cibles proposées correspondent aux débouchés commerciaux usuels du BTS MCO.",
    );
  });

  it("écarte les négations, aspirations et faux amis techniques", () => {
    const profile = analyzeCvProfile(`
      Développeur web
      Gestion de projet, stockage informatique et marge CSS.
      Sans expérience en management d'équipe.
      Objectif : apprendre le merchandising.
    `);

    expect(profile.skills).toEqual([]);
    expect(profile.targetRoles).toEqual([]);
    expect(profile.romeCodes).toEqual([]);
    expect(profile.confidence).toBe("low");
  });

  it("normalise les césures PDF, les apostrophes et des équivalents anglais", () => {
    const profile = analyzeCvProfile(`
      SALES ASSISTANT — online retail
      Customer service, cash register and inventory control.
      Visual merchan-\n      dising et e‑commerce.
      Suivi du chiffre d’affaires.
    `);

    expect(profile.headline).toBe("Conseiller de vente");
    expect(profile.skills).toEqual(
      expect.arrayContaining([
        "Relation client",
        "Encaissement",
        "Gestion des stocks",
        "Merchandising",
        "E-commerce et omnicanal",
        "Pilotage de la performance commerciale",
      ]),
    );
    expect(profile.sectors).toEqual(
      expect.arrayContaining(["Commerce de détail", "E-commerce"]),
    );
    expect(profile.romeCodes).toEqual(
      expect.arrayContaining(["D1501", "D1506", "M1704", "M1705"]),
    );
  });

  it("déduplique les concepts et produit un ordre stable", () => {
    const repeated = `
      Vendeur conseil
      Relation client, relation client, RELATION CLIENT.
      Mise en rayon ; mise-en-rayon ; inventaire ; inventaire.
    `;

    const first = analyzeCvProfile(repeated);
    const second = analyzeCvProfile(repeated);

    expect(first).toEqual(second);
    expect(first.skills.filter((skill) => skill === "Relation client")).toHaveLength(1);
    expect(first.skills.filter((skill) => skill === "Mise en rayon")).toHaveLength(1);
    expect(new Set(first.keywords).size).toBe(first.keywords.length);
  });

  it("ignore les coordonnées et attributs personnels", () => {
    const professionalFacts = `
      Conseiller clientèle
      Service client, fidélisation et logiciel CRM.
    `;
    const profileA = analyzeCvProfile(`
      Camille Exemple, 18 ans, nationalité française
      12 rue Exemple — camille@example.test — 06 00 00 00 00
      ${professionalFacts}
    `);
    const profileB = analyzeCvProfile(`
      Alex Autre, 42 ans, nationalité belge, marié
      99 avenue Autre — alex@example.test — 07 00 00 00 00
      ${professionalFacts}
    `);

    expect(profileA).toEqual(profileB);
    const serialized = JSON.stringify(profileA).toLowerCase();
    expect(serialized).not.toContain("camille");
    expect(serialized).not.toContain("française");
    expect(serialized).not.toContain("06 00");
  });

  it("reste conservateur pour un CV vide ou limité aux contacts", () => {
    const profile = analyzeCvProfile(
      "Prénom Nom — personne@example.test — 06 00 00 00 00",
    );

    expect(profile).toMatchObject({
      headline: "Profil professionnel à préciser",
      targetRoles: [],
      skills: [],
      sectors: [],
      keywords: [],
      romeCodes: [],
      confidence: "low",
    });
    expect(profile).not.toHaveProperty("diploma");
  });

  it("n’émet que les codes ROME documentés par le moteur", () => {
    const profile = analyzeCvProfile(`
      Assistant commercial et conseiller de vente
      Prospection commerciale, logiciel CRM, merchandising,
      relation client, communication commerciale et e-commerce.
    `);

    expect(profile.romeCodes.length).toBeGreaterThan(0);
    expect(profile.romeCodes.every((code) => CV_PROFILE_ROME_CODES.includes(
      code as (typeof CV_PROFILE_ROME_CODES)[number],
    ))).toBe(true);
  });

  it("recalcule les codes ROME après correction avec les alias connus", () => {
    expect(
      deriveRomeCodesForProfile({
        targetRoles: ["vendeuse conseil"],
        skills: ["inventory control"],
      }),
    ).toEqual(["D1501", "D1506"]);
    expect(
      deriveRomeCodesForProfile({
        targetRoles: ["Manager de rayon"],
        skills: [],
      }),
    ).toEqual(["D1502", "D1503"]);
    expect(
      deriveRomeCodesForProfile({
        targetRoles: ["Responsable de magasin"],
        skills: [],
      }),
    ).toEqual(["D1301"]);
  });

  it("ne replie sur le socle MCO que lorsque le diplôme est explicite", () => {
    expect(
      deriveRomeCodesForProfile({
        diploma: "BTS Management commercial opérationnel (RNCP 38362)",
        targetRoles: ["Métier libre inconnu"],
        skills: [],
      }),
    ).toEqual(["D1301", "D1501", "D1502", "D1503", "D1506", "M1704"]);
    expect(
      deriveRomeCodesForProfile({
        diploma: "BTS SIO",
        targetRoles: ["Développeur"],
        skills: ["TypeScript"],
      }),
    ).toEqual([]);
  });
});

