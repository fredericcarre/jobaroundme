import type { Coordinates } from "@/lib/types";

const EARTH_RADIUS_KM = 6_371.0088;

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceKm(
  from: Coordinates,
  to: Coordinates,
): number {
  const latitudeDelta = degreesToRadians(to.lat - from.lat);
  const longitudeDelta = degreesToRadians(to.lng - from.lng);
  const fromLatitude = degreesToRadians(from.lat);
  const toLatitude = degreesToRadians(to.lat);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

export function offsetCoordinates(
  origin: Coordinates,
  northKm: number,
  eastKm: number,
): Coordinates {
  const latitudeOffset = northKm / 110.574;
  const longitudeScale = Math.max(
    Math.cos(degreesToRadians(origin.lat)),
    0.01,
  );
  const longitudeOffset = eastKm / (111.32 * longitudeScale);

  return {
    lat: Math.max(-90, Math.min(90, origin.lat + latitudeOffset)),
    lng: normalizeLongitude(origin.lng + longitudeOffset),
  };
}

function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}
