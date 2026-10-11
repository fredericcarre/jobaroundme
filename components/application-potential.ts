import type { ApplicationPotential, EmployerMatch } from "@/lib/types";

export const APPLICATION_POTENTIAL_COPY: Record<
  ApplicationPotential["level"],
  { label: string; inlineLabel: string }
> = {
  high: { label: "Fort", inlineLabel: "fort" },
  medium: { label: "Moyen", inlineLabel: "moyen" },
  low: { label: "Faible", inlineLabel: "faible" },
  "to-qualify": { label: "À qualifier", inlineLabel: "à qualifier" },
};

export const POTENTIAL_CONFIDENCE_COPY: Record<
  ApplicationPotential["confidence"],
  string
> = {
  high: "élevée",
  medium: "moyenne",
  low: "faible",
};

export const WEBSITE_STATUS_COPY: Record<
  ApplicationPotential["websiteStatus"],
  string
> = {
  "found-and-checked": "Site trouvé · analysé",
  "found-not-checked": "Site trouvé · non analysé",
  blocked: "Site trouvé · analyse bloquée",
  unreachable: "Site trouvé · inaccessible lors de la recherche",
  "not-listed": "Aucun site indiqué par les sources",
};

export function websiteWasFound(result: EmployerMatch) {
  return result.applicationPotential.websiteStatus !== "not-listed";
}

export function websiteStatusLabel(result: EmployerMatch) {
  return WEBSITE_STATUS_COPY[result.applicationPotential.websiteStatus];
}

