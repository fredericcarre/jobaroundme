import type { ReactNode } from "react";

import { safePublicHttpUrl } from "@/lib/public-url";
import type { EmployerMatch, OpportunityLevel, TravelMode } from "@/lib/types";

import {
  APPLICATION_POTENTIAL_COPY,
  POTENTIAL_CONFIDENCE_COPY,
  websiteStatusLabel,
} from "@/components/application-potential";

import {
  ArrowIcon,
  BikeIcon,
  CarIcon,
  ExternalIcon,
  HeartIcon,
  ScooterIcon,
  TransitIcon,
  WalkIcon,
} from "@/components/icons";

const OPPORTUNITY_COPY: Record<
  OpportunityLevel,
  { label: string }
> = {
  "public-offer": {
    label: "Offre publiée",
  },
  "recruitment-page": {
    label: "Page recrutement",
  },
  prospecting: {
    label: "Candidature spontanée",
  },
};

const MODE_COPY: Record<TravelMode, { label: string; icon: ReactNode }> = {
  TRANSIT: {
    label: "Transports",
    icon: <TransitIcon />,
  },
  DRIVE: {
    label: "Voiture",
    icon: <CarIcon />,
  },
  BICYCLE: {
    label: "Vélo",
    icon: <BikeIcon />,
  },
  WALK: {
    label: "À pied",
    icon: <WalkIcon />,
  },
  TWO_WHEELER: {
    label: "Deux-roues",
    icon: <ScooterIcon />,
  },
};

function formatDuration(minutes: number) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  return remaining ? `${hours} h ${remaining.toString().padStart(2, "0")}` : `${hours} h`;
}

function formatEvidenceDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function inspectionCopy(result: EmployerMatch) {
  const inspection = result.siteInspection;

  if (inspection.status === "blocked") {
    return inspection.note;
  }
  if (inspection.status === "unreachable") {
    return inspection.note;
  }
  if (inspection.status === "not-requested") {
    return result.applicationPotential.websiteStatus === "not-listed"
      ? undefined
      : inspection.note;
  }
  if (!inspection.evidence.length) {
    return inspection.note || "Aucune offre publique repérée sur les pages consultées.";
  }

  return undefined;
}

function publicSignalMeaning(result: EmployerMatch) {
  if (result.opportunityLevel === "public-offer") {
    return "Une offre publique a été repérée.";
  }
  if (result.opportunityLevel === "recruitment-page") {
    return "Une page recrutement publique a été repérée ; l’ouverture d’un poste reste à vérifier.";
  }
  if (result.siteInspection.evidence.length > 0) {
    return "Un signal de prospection a été repéré ; il ne confirme pas l’ouverture d’un poste.";
  }

  switch (result.applicationPotential.websiteStatus) {
    case "found-and-checked":
      return "Pages consultées : aucune offre publique repérée.";
    case "blocked":
      return "Le site a limité la vérification automatique ; son contenu reste à contrôler.";
    case "unreachable":
      return "Le site était inaccessible pendant cette recherche ; son contenu reste à contrôler.";
    case "found-not-checked":
      return "Le site a été identifié, sans analyse de son contenu pendant cette recherche.";
    case "not-listed":
      return "Les sources consultées n’indiquent pas de site d’entreprise à analyser.";
  }
}

