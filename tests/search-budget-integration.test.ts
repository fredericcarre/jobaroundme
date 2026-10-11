import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GooglePlaceCandidate } from "@/lib/google-maps";
import { analyzeCvProfile } from "@/lib/cv-profile";

const mocks = vi.hoisted(() => ({
  computeGoogleRouteMatrix: vi.fn(),
  resolveGoogleOrigin: vi.fn(),
  searchNearbyGooglePlacesDetailed: vi.fn(),
  inspectEmployerWebsite: vi.fn(),
  laBonneAlternanceApiKey: vi.fn(),
  mergeLaBonneAlternanceWithGoogle: vi.fn(),
  searchLaBonneAlternance: vi.fn(),
}));

const ORIGINAL_SITE_SCAN = process.env.ENABLE_SITE_SCAN;
const ORIGINAL_SITE_SCAN_LIMIT = process.env.SITE_SCAN_LIMIT;

vi.mock("@/lib/google-maps", () => ({
  computeGoogleRouteMatrix: mocks.computeGoogleRouteMatrix,
  googlePlaceTypesForProfile: vi.fn(() => []),
  googleMapsApiKey: vi.fn(() => "google-test-key"),
  resolveGoogleOrigin: mocks.resolveGoogleOrigin,
  searchNearbyGooglePlacesDetailed: mocks.searchNearbyGooglePlacesDetailed,
}));

vi.mock("@/lib/la-bonne-alternance", () => ({
  laBonneAlternanceApiKey: mocks.laBonneAlternanceApiKey,
  mergeLaBonneAlternanceWithGoogle: mocks.mergeLaBonneAlternanceWithGoogle,
  searchLaBonneAlternance: mocks.searchLaBonneAlternance,
}));

vi.mock("@/lib/site-scanner", () => ({
  inspectEmployerWebsite: mocks.inspectEmployerWebsite,
}));

import { searchEmployers } from "@/lib/search-service";

beforeEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_SITE_SCAN === undefined) {
    delete process.env.ENABLE_SITE_SCAN;
  } else {
    process.env.ENABLE_SITE_SCAN = ORIGINAL_SITE_SCAN;
  }
  delete process.env.SITE_SCAN_LIMIT;
  mocks.resolveGoogleOrigin.mockResolvedValue({
    label: "Nantes",
    coordinates: { lat: 47.22, lng: -1.55 },
  });
  mocks.laBonneAlternanceApiKey.mockReturnValue(undefined);
  mocks.searchNearbyGooglePlacesDetailed.mockResolvedValue({
    places: Array.from({ length: 6 }, (_, index) => candidate(index)),
    failedGroups: [],
  });
  mocks.computeGoogleRouteMatrix.mockImplementation(
    async (_origin, places: GooglePlaceCandidate[]) => ({
      travelByPlaceId: new Map(places.map(({ placeId }) => [placeId, {}])),
      failedModes: [],
    }),
  );
  mocks.inspectEmployerWebsite.mockResolvedValue({
    status: "checked",
    checkedAt: "2026-10-11T08:00:00.000Z",
    pagesChecked: 1,
    evidence: [],
    matchedKeywords: [],
  });
});

afterEach(() => {
  if (ORIGINAL_SITE_SCAN === undefined) {
    delete process.env.ENABLE_SITE_SCAN;
  } else {
    process.env.ENABLE_SITE_SCAN = ORIGINAL_SITE_SCAN;
  }
  if (ORIGINAL_SITE_SCAN_LIMIT === undefined) {
    delete process.env.SITE_SCAN_LIMIT;
  } else {
    process.env.SITE_SCAN_LIMIT = ORIGINAL_SITE_SCAN_LIMIT;
  }
});

