# Projet Poneglyph

![Status](https://img.shields.io/badge/Status-Live-success?style=for-the-badge)
![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-8A2BE2?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle de mangas et bandes dessinées. En combinant l'intelligence artificielle déportée (**WebGPU**) et une infrastructure hybride optimisée, le système permet une exploration inédite des œuvres.

**Accès Public :** [**poneglyph.fr**](https://poneglyph.fr)
**Sandbox OCR :** [**poneglyph.fr/sandbox**](https://poneglyph.fr/sandbox)
**API Publique recommandée :** `https://api.poneglyph.fr/v2`
**Contrat OpenAPI :** [`https://api.poneglyph.fr/openapi.json`](https://api.poneglyph.fr/openapi.json)

---

## Sommaire

- [Architecture](#architecture)
- [Moteur de Recherche Multi-Modal](#moteur-de-recherche-multi-modal)
- [Pipeline OCR Hybride](#pipeline-ocr-hybride)
- [Modèle PP-OCRv6 Bubble Line](documentation/ppocrv6_bubble_line_recognition.md)
- [API Publique](#api-publique)
- [Infrastructure](#infrastructure)
- [Développement Local](#développement-local)
- [Build Desktop](#build-desktop)
- [Pipeline MLOps](#pipeline-mlops)
- [Sécurité et FinOps](#sécurité-et-finops)
- [Avertissement Légal](#avertissement-légal)
---

## Architecture

### Infrastructure Core

- **Hébergement :** VPS Cloud (Hetzner CX23 - 2 vCPU, 4 Go RAM)
- **Orchestration :** Coolify (CI/CD et Reverse Proxy)
- **Stockage Objets :** Cloudflare R2 (compatible S3)
- **CDN et Sécurité :** Cloudflare (DNS, DDoS, cache)

### Frontend et IA (Edge)

- **Framework :** React 19 / Next.js
- **UI :** [ShadCn UI](https://ui.shadcn.com/)
- **OCR Hybride :** PP-OCRv6 Ligne (ONNX navigateur) + Poneglyph & Surya (Cloud/Local)
- **Détection de Bulles :** YOLO26 Nano via ONNX Runtime Web (WASM)
- **Desktop :** Tauri v2 (Rust shell + Python backend)

### Backend et Services (Cloud)

- **API :** Node.js / Express
- **Base de Données :** Supabase (PostgreSQL + pgvector)
- **LLM et Embeddings :** Google Gemini 3.1 Flash-Lite, Voyage AI, Gemini Multimodal
- **Inférence GPU Cloud :** Modal (NVIDIA L4)

### Desktop (Tauri v2)

```
┌──────────────────────────────────────────────────┐
│  Poneglyph Desktop (.exe)                        │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Tauri v2 (Rust)                           │  │
│  │  - Shell local embarqué + CSP stricte      │  │
│  │  - Site distant sandboxé, sans IPC Tauri   │  │
│  │  - IPC local: invoke() <-> commandes Rust  │  │
│  │  - Backend Python géré en arrière-plan     │  │
│  └──────────────┬─────────────────────────────┘  │
│                 │ HTTP (127.0.0.1:random)        │
│  ┌──────────────▼─────────────────────────────┐  │
│  │  local_ocr_server.py (FastAPI)             │  │
│  │  - 4 modèles locaux téléchargeables :      │  │
│  │    • Poneglyph-BBox (full-page + bbox)     │  │
│  │    • Poneglyph (bulle unique)              │  │
│  │    • Surya-BBox (full-page + bbox)         │  │
│  │    • Surya (bulle unique)                  │  │
│  │  - CUDA / MPS / CPU auto-detect            │  │
│  │  - Endpoints: /health, /model/*, /ocr      │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Modèle: %APPDATA%\poneglyph\models\...          │
└──────────────────────────────────────────────────┘
```

---

## Moteur de Recherche Multi-Modal

### Recherche par Mots-Clés

Recherche instantanée via full-text search PostgreSQL, indexée au niveau de chaque bulle.

### Recherche Sémantique et Conceptuelle

Architecture hybride, multicouche et parallélisée :

- **Moteur 1 (Texte) :** Vectorisation par **Voyage AI** (`voyage-4-large`)
- **Moteur 2 (Vision-Texte) :** Vectorisation multimodale par **Gemini** (`gemini-embedding-2-preview`)
- **Consensus :** Bonus de score (1.15x) pour les pages identifiées par les deux moteurs
- **Filtrage :** Arcs narratifs, personnages, volumes, mangas

---

## Pipeline OCR Hybride

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

### PP-OCRv6 Ligne (Local Navigateur)

Le moteur navigateur local combine un détecteur de lignes YOLO26n ONNX et un recognizer PP-OCRv6 ONNX pour transcrire les bulles sans appel cloud. Le pipeline détecte les lignes dans une bulle, les déduplique, les assemble en une image horizontale, puis lance le recognizer CTC PP-OCRv6.

- **HuggingFace :** [`pp-ocrv6-one-piece-bubble-line-rec`](https://huggingface.co/Remidesbois/pp-ocrv6-one-piece-bubble-line-rec)
- **Documentation :** [`documentation/ppocrv6_bubble_line_recognition.md`](documentation/ppocrv6_bubble_line_recognition.md)
- **Runtime :** ONNX Runtime Web (WASM)
- **Taille :** ~83 Mo (`YOLO lignes` + `PP-OCRv6 rec`)
- **Métriques :** voir le tableau généré depuis le registre ci-dessus.
- **Coût :** 0 $/OCR

### LightOn-OCR Poneglyph (Cloud Modal / Local GPU)

Modèle de pointe pour une précision extrême, déployé en serverless sur **Modal** et disponible en local via le desktop. Deux variantes sont supportées par le backend local :

- **Poneglyph-BBox** (full-page) : [`LightonOCR-2-1b-poneglyph-bbox`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph-bbox) — détecte toutes les bulles d'une page et renvoie texte + bbox.
- **Poneglyph** (bulle unique) : [`LightonOCR-2-1b-poneglyph`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph) — transcription d'une bulle isolée.

- **Métriques :** voir le tableau généré depuis le registre ci-dessus.
- **Cloud :** GPU NVIDIA L4 via Modal (~0.000222 $/seconde)
- **Local :** 0$/OCR, 5-15s/page selon GPU
- **Optimisation :** Post-processing de troncature pour 0% d'hallucination

### Surya OCR 2 Poneglyph (Local GPU)

Fine-tune du VLM [`datalab-to/surya-ocr-2`](https://huggingface.co/datalab-to/surya-ocr-2) (Qwen3.5 image-text-to-text), exécuté en local via le desktop. Mêmes deux modes que Poneglyph :

- **Surya-BBox** (full-page) : [`surya-ocr-2-poneglyph-bbox`](https://huggingface.co/Remidesbois/surya-ocr-2-poneglyph-bbox) — contrat `Texte [x1,y1,x2,y2]`, coordonnées normalisées à `[0, 1000]`.
- **Surya** (bulle unique) : [`surya-bubble-ocr-poneglyph`](https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph).

- **Local :** 0$/OCR via transformers (`AutoModelForImageTextToText`)
- **Métriques :** voir le tableau généré depuis le registre ci-dessus.
- **Pipeline crop reproductible :** [`docker_scripts/finetune_surya_bubble_ocr`](docker_scripts/finetune_surya_bubble_ocr) (split strict par page → fine-tuning hybride → benchmark exhaustif → publication Hugging Face)
- **Pipeline BBox :** [`docker_scripts/finetune_surya_ocr_bbox`](docker_scripts/finetune_surya_ocr_bbox)

### YOLO26 Fine-tuned (Détection des Bulles)

Détection instantanée des bulles sur la planche.

- **Métriques :** voir le tableau généré depuis le registre ci-dessus.
- **Architecture :** YOLO26n (2.4M paramètres, 5.2 GFLOPs)
- **Exécution :** ONNX Runtime Web (WASM) côté client
- **Modèles :** [`YoloPiece_OneShot_Models`](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models) (`bubble_detector.onnx`, `panel_detector.onnx`)

### One-Shot Reading Order (ONNX)

> Détails : [reading_order_ml.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/reading_order_ml.md)

| | **YoloPiece_OneShot_Models** |
|---|---|
| **Architecture** | Détecteurs YOLO + rankers pairwise ONNX |
| **Rankers** | `panel_order.onnx` + `bubble_order.onnx` |
| **Métriques** | Voir le tableau généré depuis le registre ci-dessus. |
| **Exécution** | Local (Web worker, ONNX Runtime Web) |

### Google Gemini 3.1 Flash-Lite (Cloud Fallback)

Fallback pour les configurations ne supportant pas WebGPU. 500 requêtes gratuites, puis 0.00008$/OCR.

---

## API Publique

Le contrat exécutable est publié au format OpenAPI 3.1 sur
[`/openapi.json`](https://api.poneglyph.fr/openapi.json). Les changements de
routes publiques déclenchent aussi une validation de ce contrat en CI.

### Versions supportées

| Version | Statut | Usage |
|---|---|---|
| **v2** | Stable, recommandée | Toutes les nouvelles intégrations. Les numéros de volumes et chapitres sont toujours rattachés à un `seriesSlug`. |
| **v1** | Dépréciée, maintenue pour compatibilité | Aucun nouvel endpoint. Les routes historiques par numéro peuvent être ambiguës dès que plusieurs séries sont présentes. Aucune date de retrait n'est annoncée. |

**Base URL v2 :** `https://api.poneglyph.fr/v2`

| Endpoint v2 | Méthode | Description |
|---|---|---|
| `/series/{seriesSlug}/volumes/{volumeNumber}/chapters` | GET | Chapitres d'un volume précisément rattaché à une série. |
| `/series/{seriesSlug}/chapters/{chapterNumber}/pages/{pageNumber}` | GET | Page et bulles validées d'un chapitre précisément rattaché à une série. |

Les collections acceptent `page` (défaut `1`) et `page_size` (défaut `50`,
maximum `100`). Chaque réponse v2 contient les identifiants stables des
ressources, `series_slug`, un objet `pagination` et des liens de navigation.

**Base URL v1 :** `https://api.poneglyph.fr/v1`

| Endpoint v1 déprécié | Méthode | Description |
|---|---|---|
| `/status` | GET | État de l'API historique. |
| `/tomes` | GET | Liste historique des volumes, sans scope de série. |
| `/tomes/{tomeNumero}/chapters` | GET | Chapitres d'un numéro de volume historique. |
| `/search` | GET | Recherche textuelle historique. |
| `/stats` | GET | Statistiques globales. |
| `/quotes/random` | GET | Citation validée aléatoire. |
| `/chapters/{numero}` | GET | Détail historique d'un chapitre par numéro. |
| `/chapters/{chapterNo}/pages/{pageNo}` | GET | Page historique par numéros de chapitre et de page. |

> Les images publiques sont fortement floutées, sauf dans les zones des bulles de texte.

---

## Infrastructure

```
poneglyph.fr (Cloudflare CDN)
    │
    ├── Frontend (Next.js / Coolify)
    │   └── WebGPU OCR + YOLO Detection
    │
    ├── Backend API (Node.js / Express)
    │   ├── Supabase (PostgreSQL + pgvector)
    │   ├── Cloudflare R2 (Images)
    │   ├── Modal (GPU Cloud OCR)
    │   └── Voyage AI + Gemini (Embeddings)
    │
    └── Desktop App (Tauri v2)
        └── Python Backend (FastAPI + PyTorch)
            └── Poneglyph & Surya Local GPU Inference
```

---

## Développement Local

### Prérequis

- Node.js 22+
- Python 3.10+ (pour l'OCR local desktop)

### Variables d'environnement

**Backend (`backend/.env`)**
```env
PORT=3001
SUPABASE_URL=...
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

Les planches sont enregistrées sous forme de références `r2://` dans le bucket
privé `R2_PAGES_BUCKET_NAME`. Ce bucket ne doit exposer ni domaine public ni
accès anonyme ; seules les couvertures peuvent utiliser `R2_PUBLIC_URL`.
Pour migrer les planches historiques, vérifier d'abord le plan avec
`npm run migrate:private-pages`, puis lancer depuis `backend/`
`npm run migrate:private-pages -- --apply --delete-source` après sauvegarde.

**Frontend (`frontend/.env`)**
```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001/api
SUPABASE_SERVICE_ROLE_KEY=... # serveur Next.js uniquement, jamais NEXT_PUBLIC_*
MODAL_OCR_ENABLED=true
MODAL_OCR_API_KEY=...
MODAL_OCR_URL=https://votre-endpoint-ocr.modal.run
MODAL_LIGHTON_URL=https://votre-endpoint-lighton.modal.run
MODAL_PONEGLYPH_BBOX_URL=https://votre-endpoint-bbox.modal.run
MODAL_OCR_QUOTA_HMAC_SECRET=... # secret aléatoire d'au moins 32 caractères
# Limites optionnelles, exprimées en unités OCR
MODAL_OCR_USER_MINUTE_UNITS=60
MODAL_OCR_USER_DAILY_UNITS=1000
MODAL_OCR_IP_MINUTE_UNITS=120
MODAL_OCR_DEVICE_MINUTE_UNITS=60
MODAL_OCR_GLOBAL_DAILY_UNITS=10000
# Sandbox publique BBox : coût fixe de 5 unités par appel
MODAL_OCR_ANONYMOUS_MINUTE_UNITS=5
MODAL_OCR_ANONYMOUS_DAILY_UNITS=15
MODAL_OCR_ANONYMOUS_IP_MINUTE_UNITS=5
MODAL_OCR_ANONYMOUS_DEVICE_MINUTE_UNITS=5
MODAL_OCR_ANONYMOUS_GLOBAL_MINUTE_UNITS=5
MODAL_OCR_ANONYMOUS_GLOBAL_DAILY_UNITS=100
```

Avant d'activer les proxies Modal, appliquer la migration
`backend/sql/2026-07-31_add_modal_ocr_quotas.sql` à Supabase. Les proxies se
ferment par défaut si la migration, les secrets serveur ou les quotas persistants
ne sont pas disponibles. Seule la route BBox de la sandbox accepte une requête
sans session ; les autres routes exigent toujours un jeton Supabase valide.

### Démarrage

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend
cd frontend && npm install && npm run dev
```

### Tauri Dev (Desktop)

```bash
cd frontend
npm run tauri dev
```

En mode dev, Tauri charge `http://localhost:3000` (Next.js dev server). Le backend Python est démarré automatiquement.

---

## Build Desktop

```powershell
# Depuis la racine du repo
.\build_desktop.ps1
```

L'installer NSIS est généré dans `frontend\src-tauri\target\release\bundle\nsis\`.


### Résultat

| Fichier | Description |
|---|---|
| `Poneglyph_1.0.0_x64-setup.exe` | Installer NSIS |
| `target\release\Poneglyph.exe` | Portable exe |

### Comment fonctionne l'installer

1. Installe l'application dans `%LOCALAPPDATA%\Poneglyph\`
2. Crée un raccourci dans le menu Démarrer
3. Au lancement, l'application :
   - Ouvre le shell privilégié embarqué avec une CSP stricte
   - Affiche `https://poneglyph.fr` dans une zone sandboxée sans permission Tauri
   - Démarre le backend Python en arrière-plan (port aléatoire sur 127.0.0.1)
   - À la fermeture, tue proprement le process Python

---

## Pipeline MLOps

Les scripts `/docker_scripts` automatisent le cycle de vie des modèles IA :

1. **Extraction :** Récupération des bulles/pages validées (Supabase)
2. **Fine-Tuning :** Entraînement de PP-OCRv6, LightOnOCR, Surya (bulle + bbox) et modèles de détection/tri
3. **Déploiement :** Push automatique vers Hugging Face si les métriques sont validées

Le pipeline PP-OCRv6 local navigateur est documenté avec captures et métriques ici : [`documentation/ppocrv6_bubble_line_recognition.md`](documentation/ppocrv6_bubble_line_recognition.md).

---

## Sécurité et FinOps

Coût de fonctionnement : **~5 EUR/mois**

---

## Structure du Projet

```
projet-poneglyph/
├── backend/                    # API Node.js / Express
│   ├── src/
│   ├── scripts/
│   └── sql/
├── desktop_backend/            # Backend Python OCR local (FastAPI)
│   ├── local_ocr_server.py
│   └── requirements.txt
├── docker_scripts/             # Scripts MLOps (fine-tuning)
├── documentation/              # Documentation technique
├── frontend/
│   ├── src/
│   │   ├── app/                # Pages Next.js
│   │   ├── components/         # Composants React
│   │   ├── context/            # State management
│   │   ├── hooks/              # Hooks (useTauriLocalOcr, etc.)
│   │   └── lib/                # Utilitaires (api.js, supabase)
│   ├── src-tauri/              # Shell Tauri v2 (Rust)
│   │   ├── src/main.rs         # Commandes Tauri + spawn Python
│   │   ├── capabilities/       # Permissions IPC
│   │   ├── desktop-fallback/   # Page fallback hors-ligne
│   │   ├── tauri.conf.json     # Configuration Tauri
│   │   └── Cargo.toml
│   └── package.json
├── build_desktop.ps1           # Script de build desktop
└── README.md
```

---

## Avertissement Légal

> Ce projet est une démonstration technique à but éducatif et de recherche sur l'indexation sémantique et l'IA déportée.
>
> Les images accessibles publiquement sont **systématiquement floutées hors des zones de texte**. Cette dégradation volontaire garantit que l'expérience ne peut se substituer à l'achat de l'œuvre originale. Toutes les images restent la propriété de leurs ayants droit.

---

## Licence

Le code source original du projet est publié sous [licence MIT](LICENSE). Cette
licence ne couvre pas les scans, jeux de données dérivés, modèles ou poids
tiers, polices, marques et autres contenus dont les droits appartiennent à
leurs propriétaires respectifs. Consultez les
[notices tierces](THIRD_PARTY_NOTICES.md) avant toute redistribution.

---

## Remerciements

Un immense merci à **Chip Huyen** pour son ouvrage **"AI Engineering"** (O'Reilly), source d'inspiration majeure pour l'orchestration, l'optimisation des performances et l'infrastructure hybride de ce projet.
