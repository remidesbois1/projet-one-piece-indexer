# **One Piece Indexer : Projet Poneglyph**

Le **Projet Poneglyph** est une plateforme de haute performance dédiée à la numérisation, l'indexation sémantique et la recherche contextuelle du manga One Piece. En combinant l'intelligence artificielle déportée (WebGPU) et une infrastructure auto-hébergée optimisée, le système permet une exploration sans précédent de l'œuvre d'Eiichiro Oda.

## **🛠 Stack Technique**

### **Core Infrastructure**

* **Hébergement :** VPS Cloud (Hetzner CX23 \- 2 vCPU, 4 Go RAM).  
* **Orchestration :** **Coolify** (Gestion des conteneurs, CI/CD, et Reverse Proxy).  
* **Stockage Objets :** **Cloudflare R2** (10 Go Free Tier) pour l'hébergement des planches.  
* **CDN & Sécurité :** **Cloudflare** (Gestion DNS, protection DDoS et mise en cache agressive).

### **Frontend & IA Cliente**

* **Framework :** React 19 & Vite.  
* **Local OCR :** Florence-2-base via **WebGPU** (@xenova/transformers).  
* **Traitement de texte :** Layer de post-traitement personnalisé (dictionnaire de correction pour les accents et la casse).  
* **State Management :** Context API & LocalStorage (persistence des clés API utilisateur).

### **Backend & Données**

* **Serveur :** Node.js / Express.  
* **Traitement Image :** sharp (découpage haute performance des zones OCR).  
* **Base de Données :** **Supabase (PostgreSQL)** avec l'extension pgvector.  
* **LLM & Embeddings :** Google Gemini 2.5 Flash Lite & gemini-embedding-001.

## **🧠 Pipeline d'Extraction (OCR Hybride)**

L'extraction de texte repose sur une approche hybride permettant de garantir la gratuité et la rapidité du service.

### **1\. Mode Local**

Exécution directe dans le navigateur via l'API **WebGPU**.

* **Modèle :** Florence-2 (Microsoft).  
* **Post-traitement :** Un algorithme de comparaison avec un dictionnaire spécialisé intervient pour restaurer les accents et normaliser la casse, compensant les faiblesses natives du modèle sur la langue française.

### **2\. Mode Cloud**

Utilisation de **Gemini 2.5 Flash Lite** via l'API Google (utilisant la clé API stockée en LocalStorage de l'utilisateur). Ce mode est activable pour les cas complexes ou si l'utilisateur n'a pas de GPU.

## **🔍 Moteur de Recherche Sémantique**

Le projet intègre un système de recherche contextuelle basé sur l'analyse visuelle des planches.

### **Indexation des Pages**

Chaque page est associée à un objet JSON de métadonnées :

```{  
  "content": "Description textuelle détaillée de la scène et des dialogues...",  
  "metadata": {  
    "arc": "Romance Dawn",  
    "characters": \["Luffy", "Shanks"\]
  }  
}
```

Ce contenu est vectorisé via gemini-embedding-001 et stocké dans Supabase (pgvector).

Les descriptions sont générées à l'aide d'un prompt spécifiquement rédigé pour créer une description favorisant la similarité cosinus, et est envoyé manuellement à Gemini 3 "Raisonnement" avec l'image pour obtenir une description adaptée : 

```Analyse cette page de One Piece. Ton but est de générer un objet JSON optimisé pour la similarité cosinus. La description doit être dense, directe et centrée sur l'action principale pour maximiser les scores de correspondance.

Schéma de sortie attendu : JSON
{"content": "Action principale. Détails de l'événement et contexte immédiat. Éléments de lore.","metadata": {"arc": "Nom de l'arc","characters": ["Liste des personnages"]}}
Règles de rédaction pour 'content' (Priorité Recherche) :
- Accroche Directe : Commence la première phrase par l'action ou l'événement exact (ex: "Exécution de Gol D. Roger" ou "Combat entre Luffy et Kaido"). C'est ce qui "ancre" le vecteur.
- Sujet-Verbe-Complément : Utilise des phrases simples et factuelles. Évite les métaphores ou les envolées lyriques.
- Mots-Clés de Haute Densité : Utilise les termes que les fans taperaient (ex: 'Haki des Rois', 'Fruit du Démon', 'Gear 5', 'Échafaud').
- Suppression du Bruit : Ne décris PAS les conséquences à long terme (ex: "cela change le monde"), décris uniquement ce qui est visible sur la page.
- Zéro Technique : Aucun mot sur le dessin (hachures, angles, traits).
Réponds uniquement en JSON.
```

### **Processus de Recherche Sémantique**

1. **Vectorisation :** La requête de l'utilisateur est convertie en vecteur.  
2. **Similarité :** Le système effectue une recherche par similarité cosinus pour extraire les 10 pages les plus pertinentes.  
3. **Reranking :** La requête et le contenu des 10 pages sélectionnées sont envoyés à **Gemini 2.5 Flash Lite** pour ré-analyser la pertinence et fournir le résultat exact à l'utilisateur.

## **📦 Installation et Configuration**

### **Configuration Backend (backend/.env)**
```
PORT=3001  
SUPABASE\_URL=\[https://votre-projet.supabase.co\](https://votre-projet.supabase.co)  
SUPABASE\_SERVICE\_ROLE\_KEY=votre-cle-role  
R2\_ACCESS\_KEY\_ID=votre-id-r2  
R2\_SECRET\_ACCESS\_KEY=votre-secret-r2  
R2\_BUCKET\_NAME=manga-pages
```
### **Configuration Frontend (frontend/.env.local)**
```
VITE\_BACKEND\_URL=http://localhost:3001/api  
VITE\_SUPABASE\_URL=\[https://votre-projet.supabase.co\](https://votre-projet.supabase.co)  
VITE\_SUPABASE\_ANON\_KEY=votre-cle-anon
```
### **Lancement**

1. **Backend :** `cd backend && npm install && npm run dev`  
2. **Frontend :** `cd frontend && npm install && npm run dev`

## **📈 Budget Prévisionnel Mensuel**

Grâce à l'architecture IaaS et à l'utilisation intelligente des tiers gratuits, les coûts sont maintenus au strict minimum.

| Composant | Fournisseur | Offre | Coût |
| :--- | :--- | :--- | :--- |
| Serveur VPS | Hetzner | CX21 (4 Go RAM) | ≈ 4,50 € |
| Stockage R2 | Cloudflare | 10 Go Inclus | 0,00 € |
| Base de Données | Supabase | Free Tier | 0,00 € |
| IA / OCR | Google AI | Free Tier (via User Key) | 0,00 € |
| **TOTAL** | | | **≈ 4,50 € / mois** |

**Sécurité :** Les clés API personnelles (Google Gemini) sont stockées localement dans le navigateur des contributeurs. Elles ne sont jamais stockées sur nos serveurs.
