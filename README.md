# Projet Poneglyph

![Status](https://img.shields.io/badge/Status-Live-success?style=for-the-badge)
![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-8A2BE2?style=for-the-badge)
![Desktop](https://img.shields.io/badge/Desktop-Tauri_v2-FFC131?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

Le **Projet Poneglyph** est une plateforme de haute performance dediee a la numerisation, l'indexation semantique et la recherche contextuelle de mangas et bandes dessinees. En combinant l'intelligence artificielle deportee (**WebGPU**) et une infrastructure hybride optimisee, le systeme permet une exploration inedite des oeuvres.

**Acces Public :** [**poneglyph.fr**](https://poneglyph.fr)
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
- [Developpement Local](#developpement-local)
- [Build Desktop](#build-desktop)
- [Pipeline MLOps](#pipeline-mlops)
- [Securite et FinOps](#securite-et-finops)
- [Avertissement Legal](#avertissement-legal)

---

## Application Desktop (One-Click)

Poneglyph est disponible en tant qu'application desktop Windows via **Tauri v2**. L'application charge directement `https://poneglyph.fr` et ajoute un backend Python local pour l'OCR haute precision sur GPU.

### Ce que fait l'application

| Fonctionnalite | Web | Desktop |
|---|---|---|
| Recherche par mots-cles | Oui | Oui |
| Recherche semantique | Oui | Oui |
| Navigation des volumes/pages | Oui | Oui |
| OCR TrOCR (WebGPU local) | Oui | Oui |
| OCR LightOn via Modal (cloud) | Oui | Oui |
| OCR LightOn **local** (Python/GPU) | Non | **Oui** |
| Annotation hors-ligne | Non | Non |

### Prerequis pour le mode desktop avec OCR local

- **Windows 10/11 64-bit**
- **Python 3.10+** avec **PyTorch** (CUDA recommande)
- **GPU NVIDIA** avec >= 4 Go VRAM (ou CPU lent)
- Connexion internet (l'appli charge poneglyph.fr)

> L'application fonctionne sans Python/GPU. Dans ce cas, seul l'OCR cloud (Modal) est disponible.

### Installation rapide (depuis l'installer)

1. Telechargez `Poneglyph_1.0.0_x64-setup.exe`
2. Lancez l'installer
3. Lancez **Poneglyph** depuis le menu Demarrer
4. L'application ouvre poneglyph.fr avec les fonctionnalites OCR locales

### Premier lancement avec OCR local

1. Ouvrez l'application
2. Allez sur une page d'annotation
3. Dans le panneau OCR, cliquez sur **Telecharger le modele local** (~2 Go)
4. Le modele est telecharge dans `%APPDATA%\poneglyph\models\`
5. Cliquez sur **OCR local** pour lancer l'inference sur votre GPU

---

## Architecture

### Infrastructure Core

- **Hebergement :** VPS Cloud (Hetzner CX23 - 2 vCPU, 4 Go RAM)
- **Orchestration :** Coolify (CI/CD et Reverse Proxy)
- **Stockage Objets :** Cloudflare R2 (compatible S3)
- **CDN et Securite :** Cloudflare (DNS, DDoS, cache)

### Frontend et IA (Edge)

- **Framework :** React 19 / Next.js
- **UI :** [ShadCn UI](https://ui.shadcn.com/)
- **OCR Hybride :** TrOCR Fine-tuned (WebGPU) + LightOnOCR (Cloud/Local)
- **Detection de Bulles :** YOLO26 Nano via ONNX Runtime Web (WASM)
- **Desktop :** Tauri v2 (Rust shell + Python backend)

### Backend et Services (Cloud)

- **API :** Node.js / Express
- **Base de Donnees :** Supabase (PostgreSQL + pgvector)
- **LLM et Embeddings :** Google Gemini 3.1 Flash-Lite, Voyage AI, Gemini Multimodal
- **Inference GPU Cloud :** Modal (NVIDIA L4)

### Desktop (Tauri v2)

```
┌──────────────────────────────────────────────────┐
│  Poneglyph Desktop (.exe)                        │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Tauri v2 (Rust)                           │  │
│  │  - Charge https://poneglyph.fr             │  │
│  │  - IPC: invoke() <-> Commandes Rust        │  │
│  │  - Demarre le backend Python en background │  │
│  │  - Arrete le process Python a la fermeture │  │
│  └──────────────┬─────────────────────────────┘  │
│                 │ HTTP (127.0.0.1:random)         │
│  ┌──────────────▼─────────────────────────────┐  │
│  │  local_ocr_server.py (FastAPI)              │  │
│  │  - Charge LightOnOCR-2-1b-poneglyph-bbox   │  │
│  │  - CUDA / MPS / CPU auto-detect            │  │
│  │  - Endpoints: /health, /model/*, /ocr      │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Modele: %APPDATA%\poneglyph\models\...          │
└──────────────────────────────────────────────────┘
```

---

## Moteur de Recherche Multi-Modal

### Recherche par Mots-Cles

Recherche instantanee via full-text search PostgreSQL, indexee au niveau de chaque bulle.

### Recherche Semantique et Conceptuelle

Architecture hybride, multicouche et parallelisee :

- **Moteur 1 (Texte) :** Vectorisation par **Voyage AI** (`voyage-4-large`)
- **Moteur 2 (Vision-Texte) :** Vectorisation multimodale par **Gemini** (`gemini-embedding-2-preview`)
- **Consensus :** Bonus de score (1.15x) pour les pages identifiees par les deux moteurs
- **Filtrage :** Arcs narratifs, personnages, volumes, mangas

### Systeme de Feedback (RLHF Lite)

- / sur chaque resultat pour la collecte de pertinence
- Objectif : dataset pour l'entrainement d'un modele de reranking specialise

---

## Pipeline OCR Hybride

### TrOCR Fine-tuned (Local WebGPU)

> Details : [ocr_pipeline.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/ocr_pipeline.md)

| | **TrOCR Base** | **TrOCR Large** |
|---|---|---|
| **HuggingFace** | [`trocr-onepiece-fr`](https://huggingface.co/Remidesbois/trocr-onepiece-fr) | [`trocr-onepiece-fr-large`](https://huggingface.co/Remidesbois/trocr-onepiece-fr-large) |
| **Parametres** | ~334M | ~558M |
| **Taille ONNX** | ~1.33 Go | ~2.33 Go |
| **CER (brut)** | 2.90% | **1.83%** |
| **WER (brut)** | 9.20% | **6.03%** |
| **Cout** | 0 $/OCR | 0 $/OCR |

### LightOn-OCR Poneglyph (Cloud Modal / Local GPU)

Modele de pointe pour une precision extreme, deploye en serverless sur **Modal** et disponible en local via le desktop.

- **Modele :** [`LightonOCR-2-1b-poneglyph-bbox`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph-bbox) (Architecture LightOnOCR-2-1B)
- **Precision :** CER < 0.1% - WER < 0.1%
- **Cloud :** GPU NVIDIA L4 via Modal (~0.000222 $/seconde)
- **Local :** 0$/OCR, 5-15s/page selon GPU
- **Optimisation :** Post-processing de troncature pour 0% d'hallucination

### YOLO26 Fine-tuned (Detection des Bulles)

Detection instantanee des bulles sur la planche.

- **Performance :** mAP50 **0.994** / mAP50-95 **0.868**
- **Architecture :** YOLO26n (2.4M parametres, 5.2 GFLOPs)
- **Execution :** ONNX Runtime Web (WASM) cote client
- **Modele :** [`YoloPiece_BubbleDetector_Nano`](https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector_Nano)

### Modele de Tri des Bulles (ReaderNet V5)

> Details : [reading_order_ml.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/reading_order_ml.md)

| | **ReaderNet V5** |
|---|---|
| **Architecture** | Global-Local (MobileNetV3 + MLP) |
| **Precision (Val)** | **98.0%** |
| **Taille ONNX** | **2.47 MB** |
| **Execution** | Local (Web worker) |

### Google Gemini 3.1 Flash-Lite (Cloud Fallback)

Fallback pour les configurations ne supportant pas WebGPU. 500 requetes gratuites, puis 0.00008$/OCR.

---

## API Publique V1

**Base URL :** `https://api.poneglyph.fr/v1`

| Endpoint | Methode | Description |
|---|---|---|
| `/status` | GET | Etat de l'API |
| `/stats` | GET | Statistiques globales |
| `/series` | GET | Liste des series |
| `/tomes/:id` | GET | Details d'un volume |
| `/pages/:id` | GET | Contenu d'une page |
| `/quotes/random` | GET | Citation aleatoire |
| `/search` | GET | Recherche textuelle |

> Les images sont watermarkees et reduites en qualite.

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

## Developpement Local

### Prerequis

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
MODAL_OCR_URL=https://remisemenzin--ocr-poneglyph.modal.run
MODAL_LIGHTON_URL=https://remisemenzin--ocr-lighton.modal.run
MODAL_PONEGLYPH_BBOX_URL=https://remisemenzin--poneglyph-bbox.modal.run
```

### Demarrage

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

En mode dev, Tauri charge `http://localhost:3000` (Next.js dev server). Le backend Python est demarre automatiquement.

---

## Build Desktop

### Build rapide

```powershell
# Depuis la racine du repo
.\build_desktop.ps1
```

L'installer NSIS est genere dans `frontend\src-tauri\target\release\bundle\nsis\`.

### Build avec backend PyInstaller (standalone, sans Python requis)

```powershell
.\build_desktop.ps1 -PyInstaller
```

Cela cree un `local_ocr_server.exe` autonome qui ne necessite pas Python installe. Attention : l'exe fait ~3-5 Go avec PyTorch + CUDA.

### Build manuel

```powershell
cd frontend
npm install

# Optionnel : build PyInstaller
cd ..\desktop_backend
python -m PyInstaller --onefile --name local_ocr_server local_ocr_server.py
copy dist\local_ocr_server.exe .
cd ..\frontend

# Build Tauri
npm run tauri build -- --bundles nsis
```

### Resultat

| Fichier | Description |
|---|---|
| `Poneglyph_1.0.0_x64-setup.exe` | Installer NSIS |
| `target\release\Poneglyph.exe` | Portable exe |

### Comment fonctionne l'installer

1. Installe l'application dans `%LOCALAPPDATA%\Poneglyph\`
2. Cree un raccourci dans le menu Demarrer
3. Au lancement, l'application :
   - Ouvre une fenetre chargeant `https://poneglyph.fr`
   - Demarre le backend Python en arriere-plan (port aleatoire sur 127.0.0.1)
   - Injecte l'API Tauri pour la communication avec le backend local
   - A la fermeture, tue proprement le process Python

---

## Pipeline MLOps

Les scripts `/script_docker` automatisent le cycle de vie des modeles IA :

1. **Extraction :** Recuperation des bulles/pages validees (Supabase)
2. **Fine-Tuning :** Entrainement de TrOCR, LightOnOCR et modeles de detection/tri
3. **Deploiement :** Push automatique vers Hugging Face si les metriques sont validees

---

## Securite et FinOps

Cout de fonctionnement : **~5 EUR/mois**

- **Watermarking dynamique** : Protection des visuels
- **Edge Computing** : Inference deportee sur le client
- **API Keys** : Cles serveur pour la recherche semantique
- **Desktop** : Backend Python local uniquement sur 127.0.0.1
- **IPC** : Acces Tauri restreint au domaine `poneglyph.fr`

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

## Avertissement Legal

> Ce projet est une demonstration technique a but educatif et de recherche sur l'indexation semantique et l'IA deportee.
>
> Les images accessibles publiquement sont **systematiquement reduites en qualite** et marquee d'un **filigrane visible**. Ces degradations volontaires garantissent que l'experience ne peut se substituer a l'achat de l'oeuvre originale. Toutes les images restent la propriete de leurs ayants droit.

---

## Remerciements

Un immense merci a **Chip Huyen** pour son ouvrage **"AI Engineering"** (O'Reilly), source d'inspiration majeure pour l'orchestration, l'optimisation des performances et l'infrastructure hybride de ce projet.
