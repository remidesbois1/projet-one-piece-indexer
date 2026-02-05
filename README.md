# **One Piece Indexer : Projet Poneglyph**

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle du manga One Piece. En combinant l'intelligence artificielle déportée (WebGPU) et une infrastructure hybride optimisée, le système permet une exploration technique et sémantique inédite de l'œuvre d'Eiichiro Oda.

Le projet est accessible publiquement à l'adresse suivante (accès invité pour la recherche et la consultation) : [**onepiece-index.com**](https://onepiece-index.com).

## **Architecture Technique**

### **Infrastructure Core**

* **Hébergement :** VPS Cloud (Hetzner CX23 \- 2 vCPU, 4 Go RAM).
* **Orchestration :** Coolify (Gestion des conteneurs, CI/CD et Reverse Proxy).
* **Stockage Objets :** Cloudflare R2 pour l'hébergement des planches (compatible S3).
* **CDN & Sécurité :** Cloudflare (Gestion DNS, protection DDoS et mise en cache).

### **Frontend & IA**

* **Framework :** React 19 / Next.js & Vite.
* **OCR Local :** **Florence-2-base Fine-tuned** (Remidesbois/florence2-onepiece-ocr) exécuté via WebGPU (@xenova/transformers) directement dans le navigateur.
* **Détection de Bulles Locale :** **YOLO V8 Medium Fine-tuned** (Remidesbois/YoloPiece_BubbleDetector) exécuté via WebGPU pour une détection ultra-précise et rapide directement dans le navigateur.
* **Reranking Local :** **mxbai-rerank-base-v1** (Mixedbread AI) via WebGPU pour une pertinence de recherche maximale sans coût serveur.
* **State Management :** Context API & LocalStorage (persistance locale des clés API utilisateur).

### **Backend & Services**

* **Serveur API :** Node.js / Express.
* **Base de Données :** Supabase (PostgreSQL) avec l'extension **pgvector** pour la recherche vectorielle.
* **LLM & Embeddings :** Google Gemini 2.5 Flash-Lite & gemini-embedding-001.

---

## **Moteur de Recherche Multi-Modal**

L'indexer propose deux expériences de recherche complémentaires :

### **1. Recherche par Mots-Clés**
* Recherche instantanée via full-text search PostgreSQL.
* Indexation précise au niveau de chaque bulle de dialogue.

### **2. Recherche Sémantique & Conceptuelle**
* **Vecteurs :** Conversion des requêtes en vecteurs via Gemini Embeddings et comparaison cosinus avec les vecteurs stockés dans la base de données.
* **Mode Invité :** La recherche sémantique est accessible à tous via une clé d'API serveur. Le **Reranking Local** (WebGPU) est également disponible pour les invités, tandis que le **Reranking Cloud** (Gemini) nécessite une clé API personnelle.
* **Filtrage Multicritère :** Possibilité de filtrer par personnages (Luffy, Zoro, Kaido...), arc narratif (Romance Dawn, Wano, Marineford...) et numéro de tome.
* **Reranking Hybride :**
    * **Cloud :** Utilisation de Gemini 2.5 Flash Lite pour trier les résultats selon le contexte exact.
    * **Local :** Utilisation du modèle Mixedbread via WebGPU pour le reranking des résultats gratuitement.

### **3. Système de Feedback**
* Thumbs Up/Down sur chaque résultat de recherche pour collecter des données de pertinence.
* Objectif : Fine-tuning futur d'un modèle de ranking spécialisé pour One Piece.

---

## **API Publique V1 (Gratuite & Ouverte)**

Le projet expose une API publique sécurisée et gratuite pour la communauté de développeurs. Elle permet d'accéder aux données indexées (tomes, chapitres, pages, bulles), pour construire des applications tierces (bots, stats, ...).

**Base URL :** `https://api.onepiece-index.com/v1`

