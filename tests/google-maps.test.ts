import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_NEARBY_SEARCH_GROUPS,
  computeGoogleRouteMatrix,
  googlePlaceTypesForProfile,
  nextWorkdayDepartureTime,
  resolveGoogleOrigin,
  searchNearbyGooglePlaces,
  searchNearbyGooglePlacesDetailed,
  type GooglePlaceCandidate,
} from "@/lib/google-maps";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google Maps server provider", () => {
  it("ne transforme pas la seule gestion de stock en ciblage logistique", () => {
    expect(
      googlePlaceTypesForProfile({
        targetRoles: [],
        skills: ["Gestion des stocks"],
        sectors: [],
        keywords: [],
      }),
    ).toEqual([]);
    expect(
      googlePlaceTypesForProfile({
        targetRoles: [],
        skills: ["Logistique et livraison"],
        sectors: [],
        keywords: [],
      }),
    ).toEqual(
      expect.arrayContaining(["courier_service", "storage", "wholesaler"]),
    );
  });

  it("ajoute une cohorte ciblée par le profil sans retirer la couverture de base", async () => {
    const preferredTypes = googlePlaceTypesForProfile({
      targetRoles: ["Chargé de clientèle"],
      skills: ["Relation client"],
      sectors: ["Banque et assurance"],
      keywords: ["services bancaires"],
    });
    expect(preferredTypes).toEqual(expect.arrayContaining(["bank", "insurance_agency"]));

    const requestBodies: Array<{ includedTypes: string[] }> = [];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ places: [] });
    });

    await searchNearbyGooglePlacesDetailed(
      { lat: 47.2184, lng: -1.5536 },
      10,
      "server-secret",
      {
        fetchImpl: fetchMock,
        preferredPlaceTypes: [...preferredTypes, "not_a_google_type"],
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestBodies[0].includedTypes).toEqual(preferredTypes);
    expect(requestBodies.slice(1).map(({ includedTypes }) => includedTypes)).toEqual(
      GOOGLE_NEARBY_SEARCH_GROUPS.map(({ includedTypes }) => includedTypes),
    );
  });

  it("choisit 08 h 30 à Paris sur le prochain jour ouvré", () => {
    expect(
      nextWorkdayDepartureTime(new Date("2026-10-12T05:45:00.000Z")),
    ).toBe("2026-10-12T06:30:00.000Z");
    expect(
      nextWorkdayDepartureTime(new Date("2026-10-16T08:00:00.000Z")),
    ).toBe("2026-10-19T06:30:00.000Z");
    expect(
      nextWorkdayDepartureTime(new Date("2026-12-18T18:00:00.000Z")),
    ).toBe("2026-12-21T07:30:00.000Z");
  });

  it("géocode une adresse sans exposer la clé dans le résultat", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({
          status: "OK",
          results: [
            {
              formatted_address: "1 place du Commerce, 44000 Nantes, France",
              geometry: { location: { lat: 47.2184, lng: -1.5536 } },
            },
          ],
        });
      },
    );
    const result = await resolveGoogleOrigin(
      { kind: "address", address: "1 place du Commerce, Nantes" },
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(result).toEqual({
      label: "1 place du Commerce, 44000 Nantes, France",
      coordinates: { lat: 47.2184, lng: -1.5536 },
    });
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.origin + requestedUrl.pathname).toBe(
      "https://maps.googleapis.com/maps/api/geocode/json",
    );
    expect(requestedUrl.searchParams.get("key")).toBe("server-secret");
  });

  it("transforme Nearby Search et écarte les lieux fermés ou incomplets", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({
          places: [
            {
              id: "place-1",
              displayName: { text: "Commerce Exemple" },
              formattedAddress: "2 rue Exemple, Nantes",
              location: { latitude: 47.22, longitude: -1.55 },
              primaryTypeDisplayName: { text: "Magasin de vêtements" },
              types: ["clothing_store", "store", "INVALID TYPE", "store"],
              rating: 4.4,
              userRatingCount: 25,
              websiteUri: "https://shop.example/",
              googleMapsUri: "https://maps.google.com/?cid=123",
              businessStatus: "OPERATIONAL",
            },
            {
              id: "place-closed",
              displayName: { text: "Fermé" },
              location: { latitude: 47.221, longitude: -1.551 },
              businessStatus: "CLOSED_PERMANENTLY",
            },
            {
              id: "place-temporarily-closed",
              displayName: { text: "Fermé temporairement" },
              location: { latitude: 47.222, longitude: -1.552 },
              businessStatus: "CLOSED_TEMPORARILY",
            },
            { id: "missing-location", displayName: { text: "Incomplet" } },
          ],
        });
      },
    );
    const places = await searchNearbyGooglePlaces(
      { lat: 47.2184, lng: -1.5536 },
      10,
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      placeId: "place-1",
      name: "Commerce Exemple",
      category: "Magasin de vêtements",
      placeTypes: ["clothing_store", "store"],
      websiteUrl: "https://shop.example/",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(requestBodies.map(({ includedTypes }) => includedTypes)).toEqual(
      GOOGLE_NEARBY_SEARCH_GROUPS.map(({ includedTypes }) => includedTypes),
    );
    expect(
      requestBodies.every(
        ({ maxResultCount, rankPreference, locationRestriction }) =>
          maxResultCount === 20 &&
          rankPreference === "POPULARITY" &&
          locationRestriction.circle.radius === 10_000,
      ),
    ).toBe(true);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://places.googleapis.com/v1/places:searchNearby",
    );
    expect(new Headers(request?.[1]?.headers).get("X-Goog-Api-Key")).toBe(
      "server-secret",
    );
    expect(String(request?.[1]?.body)).not.toContain("server-secret");
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::7f00:1]/admin",
    "https://user:secret@example.com/",
    "javascript:alert(1)",
  ])("n’expose pas l’URL de site Google non sûre %s", async (websiteUri) => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        places: [
          {
            id: "place-unsafe-url",
            displayName: { text: "Commerce Exemple" },
            formattedAddress: "2 rue Exemple, Nantes",
            location: { latitude: 47.22, longitude: -1.55 },
            websiteUri,
            googleMapsUri: "https://maps.google.com/?cid=123",
            businessStatus: "OPERATIONAL",
          },
        ],
      }),
    );

    const places = await searchNearbyGooglePlaces(
      { lat: 47.2184, lng: -1.5536 },
      10,
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(places).toHaveLength(1);
    expect(places[0].websiteUrl).toBeUndefined();
    expect(places[0].googleMapsUrl).toBe("https://maps.google.com/?cid=123");
  });

  it("garde les groupes disponibles et classe pertinence avant popularité", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        const body = JSON.parse(String(init?.body)) as {
          includedTypes: string[];
        };
        if (body.includedTypes.includes("bank")) {
          return new Response("indisponible", { status: 503 });
        }
        const retail = body.includedTypes.includes("supermarket");
        return Response.json({
          places: [
            {
              id: retail ? "retail-place" : "hotel-place",
              displayName: {
                text: retail ? "Petite boutique" : "Grand hôtel populaire",
              },
              formattedAddress: "Nantes",
              location: {
                latitude: retail ? 47.22 : 47.219,
                longitude: -1.55,
              },
              primaryTypeDisplayName: {
                text: retail ? "Magasin" : "Hôtel",
              },
              rating: retail ? 3.5 : 5,
              userRatingCount: retail ? 2 : 5_000,
              businessStatus: "OPERATIONAL",
            },
          ],
        });
      },
    );

    const result = await searchNearbyGooglePlacesDetailed(
      { lat: 47.2184, lng: -1.5536 },
      10,
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(result.failedGroups).toEqual([
      { id: "services", label: "services aux clients" },
    ]);
    expect(result.places.map(({ placeId }) => placeId)).toEqual([
      "retail-place",
      "hotel-place",
    ]);
  });

  it("conserve explicitement ROUTE_NOT_FOUND comme trajet indisponible", async () => {
    const candidates: GooglePlaceCandidate[] = [
      {
        placeId: "reachable",
        name: "Accessible",
        category: "Commerce",
        address: "Adresse",
        coordinates: { lat: 47.22, lng: -1.55 },
        distanceKm: 1.2,
        googleMapsUrl: "https://www.google.com/maps",
      },
      {
        placeId: "unreachable",
        name: "Sans itinéraire",
        category: "Commerce",
        address: "Adresse",
        coordinates: { lat: 47.23, lng: -1.54 },
        distanceKm: 2.4,
        googleMapsUrl: "https://www.google.com/maps",
      },
    ];
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json([
          {
            originIndex: 0,
            destinationIndex: 0,
            status: {},
            condition: "ROUTE_EXISTS",
            distanceMeters: 1850,
            duration: "601s",
          },
          {
            originIndex: 0,
            destinationIndex: 1,
            status: {},
            condition: "ROUTE_NOT_FOUND",
          },
        ]);
      },
    );

    const result = await computeGoogleRouteMatrix(
      { lat: 47.2184, lng: -1.5536 },
      candidates,
      ["BICYCLE"],
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(result.failedModes).toEqual([]);
    expect(result.travelByPlaceId.get("reachable")?.BICYCLE).toEqual({
      mode: "BICYCLE",
      durationMinutes: 11,
      distanceKm: 1.9,
      status: "available",
    });
    expect(result.travelByPlaceId.get("unreachable")?.BICYCLE).toEqual({
      mode: "BICYCLE",
      durationMinutes: 0,
      distanceKm: 2.4,
      status: "unavailable",
    });
  });

  it("utilise un Place ID Google ou les coordonnées selon la provenance", async () => {
    const candidates: GooglePlaceCandidate[] = [
      {
        placeId: "google-result",
        googlePlaceId: "ChIJ-google",
        name: "Lieu Google",
        category: "Commerce",
        address: "Nantes",
        coordinates: { lat: 47.22, lng: -1.55 },
        distanceKm: 1,
        googleMapsUrl: "https://www.google.com/maps",
      },
      {
        placeId: "lba:result",
        name: "Employeur LBA",
        category: "Commerce",
        address: "Nantes",
        coordinates: { lat: 47.23, lng: -1.54 },
        distanceKm: 2,
        googleMapsUrl: "https://www.google.com/maps",
      },
    ];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        departureTime?: string;
        destinations: unknown[];
      };
      expect(body.destinations).toEqual([
        { waypoint: { placeId: "ChIJ-google" } },
        {
          waypoint: {
            location: { latLng: { latitude: 47.23, longitude: -1.54 } },
          },
        },
      ]);
      expect(body.departureTime).toBe("2026-10-12T06:30:00.000Z");
      return Response.json(
        body.destinations.map((_, destinationIndex) => ({
          originIndex: 0,
          destinationIndex,
          status: {},
          condition: "ROUTE_EXISTS",
          distanceMeters: 1_000 + destinationIndex,
          duration: "600s",
        })),
      );
    });

    await computeGoogleRouteMatrix(
      { lat: 47.2184, lng: -1.5536 },
      candidates,
      ["DRIVE"],
      "server-secret",
      {
        fetchImpl: fetchMock,
        now: () => new Date("2026-10-12T05:45:00.000Z"),
      },
    );
  });

  it("isole une réponse HTTP 200 non matricielle au mode concerné", async () => {
    const candidates: GooglePlaceCandidate[] = [
      {
        placeId: "place-1",
        name: "Commerce",
        category: "Commerce",
        address: "Nantes",
        coordinates: { lat: 47.22, lng: -1.55 },
        distanceKm: 1.2,
        googleMapsUrl: "https://www.google.com/maps",
      },
    ];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { travelMode: string };
      if (body.travelMode === "DRIVE") {
        return Response.json({ error: { message: "upstream proxy error" } });
      }
      return Response.json([
        {
          originIndex: 0,
          destinationIndex: 0,
          status: {},
          condition: "ROUTE_EXISTS",
          distanceMeters: 1_500,
          duration: "720s",
        },
      ]);
    });

    const result = await computeGoogleRouteMatrix(
      { lat: 47.2184, lng: -1.5536 },
      candidates,
      ["DRIVE", "WALK"],
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(result.failedModes).toEqual(["DRIVE"]);
    expect(result.travelByPlaceId.get("place-1")?.DRIVE).toEqual({
      mode: "DRIVE",
      durationMinutes: 0,
      distanceKm: 1.2,
      status: "unavailable",
    });
    expect(result.travelByPlaceId.get("place-1")?.WALK).toEqual({
      mode: "WALK",
      durationMinutes: 12,
      distanceKm: 1.5,
      status: "available",
    });
  });

  it.each([
    {
      label: "un élément nul",
      payload: [null],
    },
    {
      label: "un statut du mauvais type",
      payload: [
        {
          originIndex: 0,
          destinationIndex: 0,
          status: "OK",
          condition: "ROUTE_EXISTS",
          distanceMeters: 1_000,
          duration: "600s",
        },
      ],
    },
    {
      label: "un index de destination hors limites",
      payload: [
        {
          originIndex: 0,
          destinationIndex: 4,
          status: {},
          condition: "ROUTE_EXISTS",
          distanceMeters: 1_000,
          duration: "600s",
        },
      ],
    },
  ])("convertit $label en échec contrôlé", async ({ payload }) => {
    const candidate: GooglePlaceCandidate = {
      placeId: "place-1",
      name: "Commerce",
      category: "Commerce",
      address: "Nantes",
      coordinates: { lat: 47.22, lng: -1.55 },
      distanceKm: 1.2,
      googleMapsUrl: "https://www.google.com/maps",
    };
    const fetchMock = vi.fn(async () => Response.json(payload));

    const result = await computeGoogleRouteMatrix(
      { lat: 47.2184, lng: -1.5536 },
      [candidate],
      ["BICYCLE"],
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(result.failedModes).toEqual(["BICYCLE"]);
    expect(result.travelByPlaceId.get("place-1")?.BICYCLE?.status).toBe(
      "unavailable",
    );
  });

  it("refuse une matrice HTTP 200 incomplète sans laisser de trajet absent", async () => {
    const candidates: GooglePlaceCandidate[] = [
      {
        placeId: "place-1",
        name: "Commerce 1",
        category: "Commerce",
        address: "Nantes",
        coordinates: { lat: 47.22, lng: -1.55 },
        distanceKm: 1.2,
        googleMapsUrl: "https://www.google.com/maps",
      },
      {
        placeId: "place-2",
        name: "Commerce 2",
        category: "Commerce",
        address: "Nantes",
        coordinates: { lat: 47.23, lng: -1.54 },
        distanceKm: 2.4,
        googleMapsUrl: "https://www.google.com/maps",
      },
    ];
    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          originIndex: 0,
          destinationIndex: 0,
          status: {},
          condition: "ROUTE_EXISTS",
          distanceMeters: 1_000,
          duration: "600s",
        },
      ]),
    );

    const result = await computeGoogleRouteMatrix(
      { lat: 47.2184, lng: -1.5536 },
      candidates,
      ["TRANSIT"],
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(result.failedModes).toEqual(["TRANSIT"]);
    expect(result.travelByPlaceId.get("place-1")?.TRANSIT?.status).toBe(
      "unavailable",
    );
    expect(result.travelByPlaceId.get("place-2")?.TRANSIT?.status).toBe(
      "unavailable",
    );
  });

  it("calcule tous les résultats par lots de 25 avec une concurrence bornée", async () => {
    const candidates: GooglePlaceCandidate[] = Array.from(
      { length: 60 },
      (_, index) => ({
        placeId: `place-${index}`,
        name: `Commerce ${index}`,
        category: "Commerce",
        address: `Adresse ${index}`,
        coordinates: { lat: 47.22 + index / 100_000, lng: -1.55 },
        distanceKm: 1 + index / 10,
        googleMapsUrl: "https://www.google.com/maps",
      }),
    );
    let activeRequests = 0;
    let maximumConcurrency = 0;
    const batchSizes: number[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        activeRequests += 1;
        maximumConcurrency = Math.max(maximumConcurrency, activeRequests);
        const body = JSON.parse(String(init?.body)) as {
          destinations: unknown[];
          travelMode: string;
        };
        batchSizes.push(body.destinations.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;
        return Response.json(
          body.destinations.map((_, destinationIndex) => ({
            originIndex: 0,
            destinationIndex,
            status: {},
            condition: "ROUTE_EXISTS",
            distanceMeters: 2_000 + destinationIndex,
            duration: body.travelMode === "DRIVE" ? "600s" : "900s",
          })),
        );
      },
    );

    const result = await computeGoogleRouteMatrix(
      { lat: 47.2184, lng: -1.5536 },
      candidates,
      ["DRIVE", "BICYCLE"],
      "server-secret",
      { fetchImpl: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(batchSizes.sort((left, right) => left - right)).toEqual([
      10,
      10,
      25,
      25,
      25,
      25,
    ]);
    expect(maximumConcurrency).toBeLessThanOrEqual(5);
    expect(maximumConcurrency).toBeGreaterThan(1);
    expect(result.travelByPlaceId.size).toBe(60);
    expect(result.travelByPlaceId.get("place-59")?.DRIVE?.status).toBe(
      "available",
    );
    expect(result.travelByPlaceId.get("place-59")?.BICYCLE?.status).toBe(
      "available",
    );
  });

  it("interrompt une réponse Google chunked qui dépasse la limite réelle", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(4_500_000);
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.enqueue(chunk);
          },
          cancel,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      resolveGoogleOrigin(
        { kind: "address", address: "Nantes" },
        "server-secret",
        { fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("annule le corps d'une réponse Google en erreur HTTP", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({ cancel }),
        { status: 503 },
      ),
    );

    await expect(
      resolveGoogleOrigin(
        { kind: "address", address: "Nantes" },
        "server-secret",
        { fetchImpl: fetchMock },
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_HTTP_ERROR", status: 503 });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
