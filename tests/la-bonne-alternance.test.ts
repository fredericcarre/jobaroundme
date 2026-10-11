import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BTS_MCO_ROME_CODES,
  LaBonneAlternanceError,
  mergeLaBonneAlternanceWithGoogle,
  safeRomeCodesForSearch,
  searchLaBonneAlternance,
  type LaBonneAlternanceEmployer,
} from "@/lib/la-bonne-alternance";
import type { GooglePlaceCandidate } from "@/lib/google-maps";

afterEach(() => {
  vi.restoreAllMocks();
});

const ORIGIN = { lat: 47.2184, lng: -1.5536 };
const NOW = new Date("2026-10-11T12:00:00.000Z");

function workplace(
  name: string,
  coordinates: [number, number],
  siret: string,
) {
  return {
    name,
    legal_name: `${name} SAS`,
    brand: name,
    siret,
    website: `https://${name.toLowerCase().replace(/\s+/g, "-")}.example/`,
    description: null,
    size: null,
    location: {
      address: `10 rue du Commerce, 44000 Nantes`,
      geopoint: { type: "Point", coordinates },
    },
    domain: {
      idcc: null,
      opco: "L'Opcommerce",
      naf: { code: "4711D", label: "Supermarché" },
    },
  };
}

function job(
  overrides: Partial<{
    id: string;
    name: string;
    coordinates: [number, number];
    siret: string;
    delegated: boolean;
    creation: string | null;
    expiration: string | null;
    status: "Active" | "Filled" | "Cancelled";
    romeCodes: string[];
  }> = {},
) {
  const name = overrides.name ?? "Commerce Direct";
  return {
    identifier: {
      id: overrides.id ?? "offer-1",
      partner_job_id: `partner-${overrides.id ?? "offer-1"}`,
      partner_label: "France Travail",
    },
    workplace: workplace(
      name,
      overrides.coordinates ?? [-1.5529, 47.219],
      overrides.siret ?? "12345678901234",
    ),
    apply: {
      url: `https://candidat.francetravail.fr/offres/recherche/detail/${overrides.id ?? "offer-1"}`,
      phone: null,
      recipient_id: null,
    },
    contract: {
      start: null,
      start_type: "des_que_possible",
      start_is_flexible: true,
      duration: 24,
      type: ["Apprentissage"],
      remote: "onsite",
    },
    offer: {
      title: "Conseiller de vente en alternance",
      description:
        "<p>Accueil client, vente-conseil, merchandising et gestion des stocks.</p>",
      desired_skills: ["Relation client"],
      to_be_acquired_skills: ["Management commercial"],
      access_conditions: [],
      opening_count: 1,
      publication: {
        creation: overrides.creation ?? "2026-10-01T08:00:00.000Z",
        expiration: overrides.expiration ?? "2026-12-01T23:59:59.000Z",
      },
      rome_codes: overrides.romeCodes ?? ["D1501"],
      target_diploma: { european: "5", label: "Bac+2" },
      status: overrides.status ?? "Active",
      to_applicant_questions: null,
    },
    is_delegated: overrides.delegated ?? false,
  };
}

function recruiter() {
  return {
    identifier: { id: "recruiter-1" },
    workplace: workplace(
      "Boutique Candidate",
      [-1.555, 47.22],
      "98765432109876",
    ),
    apply: {
      url: "https://labonnealternance.apprentissage.beta.gouv.fr/postuler/recruiter-1",
      phone: null,
      recipient_id: "recruiter-1",
    },
  };
}

