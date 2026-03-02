# **Projet Poneglyph**

![Status](https://img.shields.io/badge/Status-Live-success?style=for-the-badge)
![WebGPU](https://img.shields.io/badge/WebGPU-Enabled-8A2BE2?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle de mangas et bandes dessinées. En combinant l'intelligence artificielle déportée (**WebGPU**) et une infrastructure hybride optimisée, le système permet une exploration inédite des oeuvres.

**Accès Public (Mode Invité pour la Consultation et la Recherche) :** [**poneglyph.fr**](https://poneglyph.fr)

---

### **Infrastructure Core**

* **Hébergement :** VPS Cloud (Hetzner CX23 - 2 vCPU, 4 Go RAM).
* **Orchestration :** Coolify (Gestion des conteneurs, CI/CD et Reverse Proxy).
* **Stockage Objets :** Cloudflare R2 pour l'hébergement des planches (compatible S3).
* **CDN & Sécurité :** Cloudflare (Gestion DNS, protection DDoS et mise en cache).

### **Frontend & IA (Edge)**

* **Framework :** React 19 / Next.js & Vite.
* **CSS** : [ShadCn UI](https://ui.shadcn.com/)
* **OCR Local :** **TrOCR Fine-tuned** (Base & Large) exécuté via WebGPU (`@huggingface/transformers`) directement dans le navigateur.
* **Détection de Bulles Locale :** **YOLO V8 Medium Fine-tuned** [`Remidesbois/YoloPiece_BubbleDetector`](https://huggingface.co/Remidesbois/YoloPiece_BubbleDetector) exécuté via WebGPU.
* **State Management :** Context API & LocalStorage.

### **Backend & Services (Cloud)**

* **Serveur API :** Node.js / Express.
* **Base de Données :** Supabase (PostgreSQL) avec l'extension **pgvector**.
* **LLM & Embeddings :** Google Gemini 2.5 Flash-Lite & Voyage AI (`voyage-4-large`).

---

## **Moteur de Recherche Multi-Modal**

L'indexer propose deux expériences de recherche distinctes :

### **1. Recherche par Mots-Clés**

* Recherche instantanée via *full-text search* PostgreSQL.
* Indexation précise au niveau de chaque bulle de dialogue.

### **2. Recherche Sémantique & Conceptuelle**

L'Indexer utilise une architecture de recherche hybride et parallélisée pour une précision maximale :

* **Normalisation (Gemini) :** Réécriture de la requête de l'utilisateur par Gemini 2.5 Flash-Lite pour corriger les fautes et standardiser les noms de personnages.
* **Récupération Parallèle :** 
    * Vectorisation simultanée par **Voyage AI** (`voyage-4-large`) et **Gemini** (gemini-embedding-001).
    * Bonus de score (**1.15x**) appliqué aux pages identifiées par les deux moteurs pour prioriser le consensus.
* **Reranking LLM :** Validation finale de la pertinence par un LLM (Gemini 2.5 Flash-Lite) ou un reranker dédié.
* **Filtrage Multicritère :** Arcs narratifs, personnages, volumes et mangas.

> En cas de clé API manquante, le système utilise uniquement Voyage AI à travers la clé côté serveur.

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
| **Use case** | Appareils modestes, chargement rapide | Précision maximale, GPU récent |
| **Coût** | 0 $/OCR | 0 $/OCR |

> **Note de compatibilité :** L'OCR local nécessite un navigateur compatible WebGPU (Chrome 113+, Edge, Firefox Nightly).

### **YOLO V8 Fine-tuned (Détection)**

Détecte instantanément les zones de texte sur la planche.

* **Performance :** (Mean Average Precision) mAP50 de **0.97**.
* **Exécution :** WebGPU (via ONNX Runtime Web).

### **Google Gemini 2.5 Flash-Lite (Cloud)**

Fallback pour les configurations ne supportant pas WebGPU.

* **Coût :** ~0,00004 $ / OCR.
* **Rôle clé :** A servi à générer le corpus de "distillation" pour entraîner les modèles TrOCR locaux.

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

Approche rigoureuse pour maintenir un coût de fonctionnement minimal (**≈ 4.50 € / mois**).

* **Watermarking dynamique :** Protection des visuels.
* **Confidentialité :** Clés API personnelles stockées uniquement en LocalStorage.
* **Edge Computing :** Déport de la charge d'inférence (OCR/Detection) sur le client pour réduire les coûts serveur.

---

## **Pipeline MLOps (Amélioration Continue)**

Le script `/script_docker` automatise le cycle de vie du modèle IA :

1. **Extraction :** Récupération des bulles validées (Supabase).
2. **Fine-Tuning :** Entraînement incrémental de TrOCR (Base & Large) sur les nouvelles données.
3. **Déploiement :** Push automatique vers Hugging Face (`Remidesbois/trocr-onepiece-fr` et `Remidesbois/trocr-onepiece-fr-large`) si les métriques (CER/WER) sont validées.

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

---

## **Roadmap**

* [x] Recherche Vectorielle & Sémantique
* [x] Inférence locale WebGPU (OCR + YOLO)
* [x] Pipeline MLOps automatisé
* [ ] Support multilingue (Anglais)
* [ ] Fine-tuning de modèles pour d'autres œuvres (Naruto, Berserk, Dragon Ball)

---

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