interface ResultCardProps {
  result: EmployerMatch;
  rank: number;
  selected: boolean;
  travelModes: TravelMode[];
  usesCvProfile: boolean;
  favorite: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

export function ResultCard({
  result,
  rank,
  selected,
  travelModes,
  usesCvProfile,
  favorite,
  onSelect,
  onToggleFavorite,
}: ResultCardProps) {
  const opportunity = OPPORTUNITY_COPY[result.opportunityLevel];
  const potential = APPLICATION_POTENTIAL_COPY[result.applicationPotential.level];
  const evidence = result.siteInspection.evidence[0];
  const evidenceUrl = safePublicHttpUrl(evidence?.url);
  const additionalPublicOffers = result.siteInspection.evidence
    .slice(1)
    .filter((item) => item.level === "public-offer");
  const websiteUrl =
    result.siteInspection.status === "checked" &&
    result.siteInspection.pagesChecked > 0
      ? safePublicHttpUrl(result.websiteUrl)
      : undefined;
  const mapsUrl = safePublicHttpUrl(result.googleMapsUrl);
  const recruitmentUrl =
    result.siteInspection.status === "checked" &&
    result.siteInspection.pagesChecked > 0
      ? safePublicHttpUrl(result.siteInspection.recruitmentPageUrl)
      : undefined;
  const inspectionNote = inspectionCopy(result);
  const evidenceDetails = evidence
    ? [
        evidence.sourceLabel ? `Source : ${evidence.sourceLabel}` : undefined,
      evidence.directEmployer === false ? "Lien tiers à vérifier" : undefined,
        formatEvidenceDate(evidence.publishedAt)
          ? `publiée le ${formatEvidenceDate(evidence.publishedAt)}`
          : undefined,
        formatEvidenceDate(evidence.validThrough)
          ? `valable jusqu’au ${formatEvidenceDate(evidence.validThrough)}`
          : undefined,
        formatEvidenceDate(evidence.retrievedAt)
          ? `consultée le ${formatEvidenceDate(evidence.retrievedAt)}`
          : undefined,
        evidence.locationText ? `lieu : ${evidence.locationText}` : undefined,
      ].filter((value): value is string => Boolean(value))
    : [];
  const checkedAt = result.siteInspection.checkedAt
    ? new Intl.DateTimeFormat("fr-FR", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(result.siteInspection.checkedAt))
    : undefined;
  const directEvidenceAction =
    result.opportunityLevel !== "prospecting" &&
    evidenceUrl &&
    (evidence?.level === "public-offer" || evidence?.level === "recruitment-page")
      ? {
          href: evidenceUrl,
          label:
            evidence.level === "public-offer"
              ? "Consulter l’offre publiée"
              : "Consulter la page recrutement",
        }
      : undefined;
  const primaryAction =
    directEvidenceAction ??
    (recruitmentUrl
      ? { href: recruitmentUrl, label: "Consulter la page recrutement" }
      : websiteUrl
        ? { href: websiteUrl, label: "Explorer le site de l’entreprise" }
        : mapsUrl
          ? {
              href: mapsUrl,
              label:
                result.opportunityLevel === "prospecting"
                  ? "Préparer une visite"
                  : "Voir sur Google Maps",
            }
          : undefined);
  const secondaryActions = [
    websiteUrl && websiteUrl !== primaryAction?.href
      ? { href: websiteUrl, label: "Site de l’entreprise" }
      : undefined,
    mapsUrl && mapsUrl !== primaryAction?.href
      ? { href: mapsUrl, label: "Voir sur Google Maps" }
      : undefined,
  ].filter((action): action is { href: string; label: string } => Boolean(action));

  const scoreParts = [
    ["Signal d’opportunité", result.score.opportunity],
    [usesCvProfile ? "Affinité métier et secteur" : "Affinité BTS MCO", result.score.btsMcoFit],
    [usesCvProfile ? "Compétences du CV" : "CV non utilisé", result.score.cvFit],
    ["Proximité et trajet", result.score.commute],
  ] as const;

  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={`result-card${selected ? " is-selected" : ""}`}
      id={`result-${result.id}`}
      onFocus={() => onSelect(result.id)}
      onMouseEnter={() => onSelect(result.id)}
      role="listitem"
      tabIndex={0}
    >
      <div className="result-card__topline">
        <span className={`opportunity-tag opportunity-tag--${result.opportunityLevel}`}>
          <span className="opportunity-tag__dot" />
          {opportunity.label}
        </span>
        <span className="result-card__tools">
          <span className="result-rank">Piste {rank}</span>
          <button
            aria-label={favorite ? `Retirer ${result.name} des favoris` : `Ajouter ${result.name} aux favoris`}
            aria-pressed={favorite}
            className={`favorite-button${favorite ? " is-favorite" : ""}`}
            onClick={() => onToggleFavorite(result.id)}
            type="button"
          >
            <HeartIcon />
          </button>
        </span>
      </div>

      <div className="result-card__heading">
        <div>
          <p className="result-category">{result.category}</p>
          <h3>{result.name}</h3>
          <p className="result-address">{result.address}</p>
        </div>
        <div
          className="match-score"
          aria-label={`Score de classement : ${result.score.total} points`}
          role="group"
        >
          <small>Correspondance</small>
          <span className="match-score__value">
            <strong>{result.score.total}</strong>
            <span>pts</span>
          </span>
        </div>
      </div>

      <div className="result-facts">
        <span title="Distance directe depuis le point de départ">
          {result.distanceKm.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km
        </span>
        {typeof result.rating === "number" && (
          <span>
            <span aria-hidden="true" className="star">★</span>{" "}
            {result.rating.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}
            {typeof result.reviewCount === "number" && (
              <span className="muted"> ({result.reviewCount.toLocaleString("fr-FR")} avis)</span>
            )}
          </span>
        )}
      </div>

      <div className="travel-row" aria-label="Temps de trajet estimés" role="group">
        {travelModes.map((mode) => {
          const estimate = result.travel[mode];
          const modeCopy = MODE_COPY[mode];

          if (!estimate) return null;
          const available = estimate.status === "available" && estimate.durationMinutes > 0;

          return (
            <span className={`travel-chip${available ? "" : " is-unavailable"}`} key={mode}>
              <span className="travel-chip__icon">{modeCopy.icon}</span>
              <span>
                <small>{modeCopy.label}</small>
                <strong>{available ? formatDuration(estimate.durationMinutes) : "Indisponible"}</strong>
              </span>
            </span>
          );
        })}
        {!travelModes.some((mode) => Boolean(result.travel[mode])) && (
          <span className="travel-empty">Temps de trajet indisponibles</span>
        )}
      </div>

      <section
        className={`application-potential application-potential--${result.applicationPotential.level}`}
        aria-label={`Potentiel de candidature : ${potential.label}`}
      >
        <div className="application-potential__heading">
          <div>
            <span>Potentiel de candidature</span>
            <strong>{potential.label}</strong>
          </div>
          <span className="application-potential__score">
            <strong>{result.applicationPotential.score}</strong>/100
          </span>
        </div>
        <p className="application-potential__disclaimer">
          Indice de priorité, pas une prévision d’embauche.
        </p>
        <div className="application-potential__meta">
          <span
            className={`website-status website-status--${result.applicationPotential.websiteStatus}`}
          >
            <span aria-hidden="true" />
            {websiteStatusLabel(result)}
          </span>
          <span>
            Confiance des données : {POTENTIAL_CONFIDENCE_COPY[result.applicationPotential.confidence]}
          </span>
        </div>
        {result.applicationPotential.reasons.length > 0 && (
          <ul className="application-potential__reasons">
            {result.applicationPotential.reasons.slice(0, 2).map((reason, index) => (
              <li key={`${reason}-${index}`}>{reason}</li>
            ))}
          </ul>
        )}
        <div className="application-potential__action">
          <strong>Action conseillée</strong>
          <p>{result.applicationPotential.recommendedAction}</p>
        </div>
      </section>

      <section className="evidence-box" aria-label="Vérification des signaux publics sur le web">
        <div className="evidence-box__label">
          <span>Signal public</span>
          {result.siteInspection.status === "checked" && (
            <small>
              {result.siteInspection.pagesChecked} page{result.siteInspection.pagesChecked > 1 ? "s" : ""} consultée{result.siteInspection.pagesChecked > 1 ? "s" : ""}
            </small>
          )}
        </div>
        <p className="evidence-box__meaning">{publicSignalMeaning(result)}</p>
        {evidence ? (
          <div className="evidence-item">
            {evidenceUrl ? (
              <a href={evidenceUrl} rel="noopener noreferrer" target="_blank">
                {evidence.title}
                <ExternalIcon />
              </a>
            ) : (
              <strong>{evidence.title}</strong>
            )}
            {evidence.excerpt && <p>«&nbsp;{evidence.excerpt}&nbsp;»</p>}
            {evidenceDetails.length > 0 && (
              <small className="evidence-provenance">
                {evidenceDetails.join(" · ")}
              </small>
            )}
          </div>
        ) : inspectionNote ? (
          <p className="evidence-note">{inspectionNote}</p>
        ) : null}
        {recruitmentUrl && recruitmentUrl !== evidenceUrl && (
          <a className="evidence-link" href={recruitmentUrl} rel="noopener noreferrer" target="_blank">
            Consulter la page recrutement
            <ExternalIcon />
          </a>
        )}
        {additionalPublicOffers.length > 0 && (
          <details className="evidence-more">
            <summary>
              {additionalPublicOffers.length} autre{additionalPublicOffers.length > 1 ? "s" : ""} offre{additionalPublicOffers.length > 1 ? "s" : ""} pour cette entreprise
            </summary>
            <ul>
              {additionalPublicOffers.map((item) => {
                const itemUrl = safePublicHttpUrl(item.url);
                return (
                  <li key={`${item.url}-${item.title}`}>
                    {itemUrl ? (
                      <a href={itemUrl} rel="noopener noreferrer" target="_blank">
                        {item.title}
                        <ExternalIcon />
                      </a>
                    ) : (
                      <strong>{item.title}</strong>
                    )}
                    {item.sourceLabel && <small>{item.sourceLabel}</small>}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        {checkedAt && <small className="checked-at">Vérifié le {checkedAt}</small>}
      </section>

      {result.reasons.length > 0 && (
        <div className="reason-pills" aria-label="Points de correspondance" role="group">
          {result.reasons.slice(0, 3).map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
      )}

      {result.caution && <p className="result-caution">À vérifier : {result.caution}</p>}

      <details className="score-details">
        <summary>Comprendre le score</summary>
        <div className="score-details__body">
          <p>Indice de tri construit à partir des signaux disponibles. Il ne prédit pas un recrutement.</p>
          <dl>
            {scoreParts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value} pt{value > 1 ? "s" : ""}</dd>
              </div>
            ))}
            <div className="score-total">
              <dt>Total</dt>
              <dd>{result.score.total} pts</dd>
            </div>
          </dl>
        </div>
      </details>

      <div className="result-actions">
        {primaryAction && (
          <a className="button-link button-link--primary" href={primaryAction.href} rel="noopener noreferrer" target="_blank">
            {primaryAction.label}
            <ArrowIcon />
          </a>
        )}
        {secondaryActions.map((action) => (
          <a className="button-link" href={action.href} key={action.href} rel="noopener noreferrer" target="_blank">
            {action.label}
            <ExternalIcon />
          </a>
        ))}
      </div>
    </article>
  );
}

