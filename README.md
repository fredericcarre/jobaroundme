# JobAroundMe

JobAroundMe est une application de recherche locale d’alternance présentée comme une recherche de logement : une liste de fiches reste synchronisée avec une carte. Le parcours recommandé commence par le CV afin d’adapter la recherche au profil professionnel réel du candidat. Le **BTS Management commercial opérationnel (MCO)** reste le profil de référence lorsque le CV n’est pas fourni ou ne permet pas d’identifier une cible assez fiable.

Après l’import d’un PDF ou d’un fichier texte, l’application présente le profil professionnel qu’elle a extrait. Le candidat indique ensuite une adresse ou utilise ponctuellement la position du navigateur. JobAroundMe suggère des employeurs dans le rayon choisi, calcule les trajets disponibles, contrôle les sites publics connus dans la limite du budget de recherche et explique le classement. Chaque commerce retenu est évalué, même lorsqu’aucun site ou aucune annonce n’a été trouvé.

Une fiche sépare toujours la preuve publique de recrutement du potentiel de candidature :

- **Offre publiée** : l’employeur, l’alternance, le lieu et la fraîcheur sont étayés par le site de l’employeur, son ATS relié ou un service public identifié.
- **Page recrutement trouvée** : l’entreprise recrute publiquement, mais aucune offre locale compatible n’a été confirmée.
- **Employeur à prospecter** : aucune offre locale compatible n’a été confirmée; il s’agit d’une piste de candidature spontanée, pas d’une annonce.

Le **potentiel de candidature** — Fort, Moyen, Faible ou À qualifier — est un indice explicable de priorité. Il tient compte de l’adéquation du commerce au profil, des signaux publics disponibles et des informations locales connues. Il ne représente jamais une probabilité statistique d’embauche. La fiche donne les raisons du niveau et une action adaptée : candidater à l’offre, ouvrir la page recrutement, vérifier le site, appeler ou se présenter avec un CV.

## Lancer l’application

Prérequis : Node.js 24 ou version ultérieure.

```bash
npm ci
npm run dev
```

Ouvrez ensuite `http://localhost:3000`. Sans clé Google, l’application démarre en mode démonstration avec des entreprises entièrement fictives. Ce mode exerce l’import et l’analyse du CV, le formulaire, la carte schématique, les trajets et le classement sans appel payant ni donnée réelle.

Commandes de validation :

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Le point de contrôle `GET /api/health` indique si la recherche live, la carte Google et le scan de sites sont configurés, sans révéler les clés.

## Déployer sur Railway

Railway convient au fonctionnement serveur de JobAroundMe : l’application reste un processus Node.js, peut isoler la lecture des PDF dans un sous-processus et dispose du temps nécessaire pour interroger les fournisseurs et les sites employeurs. Le fichier `railway.json` fournit déjà les commandes de build, de démarrage et le contrôle de santé.

1. Poussez ce dépôt sur GitHub, créez un projet Railway depuis ce dépôt et choisissez la région d’Amsterdam.
2. Pour un essai familial, commencez avec le plan Free, un seul replica et le mode Serverless activé afin que le service s’arrête lorsqu’il n’est pas utilisé. Le premier accès après une veille peut demander un rechargement. Si les 512 Mo du plan Free ou ses crédits d’usage deviennent insuffisants, passez au plan Hobby sans modifier l’application.
3. Ajoutez `RAILPACK_NODE_VERSION=24` et `RAILPACK_DEPLOY_APT_PACKAGES=util-linux` afin d’utiliser Node.js 24 et d’activer les limites noyau du lecteur PDF.
4. Ajoutez les variables de `.env.example`. Les trois identifiants à fournir sont `GOOGLE_MAPS_SERVER_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY` et `LBA_API_KEY`. Sur l’instance Free de 512 Mo, utilisez d’abord `SEARCH_MAX_CONCURRENT_SEARCHES=2`; la valeur 6 convient mieux à une instance disposant d’au moins 1 Gio. Ne placez jamais les identifiants dans le dépôt.
5. Laissez `TRUSTED_CLIENT_IP_HEADER` non défini tant que le proxy d’entrée n’a pas été vérifié comme supprimant puis remplaçant cet en-tête.
6. Déployez, puis vérifiez `/api/health`. Une modification de la clé navigateur Google doit déclencher un nouveau build complet.

Railway fournit un sous-domaine `up.railway.app` et TLS. Un domaine personnel reste facultatif et s’achète séparément. Configurez une limite de dépense dans Railway avant d’ouvrir le service au public.

