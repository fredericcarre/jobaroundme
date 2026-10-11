"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

import { safePublicHttpUrl } from "@/lib/public-url";
import type { EmployerMatch, ResolvedOrigin } from "@/lib/types";

import { APPLICATION_POTENTIAL_COPY } from "@/components/application-potential";
import { ArrowIcon, ExternalIcon, LocationIcon } from "@/components/icons";

let mapsLoadPromise:
  | Promise<{
      Map: typeof google.maps.Map;
      Marker: typeof google.maps.Marker;
    }>
  | undefined;

function loadGoogleMaps(key: string) {
  if (!mapsLoadPromise) {
    setOptions({
      key,
      v: "weekly",
      language: "fr",
      region: "FR",
      authReferrerPolicy: "origin",
    });
    mapsLoadPromise = Promise.all([
      importLibrary("maps"),
      importLibrary("marker"),
    ]).then(([maps, marker]) => ({ Map: maps.Map, Marker: marker.Marker }));
  }

  return mapsLoadPromise;
}

function opportunityLabel(level: EmployerMatch["opportunityLevel"]) {
  if (level === "public-offer") return "Offre publiée";
  if (level === "recruitment-page") return "Page recrutement";
  return "À prospecter";
}

export function mapResultLabel(result: EmployerMatch) {
  return `${opportunityLabel(result.opportunityLevel)} · potentiel ${APPLICATION_POTENTIAL_COPY[result.applicationPotential.level].inlineLabel}`;
}

interface SchematicPoint {
  id: string;
  left: number;
  top: number;
  rank: number;
}

interface SchematicPosition {
  left: number;
  top: number;
}

interface SchematicBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  latSpan: number;
  lngSpan: number;
}

function schematicPosition(
  coordinates: EmployerMatch["coordinates"],
  bounds: SchematicBounds,
): SchematicPosition {
  const rawLeft = 10 + ((coordinates.lng - bounds.minLng) / bounds.lngSpan) * 80;
  const rawTop = 10 + ((bounds.maxLat - coordinates.lat) / bounds.latSpan) * 80;

  return {
    left: Math.min(91, Math.max(7, rawLeft)),
    top: Math.min(88, Math.max(8, rawTop)),
  };
}

export function schematicLayout(results: EmployerMatch[], origin: ResolvedOrigin) {
  const coordinates = [origin.coordinates, ...results.map((result) => result.coordinates)];
  const latitudes = coordinates.map((point) => point.lat);
  const longitudes = coordinates.map((point) => point.lng);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latSpan = Math.max(maxLat - minLat, 0.008);
  const lngSpan = Math.max(maxLng - minLng, 0.008);
  const bounds = { minLat, maxLat, minLng, latSpan, lngSpan };
  const coordinateOccurrences = new Map<string, number>();
  const originKey = coordinateKey(origin.coordinates);
  coordinateOccurrences.set(originKey, 1);

  return {
    origin: schematicPosition(origin.coordinates, bounds),
    points: results.map<SchematicPoint>((result, index) => {
      const position = schematicPosition(result.coordinates, bounds);
      const key = coordinateKey(result.coordinates);
      const occurrence = coordinateOccurrences.get(key) ?? 0;
      coordinateOccurrences.set(key, occurrence + 1);
      const angle = (occurrence % 8) * (Math.PI / 4);
      const ring = Math.floor(occurrence / 8) + 1;
      const stagger = occurrence > 0 ? Math.min(7, 2.4 * ring) : 0;

      return {
        id: result.id,
        left: Math.min(91, Math.max(7, position.left + Math.cos(angle) * stagger)),
        top: Math.min(88, Math.max(8, position.top + Math.sin(angle) * stagger)),
        rank: index + 1,
      };
    }),
  };
}

function coordinateKey(coordinates: EmployerMatch["coordinates"]) {
  return `${coordinates.lat.toFixed(6)},${coordinates.lng.toFixed(6)}`;
}

interface ResultsMapProps {
  results: EmployerMatch[];
  origin: ResolvedOrigin;
  selectedId?: string;
  browserMapKey?: string;
  onSelect: (id: string) => void;
  onShowInList: (id: string) => void;
}