| Endpoint | Méthode | Description | Paramètres |
| :--- | :---: | :--- | :--- |
| **`/status`** | `GET` | Vérifie l'état de l'API | - |
| **`/stats`** | `GET` | Statistiques globales (Tomes, Chapitres, Pages, Bulles) | - |
| **`/tomes`** | `GET` | Liste tous les tomes disponibles | - |
| **`/tomes/:num/chapters`** | `GET` | Liste les chapitres d'un tome spécifique | - |
| **`/chapters/:num`** | `GET` | Détails d'un chapitre (Titre, Tome, Stats) | - |
| **`/chapters/:num/pages/:p`**| `GET` | Contenu d'une page (Image, Bulles, Arc, Persos) | - |
| **`/quotes/random`** | `GET` | Retourne une citation (bulle) au hasard | `?min_length=15` |
| **`/search`** | `GET` | Recherche textuelle simple dans les bulles | `?q=luffy` |

> **Note :** Les images renvoyées via l'API publique comportent automatiquement un watermark pour désencourager le piratage.

---

## **Pipeline d'OCR Hybride**

L'extraction de texte repose sur une architecture conçue pour minimiser les coûts tout en maximisant la qualité. Elle offre le choix entre deux modèles d'OCR :

### **Florence-2 Fine-tuned (Local)**
Ce modèle spécialisé (`Remidesbois/florence2-onepiece-ocr`) capture la typographie spécifique de One Piece.
* **Coût :** 0 $ / OCR
* **Latence :** 1-5 secondes / OCR (suivant la puissance de la carte graphique de l'utilisateur)
* **Entraînement :** Fine-tuned sur 600 bulles de dialogue.
* **Métriques :** CER de 3.13% (contre 78.77% pour le modèle de base), soit une amélioration de +75 pts.

### **YOLO V8 Fine-tuned (Détection)**
Ce modèle spécialisé (`Remidesbois/YoloPiece_BubbleDetector`) détecte instantanément les bulles de dialogue sur la page avant l'OCR.
* **Architecture :** YOLOv8/11 Medium exporté en ONNX.
* **Exécution :** WebGPU (via ONNX Runtime Web).
* **Entraînement :** Fine-tuned sur 1500 planches anotées manuellement.
* **Performance :** mAP50 de 0.97, capable d'ignorer les cases et de ne capturer que le texte.

### **Google Gemini 2.5 Flash-Lite (Cloud)**
Ce modèle est utilisé en alternative à Florence-2 pour les utilisateurs ne disposant pas d'une carte graphique compatible WebGPU.
* **Coût :** ~0,00004 $ / OCR
* **Latence :** 1-2 secondes / OCR
* **Qualité :** 99% de précision : Gemini est excellent pour l'OCR des bulles.


### **Éditeur de Métadonnées Avancé**
* **Toggle JSON/Formulaire :** Interface flexible pour l'édition des descriptions.
* **Génération de descriptions adaptées :** Utilisation de Gemini-3-Flash pour générer des descriptions denses en mots-clés et contextuelles à partir de l'image.
* **Coût :** 0,00328 $ / description
* **Latence :** 4-8 secondes / description
* **Glossaire Intelligent :** Correction automatique des noms propres via un glossaire intégré.

---

## **Sécurité & FinOps**

Le projet est conçu avec une approche **FinOps** pour maintenir un coût de fonctionnement minimal (≈ 4.50 € / mois).

* **Watermarking Dynamique :** Les images originales sont protégées par un watermark automatique pour les utilisateurs non connectés, pour décourager l'utilisation du site comme une plateforme de lecture illégale.
* **Pas de Rétention de Clés :** Les clés API Google des utilisateurs sont stockées uniquement dans leur navigateur (LocalStorage).
* **Architecture Serverless-First :** Déportation maximale de l'intelligence artificielle côté client.

---

## **Installation et Configuration**

### **Variables d'environnement Backend (`backend/.env.local`)**
```env
PORT=3001
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
LANGUAGETOOL_URL=...
SEARCH_PROMPT="..." # Prompt expert pour le reranking
GOOGLE_API_KEY=... # Clé API globale pour la recherche sémantique (mode invité)
```

> [!TIP]
> Si vous restreignez votre `GOOGLE_API_KEY` par IP, utilisez l'adresse IP publique de votre serveur backend (et non celle de Cloudflare), car les requêtes vers l'API Gemini sont émises directement par le serveur Node.js.

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

## **Contributeurs**
Développé avec passion pour la communauté One Piece. Toute contribution ou retour sur l'exactitude de l'OCR est la bienvenue !
