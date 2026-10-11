import { offsetCoordinates } from "@/lib/geo";
import type { GooglePlaceCandidate } from "@/lib/google-maps";
import type {
  ResolvedOrigin,
  SearchInput,
  SiteInspection,
  TravelEstimate,
  TravelMode,
} from "@/lib/types";

const DEMO_CENTER = { lat: 48.8566, lng: 2.3522 };

export interface DemoEmployer extends GooglePlaceCandidate {
  travel: Partial<Record<TravelMode, TravelEstimate>>;
  siteInspection: SiteInspection;
}

interface DemoTemplate {
  slug: string;
  name: string;
  category: string;
  placeTypes: string[];
  hasWebsite?: boolean;
  northRatio: number;
  eastRatio: number;
  rating: number;
  reviewCount: number;
  evidence: SiteInspection["evidence"];
  matchedKeywords: string[];
}

const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    slug: "nova-marche",
    name: "[Démo] Marché Nova",
    category: "Supermarché fictif",
    placeTypes: ["supermarket", "grocery_store", "store"],
    northRatio: 0.12,
    eastRatio: 0.13,
    rating: 4.3,
    reviewCount: 184,
    evidence: [
      {
        level: "public-offer",
        title: "Offre fictive — Alternance conseiller de vente BTS MCO",
        url: "https://example.com/?demo=offre-alternance-mco",
        excerpt:
          "Contenu simulé : accueil client, vente-conseil, merchandising et gestion des stocks.",
        confidence: 0.96,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "specific",
      },
    ],
    matchedKeywords: [
      "alternance",
      "bts mco",
      "vente conseil",
      "merchandising",
      "stock",
    ],
  },
  {
    slug: "atelier-horizon",
    name: "[Démo] Boutique Horizon",
    category: "Magasin de sport fictif",
    placeTypes: ["sporting_goods_store", "store"],
    northRatio: -0.25,
    eastRatio: 0.24,
    rating: 4.5,
    reviewCount: 96,
    evidence: [
      {
        level: "recruitment-page",
        title: "Page carrières fictive — Rejoindre l’équipe",
        url: "https://example.com/?demo=page-carrieres",
        excerpt:
          "Contenu simulé : candidatures en vente, service client et animation commerciale.",
        confidence: 0.82,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "generic",
      },
    ],
    matchedKeywords: [
      "carrières",
      "vente",
      "service client",
      "animation commerciale",
    ],
  },
  {
    slug: "comptoir-lumiere",
    name: "[Démo] Comptoir Lumière",
    category: "Grand magasin fictif",
    placeTypes: ["department_store", "store"],
    hasWebsite: false,
    northRatio: 0.42,
    eastRatio: -0.46,
    rating: 4.1,
    reviewCount: 248,
    evidence: [],
    matchedKeywords: ["relation client", "mise en rayon"],
  },
  {
    slug: "hotel-azur",
    name: "[Démo] Hôtel Azur",
    category: "Hôtel fictif",
    placeTypes: ["hotel", "lodging"],
    northRatio: -0.55,
    eastRatio: -0.18,
    rating: 4.6,
    reviewCount: 312,
    evidence: [
      {
        level: "public-offer",
        title: "Offre fictive — Alternance assistant manager",
        url: "https://example.com/?demo=alternance-hotel-azur",
        excerpt:
          "Contenu simulé : accueil client, coordination d’équipe et suivi de la qualité de service.",
        confidence: 0.94,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "specific",
      },
    ],
    matchedKeywords: [
      "alternance",
      "assistant manager",
      "accueil client",
      "coordination d'équipe",
    ],
  },
  {
    slug: "cafe-mosaique",
    name: "[Démo] Café Mosaïque",
    category: "Café fictif",
    placeTypes: ["cafe", "restaurant"],
    northRatio: 0.08,
    eastRatio: -0.35,
    rating: 4.7,
    reviewCount: 141,
    evidence: [
      {
        level: "recruitment-page",
        title: "Page recrutement fictive — Équipe de vente",
        url: "https://example.com/?demo=recrutement-cafe-mosaique",
        excerpt:
          "Contenu simulé : espace de candidature pour l’accueil, la vente et le service client.",
        confidence: 0.8,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "generic",
      },
    ],
    matchedKeywords: ["recrutement", "vente", "service client"],
  },
  {
    slug: "banque-rivage",
    name: "[Démo] Banque Rivage",
    category: "Agence bancaire fictive",
    placeTypes: ["bank"],
    northRatio: -0.12,
    eastRatio: -0.5,
    rating: 4.0,
    reviewCount: 73,
    evidence: [
      {
        level: "public-offer",
        title: "Offre fictive — Conseiller clientèle en alternance",
        url: "https://example.com/?demo=alternance-banque-rivage",
        excerpt:
          "Contenu simulé : conseil client, fidélisation et développement de la relation commerciale.",
        confidence: 0.92,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "specific",
      },
    ],
    matchedKeywords: [
      "alternance",
      "conseiller clientèle",
      "conseil client",
      "fidélisation",
    ],
  },
  {
    slug: "mobile-pixel",
    name: "[Démo] Mobile Pixel",
    category: "Boutique de téléphonie fictive",
    placeTypes: ["cell_phone_store", "store"],
    northRatio: 0.3,
    eastRatio: 0.15,
    rating: 4.4,
    reviewCount: 205,
    evidence: [
      {
        level: "recruitment-page",
        title: "Page carrières fictive — Vente et services",
        url: "https://example.com/?demo=carrieres-mobile-pixel",
        excerpt:
          "Contenu simulé : métiers de conseiller de vente et responsable adjoint.",
        confidence: 0.84,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "generic",
      },
    ],
    matchedKeywords: [
      "carrières",
      "conseiller de vente",
      "responsable adjoint",
      "vente conseil",
    ],
  },
  {
    slug: "studio-eclat",
    name: "[Démo] Studio Éclat",
    category: "Salon de beauté fictif",
    placeTypes: ["beauty_salon"],
    northRatio: -0.4,
    eastRatio: 0.38,
    rating: 4.8,
    reviewCount: 88,
    evidence: [],
    matchedKeywords: ["accueil client", "fidélisation", "gestion opérationnelle"],
  },
  {
    slug: "maison-velo",
    name: "[Démo] Maison Vélo",
    category: "Magasin de vélos fictif",
    placeTypes: ["bicycle_store", "store"],
    northRatio: 0.56,
    eastRatio: 0.1,
    rating: 4.6,
    reviewCount: 167,
    evidence: [
      {
        level: "public-offer",
        title: "Offre fictive — Vendeur polyvalent en apprentissage",
        url: "https://example.com/?demo=apprentissage-maison-velo",
        excerpt:
          "Contenu simulé : vente-conseil, merchandising, stock et animation commerciale.",
        confidence: 0.95,
        sourceKind: "employer-site",
        directEmployer: true,
        specificity: "specific",
      },
    ],
    matchedKeywords: [
      "apprentissage",
      "vendeur polyvalent",
      "vente conseil",
      "merchandising",
      "stock",
      "animation commerciale",
    ],
  },
];

