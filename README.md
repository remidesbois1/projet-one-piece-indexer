# Projet Poneglyph

Poneglyph est un projet de recherche et d’ingénierie consacré à l’indexation de mangas à l’échelle de la page et de la bulle. Le dépôt réunit l’application web, l’API, l’application de bureau et les pipelines nécessaires pour détecter les cases et les bulles, reconstruire l’ordre de lecture, transcrire le texte, valider les annotations et interroger le corpus.

L’instance publique sert de démonstration technique. Les images qui y sont accessibles sont fortement floutées en dehors des zones de texte ; l’interface n’est pas conçue pour remplacer la consultation de l’œuvre originale.

[Application](https://poneglyph.fr) · [Sandbox OCR](https://poneglyph.fr/sandbox) · [API v2](https://api.poneglyph.fr/v2) · [Contrat OpenAPI](https://api.poneglyph.fr/openapi.json)

## Périmètre

Poneglyph prend en charge les opérations suivantes :

- organisation des contenus par série, volume, chapitre, page et bulle ;
- import de chapitres, annotation, validation, modération et reprise des traitements interrompus ;
- détection des cases et des bulles, puis reconstruction de leur ordre de lecture ;
- OCR dans le navigateur, sur une machine locale ou au moyen de services distants configurables ;
- recherche textuelle, sémantique et par correspondance OCR d’une image ;
- exposition en lecture seule des données validées par une API publique ;
- export des jeux de données, entraînement, évaluation et publication versionnée des modèles.

Le logiciel peut gérer plusieurs séries. Les résultats publiés dans ce README portent toutefois uniquement sur les jeux de test et les protocoles indiqués dans le registre des modèles ; ils ne permettent pas d’extrapoler les performances à d’autres corpus ou mises en page.

## Architecture

| Répertoire | Responsabilité | Technologies principales |
| --- | --- | --- |
| `frontend/` | Interface web, recherche, annotation et inférence dans le navigateur | Next.js, React, Supabase, ONNX Runtime Web |
| `backend/` | API applicative et publique, imports, stockage, recherche et modération | Node.js, Express, Supabase, PostgreSQL, stockage objet R2 compatible S3 |
| `frontend/src-tauri/` | Application Windows et séparation entre l’interface distante et les commandes locales | Tauri 2, Rust |
| `desktop_backend/` | Serveur OCR local lancé et supervisé par Tauri | FastAPI, PyTorch, Transformers |
| `docker_scripts/` | Export des données, entraînement, évaluation et publication des modèles | Python, Docker, Modal |
| `shared/` et `scripts/` | Registre des modèles, limites communes et génération des documents | JSON, Node.js |
| `docs/` et `documentation/` | Protocoles, expériences, confidentialité et résultats générés | Markdown |

### Structure du projet

```
projet-poneglyph/
├── backend/                    # API Node.js / Express
├── desktop_backend/            # Backend Python OCR local (FastAPI)
├── docker_scripts/             # Scripts MLOps (fine-tuning)
├── documentation/              # Documentation technique
├── frontend/                   # Interface web Next.js et shell Tauri v2
├── shared/ et scripts/         # Registre des modèles et scripts d'utilitaires
└── README.md
```

La chaîne de traitement principale est la suivante :

```text
page
  -> détection des cases et des bulles
  -> reconstruction de l’ordre de lecture
  -> transcription OCR
  -> correction ou validation humaine
  -> indexation textuelle et vectorielle
  -> recherche et API
```

### Exécution des modèles

| Environnement | Usage | Exécution |
| --- | --- | --- |
| Navigateur | Détection, ordre de lecture et OCR de bulles isolées | Workers dédiés, modèles ONNX, WebGPU lorsque disponible et fallback WASM |
| Application de bureau | OCR de pages entières ou de bulles isolées | Tauri, serveur FastAPI local, PyTorch et accélération matérielle lorsqu’elle est disponible |
| Services distants | OCR de secours, embeddings et réordonnancement | Routes serveur soumises aux contrôles d’accès et aux quotas, fournisseurs configurés par variables d’environnement |

Dans le navigateur, la détection repose sur des modèles distincts pour les cases, les bulles et leur ordre. L’OCR local combine un détecteur de lignes avec un modèle de reconnaissance PP-OCRv6. L’application de bureau ajoute les variantes Poneglyph et Surya destinées aux pages entières et aux bulles isolées. Plus massifs mais potentiellement meilleurs.

## Recherche

| Mode | Fonctionnement |
| --- | --- |
| Textuel | Recherche dans les bulles validées et leurs métadonnées. |
| Sémantique | Recherche vectorielle au niveau de la page, avec fusion des résultats Voyage AI et Gemini. |
| Image | OCR de l’image fournie, sélection de pages candidates, puis classement selon le texte reconnu et sa disposition. |

## Benchmarks publiés

Les valeurs ci-dessous sont générées depuis `shared/model-registry.json`. Chaque résultat est rattaché à une révision de modèle, un jeu de données, un split, une date et un protocole. Deux valeurs ne doivent être comparées que lorsqu’elles décrivent la même tâche dans des conditions compatibles.

<details>
<summary>Afficher les résultats publiés</summary>

<!-- model-registry:start -->
> Tableau généré depuis `shared/model-registry.json` (registre v1, 2026-08-01). Les protocoles complets sont publiés dans [la fiche de provenance](documentation/generated/model-benchmarks.md).

| Modèle | Résultat publié | Dataset et split | Date et échantillons | Matériel | Version et preuve |
|---|---|---|---|---|---|
| PP-OCRv6 Bubble Line | CER 1,451 % · Exact match 75,96 % | Poneglyph validated bubbles reconstructed from detected text lines — test held-out by page | 2026-06-29 · 1 219 | Not recorded; offline scoring over pinned predictions | [10b932d4aadc](https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/tree/10b932d4aadca2830850ccf5951116597404bef8) · [source](https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec/blob/10b932d4aadca2830850ccf5951116597404bef8/postprocess_official_metrics.json) |
| LightOnOCR Poneglyph | CER 0,424 % · WER 1,405 % · Exact match 92,55 % | Poneglyph validated single-bubble crops — test held-out by page | 2026-07-01 · 1 128 | Modal NVIDIA H100 | [3d5181ce138e](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/tree/3d5181ce138e7d92132a741f1e54c3a9e602e129) · [source](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph/blob/3d5181ce138e7d92132a741f1e54c3a9e602e129/benchmark_test.json) |
| Surya OCR 2 Poneglyph | CER 0,451 % · WER 1,656 % · Exact match 90,65 % · Token limit 0,00 % | Poneglyph validated single-bubble crops — test held-out by page | 2026-07-30 · 1 423 | NVIDIA RTX 3090 24 GB | [7d7b358c545c](https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph/tree/7d7b358c545cfe757329f780da6ed4100bb5909f) · [source](https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph/blob/7d7b358c545cfe757329f780da6ed4100bb5909f/benchmark_test.json) |
| YoloPiece Panel Detector | mAP50 99,40 % · mAP50-95 98,61 % | Poneglyph panel annotation dataset — test held-out by page | 2026-07-02 · 31 | CUDA device 0; exact GPU model not recorded in the artifact | [c4d5393095fa](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/tree/c4d5393095fadacfedc49d81acb2a8ac29d23aad) · [source](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/panel_detector_metrics.json) |
| YoloPiece One-Shot Reading Order | Exact page 96,77 % · Bubble position accuracy 99,32 % · Global pairwise accuracy 99,93 % | Poneglyph panel and bubble reading-order annotations — test held-out by page | 2026-07-02 · 31 | CPU offline scoring; exact processor not recorded in the artifact | [c4d5393095fa](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/tree/c4d5393095fadacfedc49d81acb2a8ac29d23aad) · [source](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/c4d5393095fadacfedc49d81acb2a8ac29d23aad/metrics/reading_order_benchmark.json) |
<!-- model-registry:end -->

</details>

Le détail des protocoles et des artefacts est disponible dans [`documentation/generated/model-benchmarks.md`](documentation/generated/model-benchmarks.md). Le tableau ne doit pas être modifié manuellement.

## API publique

API Publique recommandée : `https://api.poneglyph.fr/v2`. Elle fournit un accès en lecture seule aux pages et aux bulles validées, dans le contexte explicite d’une série.

| Version | Statut | Base URL / Contrat |
| --- | --- | --- |
| **v2** | Stable, recommandée | `https://api.poneglyph.fr/v2` |
| **v1** | Dépréciée | Conservée pour compatibilité |

| Méthode | Route v2 | Description |
| --- | --- | --- |
| `GET` | `/series/{seriesSlug}/volumes/{volumeNumber}/chapters` | Liste paginée des chapitres d’un volume. |
| `GET` | `/series/{seriesSlug}/chapters/{chapterNumber}/pages/{pageNumber}` | Page et bulles validées d’un chapitre. |

Les collections utilisent les paramètres `page` et `page_size`. Le [contrat OpenAPI 3.1](https://api.poneglyph.fr/openapi.json) constitue la référence pour les paramètres, les schémas de réponse et les erreurs. Sa cohérence avec les routes publiques est vérifiée en intégration continue.

La version `v1` est conservée pour compatibilité, mais elle est dépréciée et ne doit pas être utilisée pour une nouvelle intégration. Les images renvoyées publiquement sont fortement floutées hors des zones de bulles de texte.

## Développement local

### Prérequis

- Node.js 22.14 ou une version ultérieure ;
- npm ;
- un projet Supabase compatible avec le schéma et les migrations de `backend/sql/` ;
- Python 3.10 ou une version ultérieure pour l’OCR local ;
- Rust pour l’application Tauri ;
- Windows et les outils nécessaires à NSIS pour produire l’installateur.

Le frontend et l’API peuvent être lancés sans compiler l’application de bureau. Les fonctions de stockage d’images nécessitent également un stockage objet compatible S3 ; la configuration de production utilise des buckets R2 séparés pour les pages privées et les ressources publiques.

### Configuration minimale

Créer `backend/.env` :

```env
PORT=3001
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PAGES_BUCKET_NAME=... # bucket privé, sans domaine public
R2_ENDPOINT=...
R2_PUBLIC_URL=... # réservé aux couvertures publiques
GOOGLE_API_KEY=...
VOYAGE_API_KEY=...
```

Créer `frontend/.env.local` :


```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001/api
```

Les traitements qui manipulent les pages nécessitent notamment `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` et `R2_PAGES_BUCKET_NAME`. La recherche sémantique distante utilise `VOYAGE_API_KEY` et `GOOGLE_API_KEY`. Les routes OCR distantes possèdent leurs propres secrets et quotas ; consulter `backend/sql/` avant de les activer.

### Démarrage

```bash
git clone https://github.com/remidesbois1/projet-poneglyph.git
cd projet-poneglyph
```

Dans un premier terminal :

```bash
cd backend
npm ci
npm run dev
```

Dans un second terminal, depuis la racine du dépôt :

```bash
cd frontend
npm ci
npm run dev
```

L’interface est alors disponible sur `http://localhost:3000` et l’API sur `http://localhost:3001`.

### Application de bureau

Installer les dépendances Python depuis la racine du dépôt :

```bash
python -m pip install -r desktop_backend/requirements.txt
```

Lancer Tauri en mode développement :

```bash
cd frontend
npm ci
npm run tauri dev
```

Sous Windows, l’installateur NSIS se construit depuis la racine avec :

```powershell
.\build_desktop.ps1
```

L’option `-PyInstaller` ajoute la construction d’un backend Python autonome. Sans cette option, l’application utilise l’interpréteur Python disponible sur la machine.

### Vérifications

Depuis la racine du dépôt :

```bash
cd backend
npm test

cd ../frontend
npm test
npm run lint
npm run build

cd ..
node scripts/render-model-registry.mjs --check
```

## Modèles, entraînement et reproductibilité

`shared/model-registry.json` est la source de vérité pour l’identité des modèles, leurs révisions et leurs résultats publiés. Les artefacts référencés sont épinglés à une révision précise ; les documents générés conservent le jeu de données, le split, le matériel, le protocole et la preuve associés à chaque mesure.

Pour régénérer le tableau de ce README et les documents dérivés :

```bash
node scripts/render-model-registry.mjs
```

Les copies du registre présentes dans les contextes de build du frontend et du backend sont synchronisées par leurs commandes `npm run sync:shared`. Elles ne doivent pas devenir des sources indépendantes.

Les pipelines d’export, d’entraînement, d’évaluation et de publication se trouvent dans `docker_scripts/`. Les principaux pipelines possèdent leur propre README avec leurs entrées, leurs sorties et leur procédure d’exécution.

## Documentation technique

| Sujet | Document |
| --- | --- |
| OCR PP-OCRv6 dans le navigateur | [`documentation/ppocrv6_bubble_line_recognition.md`](documentation/ppocrv6_bubble_line_recognition.md) |
| Modèles d’ordre de lecture | [`documentation/reading_order_ml.md`](documentation/reading_order_ml.md) |
| Expériences sur l’ordre de lecture | [`documentation/reading_order_experiments.md`](documentation/reading_order_experiments.md) |
| Provenance des benchmarks | [`documentation/generated/model-benchmarks.md`](documentation/generated/model-benchmarks.md) |
| Backend OCR de l’application de bureau | [`desktop_backend/README.md`](desktop_backend/README.md) |
| Entraînement sur Modal | [`docker_scripts/MODAL_TRAINING.md`](docker_scripts/MODAL_TRAINING.md) |
| Confidentialité de la télémétrie de recherche | [`docs/search-telemetry-privacy.md`](docs/search-telemetry-privacy.md) |

## Sécurité et données

Les pages sont référencées par des identifiants de stockage `r2://` et, en production, doivent résider dans un bucket privé. Leur exposition passe par des routes contrôlées.

L’application de bureau télécharge les modèles à partir de révisions épinglées, vérifie leur taille et leur empreinte SHA-256 avant activation, charge les poids hors ligne et n’autorise pas l’exécution de code distant fourni par un dépôt de modèles. Les détails et les options de développement sont documentés dans [`desktop_backend/README.md`](desktop_backend/README.md).

## Licence et contenus tiers

Le code source et la documentation originaux sont distribués sous [licence MIT](LICENSE).

Cette licence ne couvre pas les scans, les images de pages, les jeux de données ou annotations dérivés d’œuvres protégées, les modèles et poids tiers, les polices, les éléments graphiques, les marques ni les autres contenus appartenant à leurs ayants droit. Consulter [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) ainsi que la licence propre à chaque modèle avant toute utilisation ou redistribution.

## Remerciements

Un immense merci à **Chip Huyen** pour son ouvrage **"AI Engineering"** (O'Reilly), source d'inspiration majeure pour l'orchestration, l'optimisation des performances et l'infrastructure hybride de ce projet.