Railway et Google Cloud suivent deux consommations séparées. Le plan Railway Free peut suffire à un usage familial occasionnel avec mise en veille; son crédit et ses limites ne garantissent pas un service gratuit en continu. Google demande un compte de facturation pour les API Maps utilisées ici; les tarifs, paliers et éventuels crédits pouvant évoluer, vérifiez les pages tarifaires et le calculateur officiels au moment du déploiement. Les quotas de l’application bornent les appels, mais ne garantissent pas la gratuité d’un usage réel.

## Activer Google Maps

Créez deux clés distinctes dans un projet Google Cloud avec facturation et quotas :

1. `GOOGLE_MAPS_SERVER_API_KEY` pour **Places API (New)**, **Routes API** et **Geocoding API**. Cette clé reste côté serveur et doit être restreinte aux API nécessaires ainsi qu’aux adresses IP de l’hébergement lorsque c’est possible.
2. `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY` pour **Maps JavaScript API**. Elle est publique par conception et doit être restreinte aux référents HTTP du site et à cette seule API.

Copiez `.env.example` vers `.env.local` et ajoutez les valeurs avant `npm run build`. En production, reconstruisez puis redémarrez le serveur après toute modification de `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY`, car Next.js injecte cette variable dans le code navigateur au moment du build. Ne réutilisez pas la clé serveur dans une variable `NEXT_PUBLIC_*`.

Le rayon accepté va de 1 à 50 km. L’application interroge trois familles bornées de commerces, services et établissements d’accueil, puis ajoute avec un CV une recherche sectorielle ciblée, soit au plus 80 suggestions avant déduplication. Elle retient ensuite au plus 40 entreprises avant les appels par destination. Places Nearby Search ne fournit pas un recensement exhaustif : des commerces réels peuvent manquer et l’association d’un site à un établissement peut être absente ou obsolète. Routes Matrix calcule chaque mode par lots de 25 destinations et peut facturer jusqu’à un élément par entreprise et par mode. Les champs Google demandés sont limités explicitement pour maîtriser coût et données.

Les trajets avec circulation et transports en commun sont évalués pour le prochain jour ouvré à 8 h 30, heure de Paris, afin de représenter un départ réaliste vers l’entreprise. Les temps restent des estimations à vérifier dans Google Maps.

Pour borner chaque recherche, `SEARCH_MAX_EMPLOYERS` limite à 40 par défaut le nombre d’entreprises envoyées à Routes Matrix, après avoir priorisé les offres publiques trouvées. Tous les commerces retenus reçoivent une évaluation de potentiel; le scanner contrôle les sites connus dans la limite distincte de `SITE_SCAN_LIMIT`. `SEARCH_MAX_CONCURRENT_SEARCHES` limite à 6 par défaut les recherches réelles simultanées par instance; une instance saturée répond `503` avec `Retry-After`. L’API accepte au plus 12 recherches par minute et par adresse client, puis répond `429` avec `Retry-After`. Les recherches sans profil identiques peuvent être réutilisées pendant 90 secondes pour le même client; toute recherche avec un profil CV contourne ce cache, et les réponses HTTP restent marquées `private, no-store`.

Définissez `TRUSTED_CLIENT_IP_HEADER` uniquement si la passerelle de confiance supprime toute valeur reçue du navigateur puis réécrit cet en-tête avec une seule adresse IP, par exemple `x-forwarded-for`. Les listes d’adresses, ports et valeurs invalides sont refusés. Sans cette configuration, les en-têtes d’adresse envoyés directement sont ignorés et les clients sans attribution partagent un quota commun; cela empêche de contourner la limite en faisant tourner ces en-têtes.

Ces protections vivent dans la mémoire du processus Node.js. Elles sont bornées et ne persistent pas, mais elles s’appliquent séparément sur chaque instance. Les nouvelles identités au-delà de la capacité partagent un même quota jusqu’à la fenêtre suivante, sans évincer les clients déjà suivis. Un déploiement horizontal doit donc ajouter un quota partagé au niveau de la passerelle ou de la plateforme.

## Activer La bonne alternance

