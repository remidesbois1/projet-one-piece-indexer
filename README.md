# Projet Poneglyph

![Status](https://img.shields.io/badge/Status-Live-success?style=for-the-badge)
![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-8A2BE2?style=for-the-badge)
![Desktop](https://img.shields.io/badge/Desktop-Tauri_v2-FFC131?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle de mangas et bandes dessinées. En combinant l'intelligence artificielle déportée (**WebGPU**) et une infrastructure hybride optimisée, le système permet une exploration inédite des œuvres.

**Accès Public :** [**poneglyph.fr**](https://poneglyph.fr)
**Sandbox OCR :** [**poneglyph.fr/sandbox**](https://poneglyph.fr/sandbox)
**API Publique :** `https://api.poneglyph.fr/v1`

---

## Sommaire

- [Application Desktop (One-Click)](#application-desktop-one-click)
- [Architecture](#architecture)
- [Moteur de Recherche Multi-Modal](#moteur-de-recherche-multi-modal)
- [Pipeline OCR Hybride](#pipeline-ocr-hybride)
- [API Publique V1](#api-publique-v1)
- [Infrastructure](#infrastructure)
- [Développement Local](#développement-local)
- [Build Desktop](#build-desktop)
- [Pipeline MLOps](#pipeline-mlops)
- [Sécurité et FinOps](#sécurité-et-finops)
- [Avertissement Légal](#avertissement-légal)

---

## Application Desktop (One-Click)

Poneglyph est disponible en tant qu'application desktop Windows via **Tauri v2**. L'application charge directement `https://poneglyph.fr` et ajoute un backend Python local pour l'OCR sur GPU.

### Prérequis pour le mode desktop avec OCR local

- **Windows 10/11 64-bit**
- **Python 3.10+** avec **PyTorch** (CUDA recommandé)
- **GPU NVIDIA** avec >= 4 Go VRAM (ou CPU lent)
- Connexion internet

> L'application fonctionne sans Python/GPU. Dans ce cas, seul l'OCR cloud (Modal) est disponible.

### Installation rapide (depuis l'installer)

1. Téléchargez `Poneglyph_1.0.0_x64-setup.exe`
2. Lancez l'installer
3. Lancez **Poneglyph** depuis le menu Démarrer

### Premier lancement avec OCR local

1. Ouvrez l'application
2. Allez sur une page d'annotation
3. Dans le panneau OCR, cliquez sur **Télécharger le modèle local** (~2 Go)
4. Le modèle est téléchargé dans `%APPDATA%\poneglyph\models\`
5. Cliquez sur **OCR local** pour lancer l'inférence sur votre GPU

### Backend OCR local: performance transformers

Le backend desktop utilise uniquement `transformers` pour l'inference locale.
Sur CUDA, il active les optimisations compatibles avec LightOnOCR sans chemin
experimental supplementaire: TF32, choix d'attention avec fallback
`flash_attention_2` -> `sdpa` -> implementation par defaut, deplacements GPU
non bloquants, kernels SDPA CUDA rapides, `cudnn.benchmark`, chargement
`safetensors` a faible memoire CPU, autocast fp16/bf16, warmup optionnel et
limites de tokens configurables.

Options de performance:

- `PONEGLYPH_TORCH_COMPILE=1/0` (defaut: `0`)
- `PONEGLYPH_FLASH_ATTN=1/0` (defaut: `1`)
- `PONEGLYPH_TF32=1/0` (defaut: `1`)
- `PONEGLYPH_TEXT_MAX_NEW_TOKENS` (defaut: `128`)
- `PONEGLYPH_BBOX_MAX_NEW_TOKENS` (defaut: `2048`)
- `PONEGLYPH_WARMUP=1/0` (defaut: `1`)

Verification rapide sans telechargement des modeles:

```powershell
python desktop_backend/verify_inference_backends.py
```

Benchmark manuel optionnel:

```powershell
python desktop_backend/benchmark_local_ocr.py --image sample.png --endpoint /ocr/text --runs 5
```

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
- **OCR Hybride :** TrOCR Fine-tuned (WebGPU) + LightOnOCR (Cloud/Local)
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
│  │  - Charge [https://poneglyph.fr](https://poneglyph.fr)             │  │
│  │  - IPC: invoke() <-> Commandes Rust        │  │
│  │  - Démarre le backend Python en background │  │
│  │  - Arrête le process Python à la fermeture │  │
│  └──────────────┬─────────────────────────────┘  │
│                 │ HTTP (127.0.0.1:random)        │
│  ┌──────────────▼─────────────────────────────┐  │
│  │  local_ocr_server.py (FastAPI)             │  │
│  │  - Charge LightOnOCR-2-1b-poneglyph-bbox   │  │
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

### TrOCR Fine-tuned (Local WebGPU)

> Détails : [ocr_pipeline.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/ocr_pipeline.md)

| | **TrOCR Base** | **TrOCR Large** |
|---|---|---|
| **HuggingFace** | [`trocr-onepiece-fr`](https://huggingface.co/Remidesbois/trocr-onepiece-fr) | [`trocr-onepiece-fr-large`](https://huggingface.co/Remidesbois/trocr-onepiece-fr-large) |
| **Paramètres** | ~334M | ~558M |
| **Taille ONNX** | ~1.33 Go | ~2.33 Go |
| **CER (brut)** | 2.90% | **1.83%** |
| **WER (brut)** | 9.20% | **6.03%** |
| **Coût** | 0 $/OCR | 0 $/OCR |

### LightOn-OCR Poneglyph (Cloud Modal / Local GPU)

Modèle de pointe pour une précision extrême, déployé en serverless sur **Modal** et disponible en local via le desktop.

- **Modèle :** [`LightonOCR-2-1b-poneglyph-bbox`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph-bbox) (Architecture LightOnOCR-2-1B)
- **Précision :** CER < 0.1% - WER < 0.1%
- **Cloud :** GPU NVIDIA L4 via Modal (~0.000222 $/seconde)
- **Local :** 0$/OCR, 5-15s/page selon GPU
- **Optimisation :** Post-processing de troncature pour 0% d'hallucination

### YOLO26 Fine-tuned (Détection des Bulles)

Détection instantanée des bulles sur la planche.

- **Performance :** mAP50 **0.994** / mAP50-95 **0.868**
- **Architecture :** YOLO26n (2.4M paramètres, 5.2 GFLOPs)
- **Exécution :** ONNX Runtime Web (WASM) côté client
- **Modèle :** [`YoloPiece_BubbleDetector_Nano`](https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector_Nano)

### Modèle de Tri des Bulles (ReaderNet V5)

> Détails : [reading_order_ml.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/reading_order_ml.md)

| | **ReaderNet V5** |
|---|---|
| **Architecture** | Global-Local (MobileNetV3 + MLP) |
| **Précision (Val)** | **98.0%** |
| **Taille ONNX** | **2.47 MB** |
| **Exécution** | Local (Web worker) |

### Google Gemini 3.1 Flash-Lite (Cloud Fallback)

Fallback pour les configurations ne supportant pas WebGPU. 500 requêtes gratuites, puis 0.00008$/OCR.

---

## API Publique V1

**Base URL :** `https://api.poneglyph.fr/v1`

| Endpoint | Méthode | Description |
|---|---|---|
| `/status` | GET | État de l'API |
| `/stats` | GET | Statistiques globales |
| `/series` | GET | Liste des séries |
| `/tomes/:id` | GET | Détails d'un volume |
| `/pages/:id` | GET | Contenu d'une page |
| `/quotes/random` | GET | Citation aléatoire |
| `/search` | GET | Recherche textuelle |

> Les images sont watermarkées et réduites en qualité.

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
            └── LightOnOCR Local GPU Inference
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
GOOGLE_API_KEY=...
VOYAGE_API_KEY=...
```

**Frontend (`frontend/.env`)**
```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001/api
MODAL_OCR_API_KEY=...
MODAL_OCR_URL=[https://remisemenzin--ocr-poneglyph.modal.run](https://remisemenzin--ocr-poneglyph.modal.run)
MODAL_LIGHTON_URL=[https://remisemenzin--ocr-lighton.modal.run](https://remisemenzin--ocr-lighton.modal.run)
MODAL_PONEGLYPH_BBOX_URL=[https://remisemenzin--poneglyph-bbox.modal.run](https://remisemenzin--poneglyph-bbox.modal.run)
```

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
   - Ouvre une fenêtre chargeant `https://poneglyph.fr`
   - Démarre le backend Python en arrière-plan (port aléatoire sur 127.0.0.1)
   - À la fermeture, tue proprement le process Python

---

## Pipeline MLOps

Les scripts `/script_docker` automatisent le cycle de vie des modèles IA :

1. **Extraction :** Récupération des bulles/pages validées (Supabase)
2. **Fine-Tuning :** Entraînement de TrOCR, LightOnOCR et modèles de détection/tri
3. **Déploiement :** Push automatique vers Hugging Face si les métriques sont validées

---

## Sécurité et FinOps

Coût de fonctionnement : **~5 EUR/mois**

---

## Structure du Projet

```
projet-one-piece-indexer/
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
> Les images accessibles publiquement sont **systématiquement réduites en qualité** et marquées d'un **filigrane visible**. Ces dégradations volontaires garantissent que l'expérience ne peut se substituer à l'achat de l'œuvre originale. Toutes les images restent la propriété de leurs ayants droit.

---

## Remerciements

Un immense merci à **Chip Huyen** pour son ouvrage **"AI Engineering"** (O'Reilly), source d'inspiration majeure pour l'orchestration, l'optimisation des performances et l'infrastructure hybride de ce projet.