describe("budget d’exécution de la recherche", () => {
  it("inspecte par défaut tous les sites du budget maximal de 40 employeurs", async () => {
    mocks.searchNearbyGooglePlacesDetailed.mockResolvedValueOnce({
      places: Array.from({ length: 40 }, (_, index) => candidate(index)),
      failedGroups: [],
    });

    const response = await searchEmployers(
      {
        origin: { kind: "address", address: "Nantes, France" },
        radiusKm: 10,
        travelModes: ["TRANSIT"],
      },
      { maxEmployers: 40 },
    );

    expect(mocks.inspectEmployerWebsite).toHaveBeenCalledTimes(40);
    expect(response.coverage.websitesFound).toBe(40);
    expect(response.coverage.websitesChecked).toBe(40);
  });

  it("borne à huit les inspections de sites exécutées en parallèle", async () => {
    mocks.searchNearbyGooglePlacesDetailed.mockResolvedValueOnce({
      places: Array.from({ length: 16 }, (_, index) => candidate(index)),
      failedGroups: [],
    });
    let activeInspections = 0;
    let maximumConcurrency = 0;
    mocks.inspectEmployerWebsite.mockImplementation(async () => {
      activeInspections += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeInspections);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeInspections -= 1;
      return {
        status: "checked",
        checkedAt: "2026-10-11T08:00:00.000Z",
        pagesChecked: 1,
        evidence: [],
        matchedKeywords: [],
      };
    });

    await searchEmployers(
      {
        origin: { kind: "address", address: "Nantes, France" },
        radiusKm: 10,
        travelModes: ["TRANSIT"],
      },
      { maxEmployers: 16 },
    );

    expect(maximumConcurrency).toBe(8);
  });

  it("borne à seize les inspections cumulées de plusieurs recherches", async () => {
    mocks.searchNearbyGooglePlacesDetailed.mockResolvedValue({
      places: Array.from({ length: 16 }, (_, index) => candidate(index)),
      failedGroups: [],
    });
    let activeInspections = 0;
    let maximumConcurrency = 0;
    mocks.inspectEmployerWebsite.mockImplementation(async () => {
      activeInspections += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeInspections);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeInspections -= 1;
      return {
        status: "checked",
        checkedAt: "2026-10-11T08:00:00.000Z",
        pagesChecked: 1,
        evidence: [],
        matchedKeywords: [],
      };
    });

    await Promise.all(
      Array.from({ length: 3 }, () =>
        searchEmployers(
          {
            origin: { kind: "address", address: "Nantes, France" },
            radiusKm: 10,
            travelModes: ["TRANSIT"],
          },
          { maxEmployers: 16 },
        ),
      ),
    );

    expect(mocks.inspectEmployerWebsite).toHaveBeenCalledTimes(48);
    expect(maximumConcurrency).toBe(16);
  });

  it("rend les contrôles déjà terminés lorsque le budget de 24 secondes expire", async () => {
    vi.useFakeTimers();
    try {
      mocks.searchNearbyGooglePlacesDetailed.mockResolvedValueOnce({
        places: Array.from({ length: 40 }, (_, index) => candidate(index)),
        failedGroups: [],
      });
      let deadlineAborts = 0;
      mocks.inspectEmployerWebsite.mockImplementation(
        async (url: string, options: { signal?: AbortSignal }) => {
          const index = Number.parseInt(
            url.match(/entreprise-(\d+)/)?.[1] ?? "99",
            10,
          );
          if (index < 4) {
            return {
              status: "checked",
              checkedAt: "2026-10-11T08:00:00.000Z",
              pagesChecked: 1,
              evidence: [],
              matchedKeywords: [],
            };
          }
          return new Promise((_resolve, reject) => {
            const signal = options.signal;
            signal?.addEventListener(
              "abort",
              () => {
                deadlineAborts += 1;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      );

      const responsePromise = searchEmployers(
        {
          origin: { kind: "address", address: "Nantes, France" },
          radiusKm: 10,
          travelModes: ["TRANSIT"],
        },
        { maxEmployers: 40 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.inspectEmployerWebsite.mock.calls.length).toBeGreaterThanOrEqual(
        8,
      );
      await vi.advanceTimersByTimeAsync(24_000);
      const response = await responsePromise;

      expect(response.partial).toBe(true);
      expect(response.coverage.websitesFound).toBe(40);
      expect(response.coverage.websitesChecked).toBe(4);
      expect(deadlineAborts).toBe(8);
      expect(response.notices).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "limite de temps réservée à l’analyse des sites",
          ),
        ]),
      );
      const unfinished = response.results.filter(
        (result) => result.siteInspection.pagesChecked === 0,
      );
      expect(unfinished).toHaveLength(36);
      expect(
        unfinished.every((result) =>
          result.siteInspection.note?.includes("limite de temps"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("annule sans lancer les inspections en attente du sémaphore global", async () => {
    mocks.searchNearbyGooglePlacesDetailed.mockResolvedValue({
      places: Array.from({ length: 16 }, (_, index) => candidate(index)),
      failedGroups: [],
    });
    let releaseInspections: (() => void) | undefined;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspections = resolve;
    });
    mocks.inspectEmployerWebsite.mockImplementation(async () => {
      await inspectionGate;
      return {
        status: "checked",
        checkedAt: "2026-10-11T08:00:00.000Z",
        pagesChecked: 1,
        evidence: [],
        matchedKeywords: [],
      };
    });

    const blockers = Array.from({ length: 2 }, () =>
      searchEmployers(
        {
          origin: { kind: "address", address: "Nantes, France" },
          radiusKm: 10,
          travelModes: ["TRANSIT"],
        },
        { maxEmployers: 16 },
      ),
    );
    await vi.waitFor(() => {
      expect(mocks.inspectEmployerWebsite).toHaveBeenCalledTimes(16);
    });

    const controller = new AbortController();
    const queuedSearch = searchEmployers(
      {
        origin: { kind: "address", address: "Nantes, France" },
        radiusKm: 10,
        travelModes: ["TRANSIT"],
      },
      { signal: controller.signal, maxEmployers: 8 },
    );
    await vi.waitFor(() => {
      expect(mocks.computeGoogleRouteMatrix).toHaveBeenCalledTimes(3);
    });
    controller.abort();

    await expect(queuedSearch).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.inspectEmployerWebsite).toHaveBeenCalledTimes(16);

    releaseInspections?.();
    await Promise.all(blockers);
  });

  it("plafonne les destinations avant Routes et les inspections de sites", async () => {
    const response = await searchEmployers(
      {
        origin: { kind: "address", address: "Nantes, France" },
        radiusKm: 10,
        travelModes: ["TRANSIT"],
      },
      { maxEmployers: 2 },
    );

    expect(mocks.computeGoogleRouteMatrix).toHaveBeenCalledTimes(1);
    const routeDestinations = mocks.computeGoogleRouteMatrix.mock.calls[0][1];
    expect(routeDestinations).toHaveLength(2);
    expect(mocks.inspectEmployerWebsite).toHaveBeenCalledTimes(2);
    expect(response.results).toHaveLength(2);
    expect(
      response.notices.some((notice) =>
        notice.includes("2 entreprises prioritaires ont été retenues sur 6"),
      ),
    ).toBe(true);
  });

  it("arrête le pipeline entre deux grandes phases lorsque le client annule", async () => {
    const controller = new AbortController();
    mocks.resolveGoogleOrigin.mockImplementationOnce(async () => {
      controller.abort();
      return {
        label: "Nantes",
        coordinates: { lat: 47.22, lng: -1.55 },
      };
    });

    await expect(
      searchEmployers(
        {
          origin: { kind: "address", address: "Nantes, France" },
          radiusKm: 10,
          travelModes: ["TRANSIT"],
        },
        { signal: controller.signal, maxEmployers: 2 },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mocks.searchNearbyGooglePlacesDetailed).not.toHaveBeenCalled();
    expect(mocks.computeGoogleRouteMatrix).not.toHaveBeenCalled();
  });

  it("conserve les pistes LBA lorsque tous les groupes Places échouent", async () => {
    const lbaPlace = candidate(99);
    delete lbaPlace.googlePlaceId;
    mocks.searchNearbyGooglePlacesDetailed.mockRejectedValueOnce(
      new Error("Places indisponible"),
    );
    mocks.laBonneAlternanceApiKey.mockReturnValue("lba-test-key");
    mocks.searchLaBonneAlternance.mockResolvedValue({
      employers: [],
      warnings: [],
      statistics: {
        jobsReceived: 1,
        recruitersReceived: 0,
        publicOffersIncluded: 1,
        recruitersIncluded: 0,
        delegatedJobsHidden: 0,
        invalidOrInactiveItemsSkipped: 0,
      },
    });
    mocks.mergeLaBonneAlternanceWithGoogle.mockReturnValue({
      places: [lbaPlace],
      evidenceByPlaceId: new Map(),
      keywordsByPlaceId: new Map(),
      mergedEmployers: 0,
      addedEmployers: 1,
    });

    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
    });

    expect(response.results).toHaveLength(1);
    expect(response.partial).toBe(true);
    expect(response.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("seule source d’employeurs"),
        expect.stringContaining("couverture est partielle"),
      ]),
    );
    expect(mocks.computeGoogleRouteMatrix).toHaveBeenCalledWith(
      expect.anything(),
      [lbaPlace],
      ["TRANSIT"],
      "google-test-key",
      expect.anything(),
    );
  });

  it("marque la réponse partielle lorsque LBA renvoie un avertissement", async () => {
    mocks.laBonneAlternanceApiKey.mockReturnValue("lba-test-key");
    mocks.searchLaBonneAlternance.mockResolvedValue({
      employers: [],
      warnings: [{ code: "PARTIAL", message: "Résultats incomplets" }],
      statistics: {
        jobsReceived: 0,
        recruitersReceived: 0,
        publicOffersIncluded: 0,
        recruitersIncluded: 0,
        delegatedJobsHidden: 0,
        invalidOrInactiveItemsSkipped: 0,
      },
    });
    mocks.mergeLaBonneAlternanceWithGoogle.mockReturnValue({
      places: [],
      evidenceByPlaceId: new Map(),
      keywordsByPlaceId: new Map(),
      mergedEmployers: 0,
      addedEmployers: 0,
    });

    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
    });

    expect(response.partial).toBe(true);
  });

  it("transmet à LBA les mêmes codes ROME que le profil CV affiché", async () => {
    const profile = analyzeCvProfile(
      "Étudiant en première année de BTS Management commercial opérationnel.",
    );
    const places = Array.from({ length: 2 }, (_, index) => candidate(index));
    mocks.laBonneAlternanceApiKey.mockReturnValue("lba-test-key");
    mocks.searchLaBonneAlternance.mockResolvedValue({
      employers: [],
      warnings: [],
      statistics: {
        jobsReceived: 0,
        recruitersReceived: 0,
        publicOffersIncluded: 0,
        recruitersIncluded: 0,
        delegatedJobsHidden: 0,
        invalidOrInactiveItemsSkipped: 0,
      },
    });
    mocks.mergeLaBonneAlternanceWithGoogle.mockReturnValue({
      places,
      evidenceByPlaceId: new Map(),
      keywordsByPlaceId: new Map(),
      mergedEmployers: 0,
      addedEmployers: 0,
    });

    await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
      profile,
    });

    expect(mocks.searchLaBonneAlternance).toHaveBeenCalledWith(
      { lat: 47.22, lng: -1.55 },
      10,
      "lba-test-key",
      expect.objectContaining({ romeCodes: profile.romeCodes }),
    );
  });

  it("ne prétend pas avoir consulté des sites lorsque leur analyse est désactivée", async () => {
    process.env.ENABLE_SITE_SCAN = "false";

    const response = await searchEmployers({
      origin: { kind: "address", address: "Nantes, France" },
      radiusKm: 10,
      travelModes: ["TRANSIT"],
    });

    expect(mocks.inspectEmployerWebsite).not.toHaveBeenCalled();
    expect(response.notices.join(" ")).toContain(
      "L’analyse des sites employeurs est désactivée",
    );
    expect(response.notices.join(" ")).not.toContain(
      "aux sites publics des employeurs",
    );
    expect(response.notices.join(" ")).not.toContain(
      "sites employeurs consultés",
    );
  });
});

function candidate(index: number): GooglePlaceCandidate {
  return {
    placeId: `place-${index}`,
    name: `Entreprise ${index}`,
    category: "Commerce",
    address: `${index} rue fictive, Nantes`,
    coordinates: { lat: 47.22 + index / 10_000, lng: -1.55 },
    distanceKm: index + 1,
    websiteUrl: `https://entreprise-${index}.example/`,
    googleMapsUrl: "https://www.google.com/maps",
    searchGroup: "retail",
  };
}
