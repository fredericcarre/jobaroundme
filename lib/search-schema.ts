import { z } from "zod";

import { TRAVEL_MODES } from "@/lib/types";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const candidateProfileSchema = z
  .object({
    headline: boundedText(180),
    diploma: boundedText(180).optional(),
    targetRoles: z.array(boundedText(120)).max(12),
    skills: z.array(boundedText(120)).max(40),
    sectors: z.array(boundedText(120)).max(16),
    keywords: z.array(boundedText(120)).max(40),
    romeCodes: z
      .array(z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{4}$/))
      .max(10),
    confidence: z.enum(["high", "medium", "low"]),
    explanations: z.array(boundedText(280)).max(16),
  })
  .strict();

const coordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const originSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("address"),
    address: z.string().trim().min(3).max(200),
  }),
  z.object({
    kind: z.literal("coordinates"),
    coordinates: coordinatesSchema,
    label: z.string().trim().max(120).optional(),
  }),
]);

export const searchInputSchema = z.object({
  origin: originSchema,
  radiusKm: z.number().min(1).max(50),
  travelModes: z.array(z.enum(TRAVEL_MODES)).min(1).max(TRAVEL_MODES.length),
  profile: candidateProfileSchema.optional(),
}).strict();
