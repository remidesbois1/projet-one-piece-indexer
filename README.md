# **Projet Poneglyph**

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle de mangas et bandes dessinées. En combinant l'intelligence artificielle déportée (WebGPU) et une infrastructure hybride optimisée, le système permet une exploration technique et sémantique inédite du neuvième art.

Le projet est accessible publiquement à l'adresse suivante (accès invité pour la recherche et la consultation) : [**poneglyph.fr**](https://poneglyph.fr).

## **Architecture Technique**

### **Infrastructure Core**

* **Hébergement :** VPS Cloud (Hetzner CX23 - 2 vCPU, 4 Go RAM).
* **Orchestration :** Coolify (Gestion des conteneurs, CI/CD et Reverse Proxy).
* **Stockage Objets :** Cloudflare R2 pour l'hébergement des planches (compatible S3).
* **CDN & Sécurité :** Cloudflare (Gestion DNS, protection DDoS et mise en cache).

### **Frontend & IA**

* **Framework :** React 19 / Next.js & Vite.
* **OCR Local :** **TrOCR Fine-tuned** (Remidesbois/trocr-onepiece-fr) exécuté via WebGPU (@xenova/transformers) directement dans le navigateur.
* **Détection de Bulles Locale :** **YOLO V8 Medium Fine-tuned** (Remidesbois/YoloPiece_BubbleDetector) exécuté via WebGPU pour une détection ultra-précise et rapide directement dans le navigateur.

* **State Management :** Context API & LocalStorage (persistance locale des clés API utilisateur).

### **Backend & Services**

* **Serveur API :** Node.js / Express.
* **Base de Données :** Supabase (PostgreSQL) avec l'extension **pgvector** pour la recherche vectorielle.
* **LLM & Embeddings :** Google Gemini 2.5 Flash-Lite & Voyage AI (voyage-4-large).

---

## **Moteur de Recherche Multi-Modal**

L'indexer propose deux expériences de recherche :

### **1. Recherche par Mots-Clés**
* Recherche instantanée via full-text search PostgreSQL.
* Indexation précise au niveau de chaque bulle de dialogue.

### **2. Recherche Sémantique & Conceptuelle**
* **Vecteurs :** Conversion des requêtes en vecteurs via Voyage AI (voyage-4-large) et comparaison cosinus avec les vecteurs stockés dans la base de données.
* **Mode Invité :** La recherche sémantique est accessible à tous. Le reranking est effectué côté serveur via Voyage AI pour une précision optimale.
* **Filtrage Multicritère :** Possibilité de filtrer par titres, arcs narratifs, personnages identifiés et numéros de volumes.
* **Reranking :**
    * **Cloud :** Utilisation du modèle **rerank-2.5** de Voyage AI pour réordonner les résultats sémantiques avec une grande précision.

### **3. Système de Feedback**
* Thumbs Up/Down sur chaque résultat de recherche pour collecter des données de pertinence.
* Objectif : Entraînement futur d'un modèle de reranking spécialisé.

---

## **API Publique V1**

Le projet expose une API publique sécurisée et gratuite. Elle permet d'accéder aux données indexées (tomes, chapitres, pages, bulles), pour construire des applications tierces (bots, statistiques, outils d'analyse).

**Base URL :** `https://api.poneglyph.fr/v1`

| Endpoint | Méthode | Description | Paramètres |
| :--- | :---: | :--- | :--- |
| **`/status`** | `GET` | Vérifie l'état de l'API | - |
| **`/stats`** | `GET` | Statistiques globales (Œuvres, Tomes, Pages, Bulles) | - |
| **`/series`** | `GET` | Liste toutes les séries disponibles | - |
| **`/tomes/:id`** | `GET` | Détails d'un volume spécifique | - |
| **`/pages/:id`** | `GET` | Contenu d'une page (Image, Bulles, Métadonnées) | - |
| **`/quotes/random`** | `GET` | Retourne une citation au hasard | `?min_length=15` |
| **`/search`** | `GET` | Recherche textuelle simple dans les bulles | `?q=requete` |

> **Note :** Les images renvoyées via l'API publique comportent automatiquement un watermark et une qualité réduite pour prévenir l'utilisation du service à des fins de lecture illégale.

---