export function ResultsMap({
  results,
  origin,
  selectedId,
  browserMapKey,
  onSelect,
  onShowInList,
}: ResultsMapProps) {
  const mapNodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const originMarkerRef = useRef<google.maps.Marker | null>(null);
  const markerRefs = useRef(new Map<string, google.maps.Marker>());
  const listenerRefs = useRef<google.maps.MapsEventListener[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const layout = useMemo(() => schematicLayout(results, origin), [origin, results]);
  const selected = results.find((result) => result.id === selectedId);

  useEffect(() => {
    if (!browserMapKey || !mapNodeRef.current) return;

    let cancelled = false;
    setMapReady(false);
    const markers = markerRefs.current;
    const listeners = listenerRefs.current;

    loadGoogleMaps(browserMapKey)
      .then(({ Map: GoogleMap, Marker }) => {
        if (cancelled || !mapNodeRef.current) return;

        listeners.forEach((listener) => listener.remove());
        listeners.length = 0;
        markers.forEach((marker) => marker.setMap(null));
        markers.clear();
        originMarkerRef.current?.setMap(null);

        const map =
          mapRef.current ||
          new GoogleMap(mapNodeRef.current, {
            center: origin.coordinates,
            zoom: 12,
            clickableIcons: false,
            disableDefaultUI: true,
            fullscreenControl: true,
            gestureHandling: "cooperative",
            mapTypeControl: false,
            streetViewControl: false,
            zoomControl: true,
            styles: [
              { elementType: "geometry", stylers: [{ color: "#e8eee8" }] },
              { elementType: "labels.text.fill", stylers: [{ color: "#526159" }] },
              { elementType: "labels.text.stroke", stylers: [{ color: "#f7f8f4" }] },
              { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
              { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#d7ded6" }] },
              { featureType: "poi", stylers: [{ visibility: "off" }] },
              { featureType: "transit", stylers: [{ visibility: "simplified" }] },
              { featureType: "water", elementType: "geometry", stylers: [{ color: "#bfdedb" }] },
            ],
          });

        mapRef.current = map;
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(origin.coordinates);

        originMarkerRef.current = new Marker({
          map,
          position: origin.coordinates,
          title: `Point de départ : ${origin.label}`,
          zIndex: 100,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: "#efff70",
            fillOpacity: 1,
            scale: 10,
            strokeColor: "#173c34",
            strokeWeight: 4,
          },
        });

        results.forEach((result, index) => {
          bounds.extend(result.coordinates);
          const marker = new Marker({
            map,
            position: result.coordinates,
            title: `${index + 1}. ${result.name} — ${mapResultLabel(result)}`,
            zIndex: 10,
            label: {
              text: String(index + 1),
              color: "#ffffff",
              fontFamily: "Arial, sans-serif",
              fontSize: "12px",
              fontWeight: "700",
            },
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              fillColor: "#173c34",
              fillOpacity: 1,
              scale: 13,
              strokeColor: "#ffffff",
              strokeWeight: 3,
            },
          });

          listeners.push(marker.addListener("click", () => onSelect(result.id)));
          markers.set(result.id, marker);
        });

        if (results.length) {
          map.fitBounds(bounds, 64);
          const zoomListener = map.addListener("idle", () => {
            const zoom = map.getZoom();
            if (zoom && zoom > 15) map.setZoom(15);
            zoomListener.remove();
          });
        }

        setMapReady(true);
        setMapFailed(false);
      })
      .catch(() => {
        if (!cancelled) setMapFailed(true);
      });

    return () => {
      cancelled = true;
      listeners.forEach((listener) => listener.remove());
      listeners.length = 0;
      markers.forEach((marker) => marker.setMap(null));
      markers.clear();
      originMarkerRef.current?.setMap(null);
      originMarkerRef.current = null;
    };
  }, [browserMapKey, onSelect, origin, results]);

  useEffect(() => {
    if (!mapReady) return;

    markerRefs.current.forEach((marker, id) => {
      const isSelected = id === selectedId;
      const resultIndex = results.findIndex((result) => result.id === id);
      const result = resultIndex >= 0 ? results[resultIndex] : undefined;
      marker.setZIndex(isSelected ? 50 : 10);
      if (result) {
        marker.setTitle(
          `${resultIndex + 1}. ${result.name} — ${mapResultLabel(result)}${isSelected ? " — sélectionné" : ""}`,
        );
      }
      marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: isSelected ? "#c94a34" : "#173c34",
        fillOpacity: 1,
        scale: isSelected ? 16 : 13,
        strokeColor: "#ffffff",
        strokeWeight: 3,
      });
    });
  }, [mapReady, results, selectedId]);

  const showSchematic = !browserMapKey || mapFailed;

  return (
    <section className="results-map" aria-label="Carte des entreprises trouvées">
      {showSchematic ? (
        <div className="schematic-map">
          <div className="schematic-road schematic-road--one" />
          <div className="schematic-road schematic-road--two" />
          <div className="schematic-road schematic-road--three" />
          <div className="schematic-water" />
          <div className="schematic-map__caption">
            <span>Aperçu des positions</span>
            <small>Carte schématique · les liens Google Maps donnent l’itinéraire exact</small>
          </div>
          <div
            className="origin-pin"
            style={{ left: `${layout.origin.left}%`, top: `${layout.origin.top}%` }}
            title={origin.label}
          >
            <LocationIcon />
            <span>Départ</span>
          </div>
          {layout.points.map((point) => {
            const result = results[point.rank - 1];
            return (
              <button
                aria-label={`${point.rank}. ${result.name} — ${mapResultLabel(result)} — score ${result.score.total} points`}
                aria-pressed={point.id === selectedId}
                className={`schematic-marker${point.id === selectedId ? " is-selected" : ""}`}
                key={point.id}
                onClick={() => onSelect(point.id)}
                style={{ left: `${point.left}%`, top: `${point.top}%` }}
                type="button"
              >
                <span>{point.rank}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="google-map" ref={mapNodeRef} />
          {!mapReady && (
            <div className="map-loading" role="status">
              <span className="mini-spinner" />
              Chargement de la carte…
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="map-card" aria-live="polite">
          <div className="map-card__main">
            <span>{mapResultLabel(selected)}</span>
            <strong>{selected.name}</strong>
            <small>{selected.category} · {selected.distanceKm.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km</small>
          </div>
          <div className="map-card__score">
            <strong>{selected.score.total}</strong>
            <small>pts</small>
          </div>
          <button onClick={() => onShowInList(selected.id)} type="button">
            Voir la fiche
            <ArrowIcon />
          </button>
          {safePublicHttpUrl(selected.googleMapsUrl) && (
            <a
              aria-label={`Ouvrir ${selected.name} dans Google Maps`}
              href={safePublicHttpUrl(selected.googleMapsUrl)}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalIcon />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

