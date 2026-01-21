# **One Piece Indexer : Projet Poneglyph**

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle du manga One Piece. En combinant l'intelligence artificielle déportée (WebGPU) et une infrastructure auto-hébergée optimisée, le système permet une exploration technique et sémantique approfondie de l'œuvre d'Eiichiro Oda.

Le projet est accessible publiquement à l'adresse suivante (accès invité pour la recherche et la consultation) : [**onepiece-index.com**](https://onepiece-index.com).

## **Architecture Technique**

### **Infrastructure Core**

* **Hébergement :** VPS Cloud (Hetzner CX23 \- 2 vCPU, 4 Go RAM).  
* **Orchestration :** Coolify (Gestion des conteneurs, CI/CD et Reverse Proxy).  
* **Stockage Objets :** Cloudflare R2 pour l'hébergement des planches (compatible S3).  
* **CDN & Sécurité :** Cloudflare (Gestion DNS, protection DDoS et mise en cache).

### **Frontend & IA Cliente**

* **Framework :** React 19 & Vite.  
* **OCR Local :** Florence-2-base exécuté via WebGPU (@xenova/transformers) directement dans le navigateur client.  
* **State Management :** Context API & LocalStorage (persistance locale et sécurisée des clés API utilisateur).

### **Backend & Services de Traitement**

* **Serveur API :** Node.js / Express.  
* **Traitement d'image :** Bibliothèque Sharp (découpage haute performance des zones OCR et prétraitement).  
* **Correction Textuelle :** Conteneur Docker **LanguageTool** (basé sur l'image erikvl87/docker-languagetool) hébergé sur le VPS. Il assure la correction grammaticale et orthographique des sorties de l'OCR local.  
* **Base de Données :** Supabase (PostgreSQL) avec l'extension pgvector pour la recherche vectorielle.  
* **LLM & Embeddings :** Google Gemini 2.5 Flash Lite & gemini-embedding-001.

## **Pipeline d'Extraction (OCR Hybride)**

L'extraction de texte repose sur une architecture hybride conçue pour optimiser le ratio coût/performance tout en garantissant la qualité des données.

### **1\. Mode Local**

Ce mode déporte la charge de calcul sur le client tout en assurant une normalisation côté serveur.

* **Extraction :** Exécution du modèle Florence-2 (Microsoft) via l'API WebGPU du navigateur.  
* **Post-traitement :** Le texte brut est envoyé au backend qui le traite via l'instance locale de LanguageTool et un dictionnaire terminologique spécialisé (noms propres, lieux) pour corriger les erreurs d'OCR et restaurer la casse/accentuation.

### **2\. Mode Cloud**

Ce mode est une alternative pour les utilisateurs ne disposant pas d'accélération graphique matérielle.

* **Moteur :** Utilisation de **Gemini 2.5 Flash Lite** via l'API Google.  
* **Sécurité :** L'appel API est effectué en utilisant la clé API personnelle de l'utilisateur, stockée en LocalStorage. Aucune clé n'est conservée côté serveur.
* **Efficacité** Le résultat est souvent meilleur qu'avec Florence + les différents tweaks (Résultat parfait dans 90% des cas). Mais coûte des crédits de l'API.

## **Moteur de recherche sémantique**

Le système intègre une recherche contextuelle basée sur l'analyse multimodale (texte et image).

### **Indexation et vectorisation**

Chaque page est analysée pour produire un objet structuré, optimisé pour la similarité cosinus.

La génération de ces descriptions est déléguée à Gemini ("Raisonnement") via un prompt strict (Sujet-Verbe-Complément, haute densité de mots-clés, exclusion du bruit visuel). Ce contenu est ensuite vectorisé via gemini-embedding-001 et stocké dans PostgreSQL.

### **Algorithme de recherche**

1. **Vectorisation :** La requête utilisateur est convertie en vecteur (embedding).  
2. **Retrieval :** Recherche par similarité cosinus dans Supabase pour isoler les 6 pages les plus pertinentes.  
3. **Reranking :** Les pages candidates et la requête initiale sont soumises à Gemini 2.5 Flash Lite pour une réévaluation contextuelle et un tri final avant présentation à l'utilisateur.

## **Installation et Configuration**

### **Variables d'environnement Backend (backend/.env)**

```
PORT=3001
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_SERVICE_ROLE_KEY=votre-cle-role
R2_ACCESS_KEY_ID=votre-id-r2
R2_SECRET_ACCESS_KEY=votre-secret-r2
R2_BUCKET_NAME=manga-pages
LANGUAGETOOL_URL=http://localhost:8010/v2
ANALYSIS_PROMPT="Tu es un expert en numérisation de manga. Ta tâche est de transcrire le texte présent dans cette bulle de dialogue.  Règles strictes : 1. Transcris EXACTEMENT le texte visible (OCR). 2. Corrige automatiquement les erreurs mineures d'OCR. 3. Rétablis la casse naturelle. 4. Ne traduis pas. Reste en Français. 5. Renvoie UNIQUEMENT le texte final."
SEARCH_PROMPT="Tu es l'expert ultime de One Piece. Ta mission est de retrouver LA page spécifique recherchée par l'utilisateur parmi des candidats imparfaits. Requête utilisateur : "{{query}}" Règles de notation AGRESSIVES (Polarise tes scores) : 1. **LA PAGE ÉLUE (90-100)** : Correspondance sémantique évidente. Personnage + Action exacte. 2. **LE DOUTE PERMIS (70-85)** : Très forte ressemblance mais pas parfait. 3. **CA POURRAIT, MAIS NON (45-60)** : On pourrait croire, mais pas sûr. 4. **LA SANCTION (< 40)** : - Mauvaise action (ex: cherche "mange", trouve "dort") -> Max 30. - Mauvais personnage -> Max 20. - Décor/Ambiance -> 0. Sois extrêmement agressif. Isole la bonne page du bruit. Renvoie UNIQUEMENT un JSON minifié sans espaces avec les clés "i" (id) et "s" (score) : [{"i":123,"s":95},{"i":456,"s":15}] Candidats : {{candidates}}"
```

### **Variables d'environnement Frontend (frontend/.env.local)**
```
VITE_BACKEND_URL=http://localhost:3001/api
VITE_SUPABASE_URL=https://votre-projet.supabase.co
VITE_SUPABASE_ANON_KEY=votre-cle-anon
```

### **Lancement**

* **Backend :** cd backend && npm install && npm run dev  
* **Frontend :** cd frontend && npm install && npm run dev

## **Analyse des Coûts (Architecture IaaS)**

L'architecture a été pensée pour une efficacité économique maximale (FinOps), en tirant parti des offres gratuites et de l'auto-hébergement des services critiques.

| Composant | Fournisseur | Offre | Coût |
| :--- | :--- | :--- | :--- |
| Serveur VPS | Hetzner | CX21 (4 Go RAM) | ≈ 4,50 € |
| Stockage R2 | Cloudflare | 10 Go Inclus | 0,00 € |
| Base de Données | Supabase | Free Tier | 0,00 € |
| IA / OCR Cloud | Google AI | Free Tier (via User Key) | 0,00 € |
| Correction Texte | Self-hosted | Docker LanguageTool | Inclus VPS |
| **TOTAL** | | | **≈ 4,50 € / mois** |