# Rues de Paris

Une web app (PWA) qui colorie toutes les rues de Paris que vous avez parcourues à pied, façon « explorateur de rues ».
Le suivi est **automatique** : l'app iOS gratuite **Overland** envoie vos positions à un petit serveur gratuit qui vous
appartient (un Worker Cloudflare + base D1). À chaque ouverture, l'app récupère les nouvelles positions, ne garde que
la marche, et allume les rues parcourues.

```
iPhone (Overland) ──POST GeoJSON──▶ Cloudflare Worker + D1 ◀──GET /points── Web app (GitHub Pages)
                                    (stocke vos positions)                  (calcul dans le navigateur)
```

- Carte plein écran : rues visitées en orange, entamées en orange pâle, jamais parcourues en gris.
- Statistiques : % de Paris parcouru (en longueur), % par arrondissement, km marchés, rues parcourues et complétées.
- Liste des rues visitées / jamais visitées avec recherche ; journal des marches par jour (touchez un jour pour voir la trace).
- Import GPX manuel en secours, export/restauration d'une sauvegarde JSON.
- Fonctionne hors ligne, installable sur l'écran d'accueil, mode sombre automatique.

---

## Sommaire

1. [Publier l'app sur GitHub Pages](#1-publier-lapp-sur-github-pages)
2. [Créer le serveur (Cloudflare Worker + D1)](#2-créer-le-serveur-cloudflare-worker--d1)
3. [Installer l'app sur l'iPhone](#3-installer-lapp-sur-liphone)
4. [Configurer Overland](#4-configurer-overland)
5. [Utilisation au quotidien](#5-utilisation-au-quotidien)
6. [Comment ça marche](#6-comment-ça-marche)
7. [Regénérer le fichier des rues](#7-regénérer-le-fichier-des-rues)
8. [Limites gratuites, confidentialité, dépannage](#8-limites-gratuites-confidentialité-dépannage)

---

## 1. Publier l'app sur GitHub Pages

1. Sur GitHub, créez un dépôt **public**, par exemple `rues-de-paris`.
2. Envoyez-y le contenu de ce dossier (le fichier `index.html` doit être à la racine du dépôt) :
   ```bash
   git init && git add . && git commit -m "Rues de Paris"
   git branch -M main
   git remote add origin https://github.com/VOTRE_COMPTE/rues-de-paris.git
   git push -u origin main
   ```
   Sans terminal : sur la page du dépôt, **Add file → Upload files**, glissez tous les fichiers et dossiers, puis **Commit changes**.
3. Dans le dépôt : **Settings → Pages → Build and deployment → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`, **Save**.
4. Après une minute, l'app est en ligne sur `https://VOTRE_COMPTE.github.io/rues-de-paris/`.

> Le jeton secret n'est **jamais** dans le dépôt : il est saisi dans l'app et stocké uniquement sur votre téléphone.

---

## 2. Créer le serveur (Cloudflare Worker + D1)

Tout est gratuit et se fait depuis le navigateur, sans rien installer (≈ 5 minutes).

### a. Compte
Créez un compte sur [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (aucune carte bancaire n'est demandée pour l'offre gratuite).

### b. Base de données D1
1. Menu **Storage & Databases → D1 SQL Database → Create**.
2. Nom : `rues-de-paris` → **Create**.
3. Ouvrez la base, onglet **Console**, collez le contenu de [`worker/schema.sql`](worker/schema.sql) et cliquez **Execute**.

### c. Worker
1. Menu **Compute (Workers) → Workers & Pages → Create → Create Worker** (modèle « Hello World »).
2. Nom : `rues-de-paris` → **Deploy**.
3. Cliquez **Edit code**, remplacez tout le code par celui de [`worker/src/index.js`](worker/src/index.js), puis **Deploy**.

### d. Relier la base au Worker
Dans le Worker : **Settings → Bindings → Add → D1 database**
- Variable name : `DB` (en majuscules, exactement)
- D1 database : `rues-de-paris` → **Add binding** (ou **Deploy**).

### e. Choisir le jeton secret
Dans le Worker : **Settings → Variables and Secrets → Add**
- Type : **Secret**, Name : `TOKEN`
- Value : une longue suite aléatoire, par exemple générée avec `openssl rand -hex 24` dans un terminal Mac, ou un mot de passe de 30+ caractères de votre gestionnaire de mots de passe (lettres et chiffres seulement, c'est plus simple à copier). **Gardez-le** : vous le saisirez dans l'app et dans Overland.
- **Deploy**.

Facultatif, au même endroit (type **Text**) :
| Nom | Valeur conseillée | Rôle |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://VOTRE_COMPTE.github.io` | Seule votre app peut interroger le serveur depuis un navigateur |
| `MAX_ACCURACY_M` | `60` | Pré-filtre : points plus imprécis non stockés |
| `MAX_SPEED_KMH` | `15` | Pré-filtre : trajets en voiture/métro non stockés |

### f. Vérifier
L'adresse du Worker s'affiche en haut de sa page, du type `https://rues-de-paris.VOTRE-SOUS-DOMAINE.workers.dev`.
Ouvrez dans le navigateur :
```
https://rues-de-paris.VOTRE-SOUS-DOMAINE.workers.dev/status?token=VOTRE_JETON
```
Vous devez voir `{"ok":true,"points":0,"last":null}`.

<details>
<summary>Variante en ligne de commande (wrangler)</summary>

```bash
cd worker
npx wrangler login
npx wrangler d1 create rues-de-paris          # copiez l'identifiant affiché dans wrangler.toml (database_id)
npx wrangler d1 execute rues-de-paris --remote --file=schema.sql
npx wrangler secret put TOKEN                  # collez votre jeton
npx wrangler deploy
```
</details>

### API du Worker

Toutes les routes exigent le jeton (`Authorization: Bearer <jeton>` ou `?token=<jeton>`).

| Route | Rôle |
|---|---|
| `POST /overland` (ou tout chemin en POST) | Reçoit les lots d'Overland (`{"locations":[Feature GeoJSON…]}`), répond `{"result":"ok"}` |
| `GET /points?since=<id>&limit=5000` | Points stockés après le curseur : `{"points":[[id, ts, lat, lon, précision, vitesse, activité]], "next", "more"}` |
| `GET /status` | Test de connexion : nombre de points et date du dernier |

Le dédoublonnage est assuré par un index unique (appareil, horodatage).

---

## 3. Installer l'app sur l'iPhone

1. Ouvrez `https://VOTRE_COMPTE.github.io/rues-de-paris/` dans **Safari**.
2. Touchez **Partager** puis **« Sur l'écran d'accueil »** → **Ajouter**.
3. Ouvrez **Rues de Paris** depuis l'icône : le guide de démarrage s'affiche.
4. À l'étape 2, collez l'adresse du Worker et le jeton, touchez **Tester la connexion**.
5. L'étape 3 affiche l'adresse à coller dans Overland (bouton **Copier**).

> Sur iPhone, l'app installée a son propre stockage, distinct de Safari : faites la configuration depuis l'icône de l'écran d'accueil.

---

## 4. Configurer Overland

1. Installez [Overland GPS Tracker](https://apps.apple.com/app/overland-gps-tracker/id1292426766) (gratuit).
2. **Settings → Receiver Endpoint** : collez l'adresse copiée depuis l'app, de la forme
   `https://rues-de-paris.xxx.workers.dev/overland?token=VOTRE_JETON`
3. Autorisez la localisation **« Toujours »** et l'accès **Mouvements et forme** (activité physique) quand iOS le demande.
   L'activité (`walking`, `driving`…) sert à écarter les trajets motorisés.
4. Réglages conseillés, précis à pied sans vider la batterie :

| Réglage Overland | Valeur | Pourquoi |
|---|---|---|
| Tracking Enabled | **On** | Le rond « Slide to unlock » se glisse vers la droite pour débloquer les réglages |
| Continuous Tracking Mode | **Both** | iOS relance Overland dès que vous bougez |
| Desired Accuracy | **10m** | Indispensable : à 100 m, les points sont trop imprécis et ignorés |
| Activity Type | **Fitness** | Indique à iOS un déplacement à pied |
| Pause Updates Automatically | **No** | Le plus fiable pour ne rater aucune marche |
| Logging Mode | **All Data** | |
| Locations per Batch | **200** | Moins de requêtes réseau |
| Min Time Between Points | **5s** | Un point toutes les 5 s suffit (l'app densifie entre les points) |
| Enable notifications | **On** | Prévient si le suivi s'arrête |
| Send Interval (onglet Tracker) | **5m** | Envoi groupé : économise la batterie et le réseau |

Location Authorization Status doit afficher **Always** : sinon touchez *Request Permission*, puis dans
Réglages iOS → Overland → Position choisissez **Toujours** et **Position exacte**.

Les libellés peuvent légèrement varier selon la version d'Overland ; l'esprit reste : précision ~10 m, pause automatique,
envoi groupé. Sur une journée de marche, comptez environ 5 à 10 % de batterie.

Pour vérifier : faites quelques pas, touchez **Send now** dans Overland (s'il est proposé), puis ouvrez
`…/status?token=…` : le nombre de points augmente.

---

## 5. Utilisation au quotidien

- **Rien à faire** : ouvrez l'app de temps en temps, elle se synchronise seule (et à chaque retour au premier plan).
- Le bouton de synchro en haut à droite force une mise à jour.
- **Stats** : touchez un arrondissement pour le centrer sur la carte.
- **Rues** : recherche sans accents ni majuscules ; touchez une rue pour la voir en bleu sur la carte.
- **Journal** : touchez un jour pour afficher la trace de la marche.
- **Réglages** :
  - *Importer des fichiers GPX* (Strava, Garmin…) : les traces doivent contenir l'heure des points.
  - *Exporter une sauvegarde* : fichier JSON avec toutes vos positions (sans le jeton). *Restaurer* le réimporte sur un autre appareil et recalcule tout.
  - *Recalculer toutes les rues* : refait la correspondance depuis toutes les positions stockées.

---

## 6. Comment ça marche

**Filtrage** (`js/core.js`)
- précision horizontale > 30 m → ignoré ;
- activité `driving` / `automotive` / `cycling` → ignoré ;
- vitesse ≥ 7 km/h (vitesse mesurée par le GPS, ou calculée entre deux points précis) → ignoré ;
- doublons : un seul point par horodatage (index IndexedDB) et par appareil+horodatage (index D1).

**Correspondance** (`js/match.worker.js`, dans un Web Worker)
- les rues sont projetées en mètres et indexées dans une grille de 50 m ;
- deux points successifs d'une même marche (≤ 3 min et ≤ 300 m d'écart) sont reliés et **densifiés tous les 5 m** ;
- chaque échantillon est rattaché au **tronçon le plus proche à moins de 20 m**, en favorisant les tronçons orientés
  comme la marche (évite d'allumer les rues transversales aux carrefours) ; la chaussée parallèle de même nom
  (boulevards à deux voies) est aussi comptée ;
- chaque tronçon est découpé en cases d'environ 10 m ; il est **« visité » quand 60 % de sa longueur** est couverte ;
- une rue est « complétée » quand 60 % de sa longueur totale est dans des tronçons visités.

**Stockage local** : IndexedDB (positions, couverture des tronçons, journal, réglages). Le fichier des rues et l'app
sont mis en cache par le service worker pour un usage hors ligne.

**Fichiers**
```
index.html, css/, js/          l'app (aucune étape de build)
  js/app.js                    interface, carte MapLibre, synchro, import/export
  js/match.worker.js           correspondance et statistiques (Web Worker)
  js/core.js                   règles de filtrage partagées
  js/db.js                     IndexedDB
data/streets.json.gz           rues de Paris (OSM), découpées en tronçons
scripts/build_streets.py       génération du fichier des rues
worker/                        serveur Cloudflare (code, schéma D1, wrangler.toml)
sw.js, manifest.webmanifest    PWA
```

---

## 7. Regénérer le fichier des rues

Le fichier `data/streets.json.gz` (~0,5 Mo, ~36 000 tronçons, ~6 000 rues) est déjà inclus. Pour le mettre à jour
depuis OpenStreetMap (Python 3, sans dépendance) :

```bash
python3 scripts/build_streets.py
```

Options : `--avec-bois` pour inclure les bois de Boulogne et de Vincennes (exclus par défaut), `--brut fichier.json`
pour garder la réponse Overpass, `--entree fichier.json` pour la réutiliser sans retélécharger.

Le script interroge l'API Overpass : voies nommées de type `primary` à `residential`, `living_street`, `pedestrian`,
`footway`, `path`, `steps`, `service`… dans la commune de Paris, hors tunnels, trottoirs (`footway=sidewalk`),
passages piétons, accès privés et parkings. Chaque voie est coupée aux intersections puis en morceaux de 200 m au plus ;
l'arrondissement vient des limites administratives OSM (`admin_level=9`).

Si Overpass est saturé, le script réessaie automatiquement ; sinon relancez-le plus tard.
Quand le fichier change, l'app détecte la nouvelle version et recalcule tout à partir des positions déjà stockées.
Pensez à incrémenter `VERSION` dans `sw.js` à chaque mise à jour du site.

---

## 8. Limites gratuites, confidentialité, dépannage

**Offre gratuite Cloudflare** : 100 000 requêtes Worker par jour, D1 5 Go et 100 000 lignes écrites par jour.
Avec les réglages conseillés (un envoi toutes les 5 min, pré-filtre côté serveur), l'usage d'une personne reste très
loin de ces limites.

**Confidentialité** : vos positions ne vont que sur votre propre Worker et sur votre téléphone. Le jeton est stocké
localement dans l'app (IndexedDB), jamais dans le dépôt. Le fond de carte est chargé depuis CARTO ; aucune position
ne lui est envoyée. Pour changer de jeton : modifiez le secret `TOKEN` du Worker, puis l'adresse dans Overland et dans
les Réglages de l'app.

**Dépannage**
| Symptôme | Piste |
|---|---|
| « Jeton refusé » | Le jeton saisi diffère du secret `TOKEN` du Worker (espaces, majuscules) |
| « Serveur injoignable » | Adresse du Worker incorrecte (elle doit commencer par `https://`) ou pas de réseau |
| `Base D1 non liée` | Le binding doit s'appeler exactement `DB` |
| Aucun point reçu | Dans Overland, vérifiez Tracking = On, la localisation « Toujours », et l'adresse (avec `/overland?token=`) |
| Une rue parcourue reste grise | Le tronçon n'est couvert qu'en partie (< 60 %), ou la marche dépassait 7 km/h, ou le GPS était imprécis (> 30 m) |
| Les données ont disparu de l'iPhone | Restaurez la dernière sauvegarde, ou effacez les données de l'app : la synchro recharge tout depuis le serveur |

Données cartographiques © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), fond de carte © [CARTO](https://carto.com/attributions).
