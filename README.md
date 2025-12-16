## Projet Poneglyph : Indexation de Dialogues One Piece

Le Projet Poneglyph est une plateforme collaborative visant à **numériser intelligemment et indexer l'intégralité des dialogues du manga One Piece**. Elle combine une interface de lecture fluide, un système de contribution communautaire et un pipeline d'IA (OCR) simplifié pour extraire et archiver le texte des bulles.

---

### Stack Technique Détaillée

#### Frontend (Client - SPA)

| Composant | Technologie | Rôle |
| :--- | :--- | :--- |
| **Core** | React 19 & Vite | Application moderne et performante. |
| **Routing** | React Router v7 | Gestion des vues et de la navigation. |
| **UI/UX** | CSS Modules, lucide-react | Style modulaire, kit d'icônes. |
| **Navigation Image** | react-zoom-pan-pinch | Zoom et Pan sur les planches de manga. |
| **État & D&D** | Context API, @dnd-kit | Gestion de l'état global et réorganisation des bulles. |
| **HTTP Client** | Axios (avec intercepteurs) | Requêtes API sécurisées et gestion de l'authentification (JWT). |

#### Backend (API RESTful)

| Composant | Technologie | Rôle |
| :--- | :--- | :--- |
| **Runtime** | Node.js & Express | Serveur API robuste. |
| **Traitement d'Images** | sharp | **Découpage (crop) haute performance** des planches pour l'OCR. |
| **Upload Streaming** | multer + unzipper | Traitement des fichiers `.cbz` / `.zip` volumineux **page par page (streaming)** pour minimiser la surcharge mémoire. |
| **IA / OCR** | Google Generative AI (gemini-flash-lite-latest) | **Transcription textuelle** des bulles de manga. |

#### Infrastructure & Data

| Composant | Technologie | Rôle |
| :--- | :--- | :--- |
| **BaaS** | Supabase (PostgreSQL) | Backend as a Service. |
| **Database** | Supabase (PostgreSQL) | Structure relationnelle pour les données (Tomes > Chapitres > Pages > Bulles). |
| **Storage** | Supabase Storage (Bucket `manga-pages`) | Hébergement des fichiers images des planches. |
| **Auth** | Supabase Auth (JWT) | Gestion sécurisée des utilisateurs et des **rôles (Admin, Modo, User)**. |

---

### Fonctionnalités Clés

#### Pour le Public

* **Bibliothèque :** Navigation fluide par Tomes et Chapitres.
* **Recherche Full-Text :** Moteur de recherche performant pour retrouver n'importe quelle citation.
* **Heatmap :** Visualisation de l'état d'avancement des chapitres (validé, en cours, à faire).

#### Pour les Contributeurs

* **Annotateur Visuel :** Outil de dessin sur canvas pour **délimiter les bulles de texte**. 
* **OCR Assisté par IA :** Utilisation de Google Gemini pour **pré-remplir le texte** de la zone sélectionnée.
* **Clé API Personnelle :** Gestion de la clé Google API côté client pour optimiser les quotas serveur.

#### Pour le Staff (Admins & Modos)

* **Upload CBZ :** Importation massive et automatique de chapitres.
* **Modération :** Interface de **validation/rejet/édition** des bulles et pages.
* **Statistiques :** Suivi des "Top Contributeurs" et système de primes.

---

### Pipeline OCR (Fonctionnement)

1.  **Sélection :** L'utilisateur dessine un rectangle (coordonnées $x, y, w, h$) sur la planche de manga (Frontend).
2.  **Envoi :** Les coordonnées et l'ID de la page sont envoyés à l'API (`POST /api/analyse/bubble`).
3.  **Traitement (Backend) :**
    * Téléchargement de l'image source (Supabase Storage).
    * **Découpage/Crop** de la zone exacte avec `sharp`.
    * Conversion du buffer en format compatible.
4.  **Inférence (IA) :** Envoi de l'image découpée à **Gemini Flash-Lite** avec un prompt système spécifique.
5.  **Réponse :** Le texte transcrit est renvoyé au Frontend pour **validation humaine**.

---

### Installation et Configuration

#### Prérequis

* Node.js (v18+)
* Un projet Supabase (URL + Clés)
* Une clé API Google AI Studio // Non obligatoire

#### 1. Cloner le projet
```bash
git clone https://github.com/votre-repo/projet-one-piece-indexer.git
cd projet-one-piece-indexer
```
#### 2. Configuration Backend
Créer ```backend/.env``` :
```
PORT=3001
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_ANON_KEY=votre-cle-anon
SUPABASE_SERVICE_ROLE_KEY=votre-cle-service-role
```
#### 3. Configuration Frontend
Créer ```frontend/.env.local``` :
```
VITE_BACKEND_URL=http://localhost:3001/api
VITE_SUPABASE_URL=(https://votre-projet.supabase.co
VITE_SUPABASE_ANON_KEY=votre-cle-anon
```
#### 4. Installation des dépendances et Lancement

##### Backend :
```bash
cd backend
npm install
npm run dev
```
### Le serveur démarrera sur http://localhost:3001


##### Frontend :
```bash
cd frontend
npm install
npm run dev
```
### L'application sera accessible sur http://localhost:5173