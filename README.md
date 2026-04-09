# **Projet Poneglyph**

![Status](https://img.shields.io/badge/Status-Live-success?style=for-the-badge)
![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-8A2BE2?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle de mangas et bandes dessinées. En combinant l'intelligence artificielle déportée (**WebGPU**) et une infrastructure hybride optimisée, le système permet une exploration inédite des oeuvres.

**Accès Public (Mode Invité pour la Consultation et la Recherche) :** [**poneglyph.fr**](https://poneglyph.fr)

**Sandbox (Test de l'OCR sans inscription) :** [**poneglyph.fr/sandbox**](https://poneglyph.fr/sandbox)

---

### **Infrastructure Core**

* **Hébergement :** VPS Cloud (Hetzner CX23 - 2 vCPU, 4 Go RAM).
* **Orchestration :** Coolify (Gestion des conteneurs, CI/CD et Reverse Proxy).
* **Stockage Objets :** Cloudflare R2 pour l'hébergement des planches (compatible S3).
* **CDN & Sécurité :** Cloudflare (Gestion DNS, protection DDoS et mise en cache).

### **Frontend & IA (Edge)**

* **Framework :** React 19 / Next.js & Vite.
* **CSS** : [ShadCn UI](https://ui.shadcn.com/)
* **OCR Hybride :** **TrOCR Fine-tuned** (Local via WebGPU) & **LightOnOCR** (Cloud via Modal).
* **Détection de Bulles Locale :** **YOLO V11 Medium Fine-tuned** [`Remidesbois/YoloPiece_BubbleDetector`](https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector) exécuté via WebGPU.
* **State Management :** Context API & LocalStorage.

### **Backend & Services (Cloud)**

* **Serveur API :** Node.js / Express.
* **Base de Données :** Supabase (PostgreSQL) avec l'extension **pgvector**.
* **LLM & Embeddings :** Google Gemini 3.1 Flash-Lite, Voyage AI (`voyage-4-large`) & Gemini Multimodal (`gemini-embedding-2-preview`).
* **Inférence GPU Cloud :** Modal (pour l'OCR LightOn de haute précision).

---

## **Moteur de Recherche Multi-Modal**

L'indexer propose deux expériences de recherche distinctes :

### **1. Recherche par Mots-Clés**

* Recherche instantanée via *full-text search* PostgreSQL.
* Indexation précise au niveau de chaque bulle de dialogue.

### **2. Recherche Sémantique & Conceptuelle**

L'Indexer utilise une architecture de recherche hybride, multicouche et parallélisée pour une précision maximale :

* **Récupération Parallèle & Multimodale :** 
    * **Moteur 1 (Texte) :** Vectorisation par **Voyage AI** (`voyage-4-large`).
    * **Moteur 2 (Vision-Texte) :** Vectorisation **multimodale** par **Gemini** (`gemini-embedding-2-preview`). Ce moteur fusionne les descriptions textuelles et l'analyse visuelle des planches pour une compréhension profonde de l'image.
    * **Consensus :** Bonus de score (**1.15x**) appliqué aux pages identifiées par les deux moteurs pour prioriser le consensus.
* **Filtrage Multicritère :** Arcs narratifs, personnages, volumes et mangas.

> L'expérience sémantique est désormais entièrement gérée via les clés API côté serveur pour une expérience utilisateur fluide.

### **3. Système de Feedback (RLHF Lite)**

* 👍 / 👎 sur chaque résultat pour collecter des données de pertinence.
* **Objectif :** Constitution d'un dataset pour l'entraînement futur d'un modèle de reranking spécialisé.

---

## **Pipeline d'OCR Hybride**

L'extraction de texte utilise une architecture conçue pour minimiser les coûts tout en maximisant la qualité.

### **TrOCR Fine-tuned (Local)**

> Pour plus de détails sur la pipeline d'ocr : [ocr_pipeline.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/ocr_pipeline.md)

Deux modèles spécialisés pour le français et les polices de manga, sélectionnables directement dans l'interface :

| | **TrOCR Base** | **TrOCR Large** |
|---|---|---|
| **HuggingFace** | [`Remidesbois/trocr-onepiece-fr`](https://huggingface.co/Remidesbois/trocr-onepiece-fr) | [`Remidesbois/trocr-onepiece-fr-large`](https://huggingface.co/Remidesbois/trocr-onepiece-fr-large) |
| **Paramètres** | ~334M | ~558M |
| **Taille ONNX** | ~1.33 Go | ~2.33 Go |
| **CER (brut)** | 2.90% | **1.83%** |
| **WER (brut)** | 9.20% | **6.03%** |
| **Use case** | Appareils modestes, chargement rapide | Meilleure précision, GPU intégré plus puissant |
| **Coût** | 0 $/OCR | 0 $/OCR |

> **Note de compatibilité :** L'OCR local nécessite un navigateur compatible WebGPU (Chrome 113+, Edge, Firefox Nightly).

### **LightOn-OCR "Poneglyph" (Cloud via Modal / Local)**

Nouveau modèle de pointe pour une précision extrême, déployé en mode *serverless* sur **Modal** et disponible en local pour ceux ayant une bonne carte graphique (4Go de VRAM)

* **Modèle :** [`Remidesbois/LightonOCR-2-1b-poneglyph`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph) (Architecture LightOnOCR-2-1B).
* **Modèle ONNX:** [`Remidesbois/LightonOCR-2-1b-poneglyph-onnx`](https://huggingface.co/Remidesbois/LightonOCR-2-1b-poneglyph-onnx).
* **Précision :** CER **< 0.1%** - WER **< 0.1%**.
* **Infrastructure :** Inférence sur GPU **NVIDIA L4** via la plateforme Modal.
* **Usage :** Idéal pour les textes complexes, les onomatopées ou les configurations sans support WebGPU.
* **Optimisation :** Post-processing de troncature automatique pour garantir 0% d'hallucination et un CER et WER effectif de 0%.
* **Coût :** ~0,000222 $ / seconde d'éxécution / 0$ en local.

> LightonOCR reste relativement "lent", surtout sur des machines peu puissantes :
   - 10-15 secondes par bulle sur RTX 500 Ada (équivalent RTX 3050/4050 laptop)
   - 5-8 secondes par bulle sur RTX 3090.
> La vitesse doit pouvoir être optimisé en jouant avec la quantization, je dois faire des tests car 

> Modal offre 30$ de crédit par mois (~37.5h d'inférence), au delà de ce seuil, le service se coupe.

### **YOLO11 Fine-tuned (Détection des bulles)**

Détecte instantanément les bulles sur la planche.

* **Performance :** (Mean Average Precision) mAP50 de **0.994**.
* **Architecture :** YOLO11 Nano Fine-tuned.
* **Exécution :** WebGPU (via ONNX Runtime Web).

### **Modèle de Tri des Bulles**

Une fois les bulles détectées, un modèle spécialisé les trie intelligemment dans le bon ordre de lecture.

> Pour plus de détails sur le modèle de tri : [reading_order_ml.md](https://github.com/remidesbois1/projet-poneglyph/blob/master/documentation/reading_order_ml.md)
> Modèle hébergé sur Hugging Face : [Remidesbois/ReaderNet-V5](https://huggingface.co/Remidesbois/ReaderNet-V5)

| | **Modèle de Tri des Bulles (ReaderNet V5)** |
|---|---|
| **Architecture** | Global-Local (MobileNetV3 + MLP) |
| **Précision (Val)** | **98.0%** |
| **Taille ONNX** | **2.47 MB** (vs 170 MB pour la version précédente) |
| **Exécution** | Local (Web worker) - Infér. unique par page |

### **Google Gemini ~~2.5~~ 3.1 Flash-Lite (Cloud)**

Fallback pour les configurations ne supportant pas WebGPU.

* **Coût :** 500 requêtes gratuites sur le free plan, au delà : 0.00008$ / OCR.
* **Rôle clé :** Gemini 2.5 Flash-Lite a servi en grande partie à générer le corpus de "distillation" pour entraîner les modèles ouverts.

---

## **API Publique V1**

Le projet expose une API sécurisée pour les développeurs.

**Base URL :** `https://api.poneglyph.fr/v1`

| Endpoint | Méthode | Description | Paramètres |
| --- | --- | --- | --- |
| **`/status`** | `GET` | État de l'API | - |
| **`/stats`** | `GET` | Statistiques globales | - |
| **`/series`** | `GET` | Liste des séries | - |
| **`/tomes/:id`** | `GET` | Détails d'un volume | - |
| **`/pages/:id`** | `GET` | Contenu (Image, Bulles, Meta) | - |
| **`/quotes/random`** | `GET` | Citation aléatoire | `?min_length=15` |
| **`/search`** | `GET` | Recherche textuelle | `?q=requete` |

> **Protection :** Les images renvoyées via l'API publique comportent un watermark et une qualité réduite.

---

## **Sécurité & FinOps**

Approche rigoureuse pour maintenir un coût de fonctionnement minimal (**≈ 5 € / mois**).

* **Watermarking dynamique :** Protection des visuels.
* **Confidentialité :** Clés API personnelles stockées en LocalStorage (Optionnel/Admin seulement - Uniquement pour l'OCR/Analyse via Gemini). La recherche sémantique utilise désormais les clés serveur.
* **Edge Computing :** Déport de la charge d'inférence (OCR/Detection) sur le client pour réduire les coûts serveur.

---

## **Pipeline MLOps (Amélioration Continue)**

Les scripts `/script_docker` automatise le cycle de vie des modèle IA :

1. **Extraction :** Récupération des bulles/pages validées (Supabase).
2. **Fine-Tuning :** Entraînement de TrOCR (Base & Large), ~~de FireRed~~, de lightonOCR, et des modèles de détection/tri des bulles, sur les nouvelles données.
3. **Déploiement :** Push automatique vers Hugging Face si les métriques (CER/WER, mAP50) sont validées.

---

## **Installation et Configuration**

### **Prérequis**

* Node.js v18+
* Docker (pour le pipeline MLOps uniquement)

### **Variables d'environnement**

**Backend (`backend/.env.local`)**

```env
PORT=3001
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
SEARCH_PROMPT="..." 
GOOGLE_API_KEY=...
VOYAGE_API_KEY=...

```

**Frontend (`frontend/.env.local`)**

```env
VITE_BACKEND_URL=http://localhost:3001/api
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...

```

### **Démarrage**

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend
cd frontend && npm install && npm run dev

```

## **Avertissement Légal**

> Ce projet est une démonstration technique à but éducatif et de recherche sur l'indexation sémantique et l'IA déportée.
>
> **Engagement de bonne foi :** Afin de respecter les droits d'auteur et de prévenir toute utilisation du service à des fins de lecture illégale, des mesures techniques restrictives ont été implémentées. Les images accessibles publiquement via la plateforme et l'API sont **systématiquement réduites en qualité** et marquées d'un **filigrane (watermark)** visible.
>
> Ces dégradations volontaires garantissent que l'expérience ne peut se substituer à l'achat et à la lecture de l'œuvre originale. Toutes les images utilisées restent la propriété de leurs ayants droit respectifs. Si vous êtes un ayant droit et souhaitez le retrait de contenu, veuillez contacter l'administrateur du dépôt.

---

## **Remerciements**

Un immense merci à **Chip Huyen** pour son ouvrage **"AI Engineering"**. La lecture de son livre a été une source d'inspiration majeure et a fourni des clés méthodologiques essentielles pour l'orchestration, l'optimisation des performances et la mise en place de l'infrastructure hybride de ce projet.

> *AI Engineering by Chip Huyen (O’Reilly). Copyright 2025 Developer Experience Advisory LLC, 978-1-098-16630-4.*