Ajoutez un jeton de production `LBA_API_KEY`, créé depuis le [compte API Alternance](https://api.apprentissage.beta.gouv.fr/compte/profil), pour compléter les entreprises Google avec les offres et employeurs potentiels de La bonne alternance. La recherche utilise en priorité les codes ROME déterminés à partir du CV. En l’absence d’un profil exploitable, elle se replie sur les codes ROME du BTS MCO et le niveau de diplôme 5. Le jeton reste exclusivement côté serveur.

Les deux catégories restent distinctes : `jobs` alimente les offres publiées, tandis que `recruiters` devient « candidature spontanée ». Les résultats `is_delegated=true` sont exclus de la carte employeur, car l’identité et l’adresse publiques correspondent alors au CFA mandataire plutôt qu’au lieu de travail. Chaque offre conserve le partenaire d’origine et ses dates.

La documentation OpenAPI annonce la licence Etalab 2.0, tandis que les conditions propres à l’API limitent actuellement l’usage commercial. L’usage familial est compatible avec l’objectif présent; demandez une clarification écrite à `contact-api@labonnealternance.apprentissage.beta.gouv.fr` avant toute monétisation.

## Recherche guidée par le CV

Le CV est accepté au format PDF ou texte, dans la limite de 5 Mo et 10 pages. Son texte est analysé de façon locale et déterministe, sans service d’analyse de CV externe. L’application en extrait un profil structuré composé du diplôme, des rôles recherchés, des compétences, des secteurs, des mots-clés professionnels et des codes ROME. Chaque élément provient d’une expression explicite du CV ou d’un repli professionnel documenté, par exemple les débouchés associés à un BTS MCO mentionné dans le document.

Les codes ROME servent à interroger les sources qui les acceptent, notamment La bonne alternance. Les rôles, compétences, secteurs et mots-clés servent ensuite à mesurer l’affinité des offres et des entreprises, puis à expliquer leur classement. Si aucun CV n’est ajouté, ou si son contenu est trop ambigu, la recherche reste utilisable avec le profil BTS MCO par défaut.

Le fichier et son texte restent en mémoire serveur uniquement pendant l’analyse. La réponse renvoie au navigateur le profil professionnel borné, sans réexposer le texte intégral; seule cette structure sert ensuite à la recherche. Rien n’est enregistré dans une base de données ou un historique serveur. L’analyse exclut les caractéristiques personnelles ou sensibles : elle ne déduit notamment ni âge, ni sexe, ni origine, ni nationalité, ni état de santé à partir du contenu, du nom ou de la photo. Un PDF constitué d’images nécessite un OCR préalable. Demandez l’accord du titulaire avant d’utiliser le CV d’une autre personne.

Chaque PDF est décodé dans un processus Node.js neuf, limité à 128 Mio de vieux tas V8, puis arrêté avant de libérer le créneau d’analyse. Ce processus ne reçoit aucune variable ni aucun secret de l’application. Le modèle de permissions Node lui autorise uniquement la lecture de son script et du paquet `unpdf`; il lui interdit les écritures, les extensions natives, les sous-processus et les workers. Les API réseau publiques sont neutralisées avant le chargement du parseur. Sous Linux, lorsque `prlimit` d’util-linux est exécutable par le service, des limites noyau supplémentaires de 2 Gio d’espace d’adressage et 768 Mio de données bornent aussi les allocations externes et natives. Un `SIGKILL` interrompt le processus au délai maximal ou à l’annulation de la requête.

Deux limites dépendent de la plateforme d’hébergement. Si `prlimit` est absent ou interdit, le processus séparé et la limite V8 restent actifs, mais une allocation native n’est plus bornée par processus au niveau du noyau; le conteneur de production doit alors appliquer sa propre limite mémoire. Node ne propose pas de permission réseau portable au niveau des appels système : le processus désactive les interfaces réseau accessibles au parseur et ne reçoit ni proxy ni identifiants, tandis qu’une interdiction stricte de sortie doit être imposée par le réseau du conteneur ou de la plateforme.

En mode réel, le serveur transmet à Google l’adresse ou les coordonnées de départ, le rayon, les modes de transport et un petit ensemble de catégories professionnelles dérivées du profil. Si La bonne alternance est configurée, il lui transmet les coordonnées, le rayon, le niveau de diplôme et les codes ROME retenus. Le fichier et le texte du CV ne sont envoyés à aucun de ces fournisseurs. Une réponse de recherche sans profil peut rester jusqu’à 90 secondes dans le cache mémoire du processus; aucune recherche n’est écrite en base. Les identifiants des favoris sont conservés uniquement dans le stockage local du navigateur.

## Analyse des sites employeurs et prospection locale

Le scanner part du site public associé à l’établissement par Google Places ou La bonne alternance. Il ne lance pas une recherche arbitraire sur le Web et ne peut donc pas retrouver seul un site absent de ces sources. Il accepte HTTP/HTTPS sur les ports standards, refuse les adresses privées ou réservées, contrôle les redirections, limite temps/pages/taille, respecte `robots.txt` et recherche des liens recrutement ainsi que des données structurées `JobPosting`. Les sites rendus entièrement en JavaScript ou protégés peuvent rester invisibles. Il ne contourne ni connexion, ni CAPTCHA, ni refus d’accès.

`ENABLE_SITE_SCAN=false` désactive ce contrôle. `SITE_SCAN_LIMIT` fixe le nombre maximal de sites connus vérifiés par recherche, entre 1 et 40; la valeur par défaut est 40, soit tous les sites des entreprises retenues lorsque le budget maximal est conservé. Cette couverture reste bornée par la sélection Google/La bonne alternance et par `SEARCH_MAX_EMPLOYERS`.

La phase d’analyse dispose de 24 secondes : les contrôles terminés sont conservés et les sites restants sont marqués « non analysés » si ce délai est atteint, sans faire perdre toute la recherche. Une instance exécute au plus 16 inspections de sites à la fois, toutes recherches confondues, afin de rester stable sur un petit hébergement.

L’absence de site ou d’annonce ne supprime pas un commerce des résultats. L’application évalue alors l’intérêt d’une candidature spontanée à partir du type d’activité et des autres signaux disponibles, explique les éléments manquants et propose une vérification ou un contact direct. Un site introuvable ne prouve ni l’absence de recrutement, ni la capacité de l’établissement à accueillir un alternant.

## Scoring et potentiel de candidature

Le score de correspondance est déterministe et visible dans chaque fiche : présence d’une offre ou d’une page recrutement, correspondances avec le profil professionnel extrait du CV et temps de trajet. Lorsque le repli BTS MCO est utilisé, l’adéquation avec ses compétences et ses secteurs remplace le volet personnalisé.

Le potentiel de candidature constitue un axe distinct. Ses niveaux Fort, Moyen, Faible et À qualifier servent à ordonner la prospection et restent accompagnés de raisons vérifiables. Une offre réelle ou une page recrutement demeure affichée comme telle; un bon potentiel sans preuve de recrutement reste une candidature spontanée. L’indice ne mesure pas une probabilité d’embauche et ne doit pas être lu comme un pourcentage. Aucun critère sensible ou inféré (âge, photo, sexe, origine, santé, nationalité) n’entre dans les calculs.

## Architecture actuelle

- Next.js et TypeScript pour l’interface et les routes serveur;
- analyseur de CV déterministe produisant un profil professionnel structuré sans persistance;
- Google Geocoding, Places Nearby Search et Routes Matrix derrière un fournisseur isolé;
- API publique La bonne alternance optionnelle, avec séparation stricte des offres, candidatures spontanées et offres déléguées par un CFA;
- fournisseur de démonstration déterministe sans réseau;
- scanner HTML borné, évaluation de tous les commerces retenus et scoring explicable;
- aucune persistance serveur des recherches ou des CV, candidature automatique ou envoi de message; seuls les identifiants des favoris restent dans le navigateur.

L’architecture isole les fournisseurs afin d’ajouter d’autres sources officielles sans modifier le classement ni l’interface. L’inventaire de La bonne alternance contient déjà des offres France Travail; interroger 1jeune1solution en parallèle créerait des doublons et appauvrirait la provenance.

## Référentiel BTS MCO

Le profil utilise la fiche active **RNCP38362**, niveau 5, enregistrée jusqu’au 31 décembre 2028 : développement de la relation client et vente conseil; animation et dynamisation de l’offre commerciale; gestion opérationnelle; management de l’équipe commerciale.

- [France Compétences — RNCP38362](https://www.francecompetences.fr/recherche/rncp/38362/)
- [Export officiel RNCP sur data.gouv.fr](https://www.data.gouv.fr/datasets/repertoire-national-des-certifications-professionnelles-et-repertoire-specifique)
- [Onisep — BTS Management commercial opérationnel](https://www.onisep.fr/ressources/univers-formation/formations/post-bac/bts-management-commercial-operationnel)

## Limites à garder visibles

Les résultats Google et La bonne alternance sont bornés et ne constituent pas un recensement complet. L’application connaît un site seulement lorsque Google Places ou La bonne alternance le fournit; elle ne remplace pas un moteur de recherche général. Une fiche conserve le lien, la provenance, les dates disponibles et un extrait afin de permettre une dernière vérification avant de candidater. Une page sans date, un lieu imprécis, un employeur différent ou une source tierce non reliée reste « à vérifier » et n’obtient pas le badge d’offre publiée. Le potentiel de candidature aide à prioriser les démarches, mais seule l’entreprise peut confirmer qu’elle recrute et qu’elle peut accueillir un alternant.