## **Pipeline d'OCR Hybride**

L'extraction de texte repose sur une architecture conçue pour minimiser les coûts tout en maximisant la qualité, adaptée aux spécificités de la BD et du Manga.

### **TrOCR Fine-tuned (Local)**
Ce modèle spécialisé (`Remidesbois/trocr-onepiece-fr`) est optimisé pour le français et particulièrement les polices d'écriture de One Piece.
* **Coût :** 0 $ / OCR
* **Latence :** 0.5-5 secondes / OCR (dépend de la puissance GPU client)
* **Métriques :** CER (Character Error Rate) de **2.90%** et WER (Word Error Rate) de **9.2%**.
* **Avantage :** Excellente gestion des déformations de texte et des styles de bulles variés.

> **Note :** Ce modèle spécifique a été entraîné sur des bulles de One Piece. Des modèles spécialisés pour d'autres licences majeures seront intégrés ultérieurement pour garantir une précision optimale sur chaque style graphique.

### **YOLO V8 Fine-tuned (Détection)**
Détecte instantanément les zones de texte sur la planche avant le passage de l'OCR.
* **Architecture :** YOLOv8/11 Medium exporté en ONNX.
* **Exécution :** WebGPU (via ONNX Runtime Web).
* **Performance :** mAP50 de 0.97, capable d'isoler le texte du dessin de fond.

> **Note :** Comme le modèle d'OCR, le détecteur de bulles a été principalement entraîné sur One Piece. Ses résultats restent pertinents sur d'autres mangas, mais des modèles spécialisés par oeuvre sont prévus.

### **Google Gemini 2.5 Flash-Lite (Cloud)**
Alternative à TrOCR pour les configurations ne supportant pas WebGPU.
* **Coût :** ~0,00004 $ / OCR
* **Qualité :** Précision quasi-parfaite (99%) grâce à la compréhension contextuelle du LLM.

> **Note :** C'est grâce à la précision exceptionnelle de Gemini que j'ai pu générer un corpus de données d'entraînement suffisant et fiable. Ce processus de "distillation" a permis d'entraîner le modèle TrOCR local pour qu'il atteigne des performances proches du cloud sans en supporter les coûts récurrents.

---

## **Sécurité & FinOps**

Le projet est conçu avec une approche **FinOps** pour maintenir un coût de fonctionnement minimal (≈ 4.50 € / mois).

* **Watermarking dynamique :** Protection automatique des visuels pour encourager l'achat des œuvres originales.
* **Confidentialité des clés :** Les clés API personnelles restent dans le LocalStorage de l'utilisateur.
* **Edge Computing :** Déportation maximale de la charge d'inférence IA sur le matériel de l'utilisateur final.

---

## **Pipeline de Fine-Tuning continu (MLOps)**

Le projet inclut un système d'amélioration continue du modèle d'OCR pour s'adapter dynamiquement aux nouvelles données indexées.

### **Automatisation Docker**
Un script dédié est disponible dans le répertoire `/script_docker` pour lancer un container Docker optimisé pour l'entraînement :
* **Extraction :** Récupère automatiquement les dernières bulles validées depuis la base de données Supabase.
* **Fine-Tuning :** Lance un entraînement incrémental du modèle **TrOCR** sur les nouvelles données.
* **Publication :** Une fois l'entraînement terminé et les métriques validées (CER/WER), le modèle est automatiquement poussé vers le **Hugging Face Hub** (`Remidesbois/trocr-onepiece-fr`).

Cette approche permet au projet de gagner en précision au fur et à mesure que la communauté valide ou corrige les transcriptions via l'interface d'édition.

## **Installation et Configuration**

### **Variables d'environnement Backend (`backend/.env.local`)**
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

### **Variables d'environnement Frontend (`frontend/.env.local`)**

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

## **Remerciements Spéciaux**

Un immense merci à **Chip Huyen** pour son ouvrage **"AI Engineering"**. La lecture de son livre a été une source d'inspiration majeure et a fourni des clés méthodologiques essentielles pour l'orchestration, l'optimisation des performances et la mise en place de l'infrastructure hybride de ce projet.
> *AI Engineering by Chip Huyen (O’Reilly). Copyright 2025 Developer Experience Advisory LLC, 978-1-098-16630-4.*
