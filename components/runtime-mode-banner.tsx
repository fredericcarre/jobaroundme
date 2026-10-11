import styles from "./runtime-mode-banner.module.css";

interface RuntimeModeBannerProps {
  liveSearchConfigured: boolean;
  laBonneAlternanceConfigured: boolean;
  siteScanEnabled: boolean;
}

export function RuntimeModeBanner({
  liveSearchConfigured,
  laBonneAlternanceConfigured,
  siteScanEnabled,
}: RuntimeModeBannerProps) {
  if (!liveSearchConfigured) {
    return (
      <aside
        aria-label="État des sources de recherche"
        className={`${styles.banner} ${styles.demo}`}
        data-search-mode="demo"
        role="status"
      >
        <span className={styles.label}>
          <span aria-hidden="true" className={styles.dot} />
          Mode démonstration
        </span>
        <p>
          <strong>Aucune entreprise ni offre réelle n’est interrogée.</strong>{" "}
          Les fiches affichées sont fictives. L’administrateur doit activer Google Maps
          pour lancer une recherche réelle.
        </p>
      </aside>
    );
  }

  return (
    <aside
      aria-label="État des sources de recherche"
      className={`${styles.banner} ${styles.live}`}
      data-search-mode="live"
      role="status"
    >
      <span className={styles.label}>
        <span aria-hidden="true" className={styles.dot} />
        Mode réel configuré
      </span>
      <p>
        Les établissements et trajets seront recherchés avec Google Maps.
        {siteScanEnabled
          ? " L’application tentera ensuite de vérifier une sélection de sites publics d’employeurs."
          : " La vérification des sites employeurs est désactivée sur ce serveur."}
        {laBonneAlternanceConfigured
          ? " La Bonne Alternance est configurée et pourra être consultée selon le profil."
          : " La Bonne Alternance n’est pas configurée sur ce serveur."}
      </p>
    </aside>
  );
}