describe("La Bonne Alternance provider", () => {
  it("borne les codes ROME au catalogue et conserve le fallback BTS MCO", () => {
    expect(
      safeRomeCodesForSearch([" d1506 ", "Z9999", "D1506", "invalide"]),
    ).toEqual(["D1506"]);
    expect(safeRomeCodesForSearch(["Z9999"])).toEqual([
      ...BTS_MCO_ROME_CODES,
    ]);
  });

  it("filtre les offres avec l’ensemble ROME demandé par le profil", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({
        jobs: [
          job({ id: "vente", romeCodes: ["D1501"] }),
          job({ id: "merchandising", romeCodes: ["D1506"] }),
        ],
        recruiters: [],
        warnings: [],
      });
    });

    const result = await searchLaBonneAlternance(
      ORIGIN,
      10,
      "server-only-key",
      {
        fetchImpl: fetchMock,
        now: () => NOW,
        romeCodes: ["D1506"],
      },
    );

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("romes")).toBe("D1506");
    expect(result.employers).toHaveLength(1);
    expect(result.employers[0].id).toBe("merchandising");
  });

  it("interroge le profil BTS MCO, garde les offres directes et sépare les recruteurs", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({
          jobs: [
            job(),
            job({
              id: "delegated",
              name: "CFA Intermédiaire",
              siret: "11111111111111",
              delegated: true,
            }),
          ],
          recruiters: [recruiter()],
          warnings: [
            {
              code: "FRANCE_TRAVAIL_API_ERROR",
              message: "Couverture partielle",
            },
          ],
        });
      },
    );

    const result = await searchLaBonneAlternance(
      ORIGIN,
      10,
      "server-only-key",
      { fetchImpl: fetchMock, now: () => NOW },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requested, init] = fetchMock.mock.calls[0];
    const requestedUrl = new URL(String(requested));
    expect(requestedUrl.origin + requestedUrl.pathname).toBe(
      "https://api.apprentissage.beta.gouv.fr/api/job/v1/search",
    );
    expect(requestedUrl.searchParams.get("longitude")).toBe(String(ORIGIN.lng));
    expect(requestedUrl.searchParams.get("latitude")).toBe(String(ORIGIN.lat));
    expect(requestedUrl.searchParams.get("radius")).toBe("10");
    expect(requestedUrl.searchParams.get("romes")).toBe(
      BTS_MCO_ROME_CODES.join(","),
    );
    expect(requestedUrl.searchParams.get("target_diploma_level")).toBe("5");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer server-only-key",
    );
    expect(String(requested)).not.toContain("server-only-key");

    expect(result.statistics).toMatchObject({
      jobsReceived: 2,
      publicOffersIncluded: 1,
      recruitersReceived: 1,
      recruitersIncluded: 1,
      delegatedJobsHidden: 1,
    });
    expect(result.employers.map(({ name }) => name)).toEqual([
      "Commerce Direct",
      "Boutique Candidate",
    ]);

    const offer = result.employers[0].evidence[0];
    expect(offer).toMatchObject({
      level: "public-offer",
      sourceKind: "official-job-service",
      sourceLabel: "La Bonne Alternance · diffuseur : France Travail",
      directEmployer: false,
      publishedAt: "2026-10-01T08:00:00.000Z",
      validThrough: "2026-12-01T23:59:59.000Z",
      retrievedAt: "2026-10-11T12:00:00.000Z",
      locationText: "10 rue du Commerce, 44000 Nantes",
    });
    expect(offer.excerpt).not.toContain("<p>");
    expect(result.employers[1].evidence[0]).toMatchObject({
      level: "prospecting",
      sourceLabel: "La Bonne Alternance",
    });
  });

  it("écarte par défaut les offres expirées, inactives ou incomplètes", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        jobs: [
          job({ id: "expired", expiration: "2026-10-10T12:00:00.000Z" }),
          job({ id: "filled", status: "Filled" }),
          { ...job({ id: "unsafe" }), is_delegated: undefined },
        ],
        recruiters: [],
        warnings: [],
      }),
    );

    const result = await searchLaBonneAlternance(
      ORIGIN,
      10,
      "server-only-key",
      { fetchImpl: fetchMock, now: () => NOW },
    );

    expect(result.employers).toEqual([]);
    expect(result.statistics.invalidOrInactiveItemsSkipped).toBe(3);
  });

  it("conserve la route SPA HTTPS d’un lien de candidature officiel", async () => {
    const spaJob = job({ id: "spa-route" });
    spaJob.apply.url = "https://jobs.example/#/offres/spa-route";
    const fetchMock = vi.fn(async () =>
      Response.json({ jobs: [spaJob], recruiters: [], warnings: [] }),
    );

    const result = await searchLaBonneAlternance(
      ORIGIN,
      10,
      "server-only-key",
      { fetchImpl: fetchMock, now: () => NOW },
    );

    expect(result.employers[0]?.evidence[0]?.url).toBe(
      "https://jobs.example/#/offres/spa-route",
    );
  });

  it("écarte les liens de candidature privés et retire un site employeur non sûr", async () => {
    const unsafeJob = job({ id: "unsafe-url" });
    unsafeJob.apply.url = "http://169.254.169.254/latest/meta-data";
    const unsafeRecruiter = recruiter();
    unsafeRecruiter.apply.url = "http://[::7f00:1]/admin";
    const safeJob = job({ id: "safe-private-website" });
    safeJob.workplace.website = "http://127.0.0.1/admin";

    const fetchMock = vi.fn(async () =>
      Response.json({
        jobs: [unsafeJob, safeJob],
        recruiters: [unsafeRecruiter],
        warnings: [],
      }),
    );

    const result = await searchLaBonneAlternance(
      ORIGIN,
      10,
      "server-only-key",
      { fetchImpl: fetchMock, now: () => NOW },
    );

    expect(result.employers).toHaveLength(1);
    expect(result.employers[0]).toMatchObject({ id: "safe-private-website" });
    expect(result.employers[0].websiteUrl).toBeUndefined();
    expect(result.statistics).toMatchObject({
      publicOffersIncluded: 1,
      recruitersIncluded: 0,
      invalidOrInactiveItemsSkipped: 2,
    });
    expect(
      result.employers.flatMap(({ evidence }) => evidence.map(({ url }) => url)),
    ).not.toEqual(
      expect.arrayContaining([
        "http://169.254.169.254/latest/meta-data",
        "http://[::7f00:1]/admin",
      ]),
    );
  });

  it("rejette une réponse globale non conforme au lieu de lui faire confiance", async () => {
    const fetchMock = vi.fn(async () => Response.json({ jobs: [] }));

    await expect(
      searchLaBonneAlternance(ORIGIN, 10, "server-only-key", {
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject<Partial<LaBonneAlternanceError>>({
      name: "LaBonneAlternanceError",
      code: "LBA_INVALID_RESPONSE",
    });
  });

  it("arrête une réponse chunked avant de conserver plus de 8 Mo", async () => {
    const megabyte = new Uint8Array(1024 * 1024);
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < 9; index += 1) {
              controller.enqueue(megabyte);
            }
            controller.close();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      searchLaBonneAlternance(ORIGIN, 10, "server-only-key", {
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "LBA_RESPONSE_TOO_LARGE" });
  });

  it("retente une seule fois un 429 quand Retry-After reste sous deux secondes", async () => {
    const fetchMock = vi
      .fn<(input: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ jobs: [], recruiters: [], warnings: [] }),
      );

    await expect(
      searchLaBonneAlternance(ORIGIN, 10, "server-only-key", {
        fetchImpl: fetchMock,
      }),
    ).resolves.toMatchObject({ employers: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("signale explicitement une limite 429 longue sans bloquer la recherche", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "5" },
        });
      },
    );

    await expect(
      searchLaBonneAlternance(ORIGIN, 10, "server-only-key", {
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "LBA_RATE_LIMITED", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fusion La Bonne Alternance et Google Maps", () => {
  it("rapproche une même enseigne locale et conserve séparément un autre employeur", () => {
    const googlePlaces: GooglePlaceCandidate[] = [
      {
        placeId: "google-1",
        googlePlaceId: "google-1",
        name: "Commerce Direct Nantes",
        category: "Supermarché",
        address: "10 rue du Commerce, 44000 Nantes",
        coordinates: { lat: 47.21905, lng: -1.55295 },
        distanceKm: 0.2,
        googleMapsUrl: "https://maps.google.com/?cid=1",
      },
    ];
    const employers: LaBonneAlternanceEmployer[] = [
      {
        id: "offer-1",
        name: "Commerce Direct",
        aliases: ["Commerce Direct", "Commerce Direct SAS"],
        category: "Supermarché",
        address: "10 rue du Commerce, 44000 Nantes",
        coordinates: { lat: 47.219, lng: -1.5529 },
        distanceKm: 0.2,
        siret: "12345678901234",
        evidence: [
          {
            level: "public-offer",
            title: "Conseiller de vente en alternance",
            url: "https://example.com/offer-1",
            excerpt: "Vente conseil",
            confidence: 0.98,
            sourceKind: "official-job-service",
            sourceLabel: "France Travail",
          },
        ],
        matchedKeywords: ["alternance", "vente conseil"],
        publicOfferCount: 1,
        recruiterSignal: false,
      },
      {
        id: "recruiter-2",
        name: "Autre Boutique",
        aliases: ["Autre Boutique"],
        category: "Commerce",
        address: "20 rue Centrale, 44000 Nantes",
        coordinates: { lat: 47.225, lng: -1.56 },
        distanceKm: 1.1,
        evidence: [
          {
            level: "prospecting",
            title: "Candidature spontanée chez Autre Boutique",
            url: "https://example.com/recruiter-2",
            excerpt: "Sans offre publiée",
            confidence: 0.78,
            sourceKind: "official-job-service",
            sourceLabel: "La Bonne Alternance",
          },
        ],
        matchedKeywords: ["candidature spontanée"],
        publicOfferCount: 0,
        recruiterSignal: true,
      },
    ];

    const result = mergeLaBonneAlternanceWithGoogle(googlePlaces, employers);

    expect(result.places).toHaveLength(2);
    expect(result.mergedEmployers).toBe(1);
    expect(result.addedEmployers).toBe(1);
    expect(result.evidenceByPlaceId.get("google-1")?.[0]).toMatchObject({
      level: "public-offer",
    });
    const added = result.places.find(({ placeId }) => placeId.startsWith("lba:"));
    expect(added).toMatchObject({
      name: "Autre Boutique",
      coordinates: { lat: 47.225, lng: -1.56 },
    });
    expect(added?.googlePlaceId).toBeUndefined();
  });

  it("attache l’offre à l’adresse concordante entre deux succursales proches", () => {
    const googlePlaces: GooglePlaceCandidate[] = [
      {
        placeId: "google-commerce-10",
        googlePlaceId: "google-commerce-10",
        name: "Commerce Direct",
        category: "Supermarché",
        address: "10 rue du Commerce, 44000 Nantes",
        coordinates: { lat: 47.219, lng: -1.5529 },
        distanceKm: 0.2,
        googleMapsUrl: "https://maps.google.com/?cid=10",
      },
      {
        placeId: "google-commerce-20",
        googlePlaceId: "google-commerce-20",
        name: "Commerce Direct",
        category: "Supermarché",
        address: "20 rue du Commerce, 44000 Nantes",
        coordinates: { lat: 47.2198, lng: -1.5529 },
        distanceKm: 0.3,
        googleMapsUrl: "https://maps.google.com/?cid=20",
      },
    ];
    const employer: LaBonneAlternanceEmployer = {
      id: "offer-branch-10",
      name: "Commerce Direct",
      aliases: ["Commerce Direct", "Commerce Direct SAS"],
      category: "Supermarché",
      address: "10 Rue du Commerce, 44000 Nantes",
      // The upstream geopoint is imprecise and happens to be much closer to
      // number 20. The complete address must still select number 10.
      coordinates: { lat: 47.21972, lng: -1.5529 },
      distanceKm: 0.25,
      evidence: [
        {
          level: "public-offer",
          title: "Conseiller de vente en alternance",
          url: "https://example.com/offer-branch-10",
          excerpt: "Vente conseil",
          confidence: 0.98,
          sourceKind: "official-job-service",
          sourceLabel: "France Travail",
        },
      ],
      matchedKeywords: ["alternance", "vente conseil"],
      publicOfferCount: 1,
      recruiterSignal: false,
    };

    const result = mergeLaBonneAlternanceWithGoogle(googlePlaces, [employer]);

    expect(result.mergedEmployers).toBe(1);
    expect(result.addedEmployers).toBe(0);
    expect(result.evidenceByPlaceId.has("google-commerce-10")).toBe(true);
    expect(result.evidenceByPlaceId.has("google-commerce-20")).toBe(false);
  });

  it("ne rattache pas une offre à une succursale voisine dont l’adresse contredit l’offre", () => {
    const googlePlaces: GooglePlaceCandidate[] = [
      {
        placeId: "google-commerce-20",
        googlePlaceId: "google-commerce-20",
        name: "Commerce Direct",
        category: "Supermarché",
        address: "20 rue du Commerce, 44000 Nantes",
        coordinates: { lat: 47.2198, lng: -1.5529 },
        distanceKm: 0.3,
        googleMapsUrl: "https://maps.google.com/?cid=20",
      },
    ];
    const employer: LaBonneAlternanceEmployer = {
      id: "offer-branch-10",
      name: "Commerce Direct",
      aliases: ["Commerce Direct"],
      category: "Supermarché",
      address: "10 rue du Commerce, 44000 Nantes",
      coordinates: { lat: 47.21979, lng: -1.5529 },
      distanceKm: 0.25,
      evidence: [
        {
          level: "public-offer",
          title: "Conseiller de vente en alternance",
          url: "https://example.com/offer-branch-10",
          excerpt: "Vente conseil",
          confidence: 0.98,
          sourceKind: "official-job-service",
          sourceLabel: "France Travail",
        },
      ],
      matchedKeywords: ["alternance"],
      publicOfferCount: 1,
      recruiterSignal: false,
    };

    const result = mergeLaBonneAlternanceWithGoogle(googlePlaces, [employer]);

    expect(result.mergedEmployers).toBe(0);
    expect(result.addedEmployers).toBe(1);
    expect(result.evidenceByPlaceId.has("google-commerce-20")).toBe(false);
    expect(result.places).toHaveLength(2);
    expect(result.places[1]).toMatchObject({
      placeId: "lba:offer-branch-10",
      address: "10 rue du Commerce, 44000 Nantes",
    });
  });

  it("conserve le rapprochement par proximité quasi exacte quand l’adresse est incomplète", () => {
    const googlePlaces: GooglePlaceCandidate[] = [
      {
        placeId: "google-atlantis",
        googlePlaceId: "google-atlantis",
        name: "Boutique Candidate",
        category: "Commerce",
        address: "Centre commercial Atlantis, 44800 Saint-Herblain",
        coordinates: { lat: 47.223, lng: -1.629 },
        distanceKm: 5,
        googleMapsUrl: "https://maps.google.com/?cid=30",
      },
    ];
    const employer: LaBonneAlternanceEmployer = {
      id: "offer-atlantis",
      name: "Boutique Candidate",
      aliases: ["Boutique Candidate SAS"],
      category: "Commerce",
      address: "Atlantis, 44800 Saint-Herblain",
      coordinates: { lat: 47.2231, lng: -1.629 },
      distanceKm: 5,
      evidence: [
        {
          level: "public-offer",
          title: "Vendeur en alternance",
          url: "https://example.com/offer-atlantis",
          excerpt: "Vente conseil",
          confidence: 0.98,
          sourceKind: "official-job-service",
          sourceLabel: "France Travail",
        },
      ],
      matchedKeywords: ["alternance"],
      publicOfferCount: 1,
      recruiterSignal: false,
    };

    const result = mergeLaBonneAlternanceWithGoogle(googlePlaces, [employer]);

    expect(result.mergedEmployers).toBe(1);
    expect(result.addedEmployers).toBe(0);
    expect(result.evidenceByPlaceId.has("google-atlantis")).toBe(true);
  });
});