export function createDemoData(input: SearchInput): {
  origin: ResolvedOrigin;
  employers: DemoEmployer[];
} {
  const origin: ResolvedOrigin =
    input.origin.kind === "coordinates"
      ? {
          label:
            input.origin.label?.trim() ||
            `${input.origin.coordinates.lat.toFixed(5)}, ${input.origin.coordinates.lng.toFixed(5)}`,
          coordinates: input.origin.coordinates,
        }
      : {
          label: `${input.origin.address} — position fictive de démonstration`,
          coordinates: DEMO_CENTER,
        };

  const employers = DEMO_TEMPLATES.map((template) => {
    const northKm = scaledOffset(input.radiusKm, template.northRatio);
    const eastKm = scaledOffset(input.radiusKm, template.eastRatio);
    const coordinates = offsetCoordinates(
      origin.coordinates,
      northKm,
      eastKm,
    );
    const straightLineKm = Math.hypot(northKm, eastKm);
    const distanceKm = roundToOneDecimal(straightLineKm);

    return {
      placeId: `demo-${template.slug}`,
      name: template.name,
      category: template.category,
      placeTypes: template.placeTypes,
      address: `Adresse fictive — à environ ${distanceKm.toLocaleString("fr-FR")} km du point de départ`,
      coordinates,
      distanceKm,
      rating: template.rating,
      reviewCount: template.reviewCount,
      ...(template.hasWebsite === false
        ? {}
        : { websiteUrl: `https://example.com/?demo=${template.slug}` }),
      googleMapsUrl: demoMapUrl(coordinates),
      travel: createDemoTravel(distanceKm, input.travelModes),
      siteInspection:
        template.hasWebsite === false
          ? {
              status: "not-requested" as const,
              pagesChecked: 0,
              evidence: template.evidence,
              matchedKeywords: template.matchedKeywords,
              note:
                "Scénario fictif : aucun site internet public n’est indiqué pour cet employeur.",
            }
          : {
              status: "checked" as const,
              checkedAt: new Date().toISOString(),
              pagesChecked: template.evidence.length > 0 ? 2 : 1,
              ...(template.evidence[0]?.url
                ? { recruitmentPageUrl: template.evidence[0].url }
                : {}),
              evidence: template.evidence,
              matchedKeywords: template.matchedKeywords,
              note:
                "Inspection simulée : ce site, ces pages et ces preuves sont entièrement fictifs.",
            },
    } satisfies DemoEmployer;
  });

  return { origin, employers };
}

function createDemoTravel(
  distanceKm: number,
  modes: TravelMode[],
): Partial<Record<TravelMode, TravelEstimate>> {
  const routeDistanceKm = Math.max(0.6, distanceKm * 1.24);
  const travel: Partial<Record<TravelMode, TravelEstimate>> = {};

  for (const mode of modes) {
    let durationMinutes: number;
    switch (mode) {
      case "WALK":
        durationMinutes = (routeDistanceKm / 4.7) * 60;
        break;
      case "BICYCLE":
        durationMinutes = (routeDistanceKm / 15) * 60;
        break;
      case "TRANSIT":
        durationMinutes = (routeDistanceKm / 24) * 60 + 7;
        break;
      case "DRIVE":
        durationMinutes = (routeDistanceKm / 32) * 60 + 2;
        break;
      case "TWO_WHEELER":
        durationMinutes = (routeDistanceKm / 27) * 60 + 2;
        break;
    }

    travel[mode] = {
      mode,
      durationMinutes: Math.max(2, Math.ceil(durationMinutes)),
      distanceKm: roundToOneDecimal(routeDistanceKm),
      status: "available",
    };
  }

  return travel;
}

function demoMapUrl(coordinates: { lat: number; lng: number }): string {
  const center = `${coordinates.lat.toFixed(6)},${coordinates.lng.toFixed(6)}`;
  return `https://www.google.com/maps/@?api=1&map_action=map&center=${encodeURIComponent(center)}&zoom=14`;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function scaledOffset(radiusKm: number, ratio: number): number {
  return Math.max(0.25, radiusKm * Math.abs(ratio)) * Math.sign(ratio);
}
