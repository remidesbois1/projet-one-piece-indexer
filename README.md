# Projet Poneglyph : Indexation Textuelle de One Piece

Notre mission : déchiffrer et archiver chaque mot prononcé au cours de la plus grande épopée pirate de notre temps.

Ce projet est une application web collaborative conçue pour créer une base de données textuelle complète et interrogeable de l'édition française officielle du manga **ONE PIECE**. L'objectif final est de permettre la recherche ultra-précise et l'analyse statistique sur l'intégralité de l'œuvre.

***

## 🗺️ Table des Matières

- ✨ Fonctionnalités Clés
- 🚀 Installation et Lancement Local
- 🌊 Workflow de Développement
- 🧭 Prochaines Étapes

***

## ✨ Fonctionnalités Clés

L'application est divisée en plusieurs sections pour différents types d'utilisateurs.

### Pour les Contributeurs (Utilisateurs)

- **Annotation Visuelle** : Une interface intuitive permet de dessiner un rectangle sur une page de manga pour définir une bulle de texte.
- **Flux de Soumission Intelligent** : Le système analyse la zone (actuellement simulé) et propose un texte. L'utilisateur valide ou corrige ce texte avant de le soumettre pour modération.
- **Suivi des Contributions** : Une page "Mes Soumissions" permet à chaque utilisateur de voir l'état de ses propositions (**Proposé, Validé, Rejeté**).
- **Organisation des Bulles** : Possibilité de réorganiser par glisser-déposer l'ordre des bulles sur une page pour qu'il corresponde à l'ordre de lecture.

### Pour la Communauté (Public)

- **Recherche "Full-Text"** : Un moteur de recherche performant et paginé pour retrouver n'importe quelle phrase dans tous les dialogues validés de l'œuvre.
- **Tableau de Primes** : Une page de statistiques thématique qui classe les meilleurs contributeurs comme des pirates avec des "**primes**" basées sur leur nombre de contributions.

### Pour l'Équipage (Modérateurs & Admins)

- **Modération de Bulles** : Une interface dédiée pour valider ou rejeter les soumissions individuelles, avec un aperçu de l'image découpée pour une vérification rapide.
- **Modération de Pages** : Un flux de travail complet permettant aux utilisateurs de soumettre une page entière pour vérification, et aux modérateurs de l'approuver ou de la rejeter.
- **Dashboard Admin** :
    - Création manuelle de Tomes.
    - Création automatisée de Chapitres et de Pages via l'upload d'un fichier **.cbz**, avec analyse de la nomenclature des fichiers (CHXXXX_PXXX.jpg).

***

## 🚀 Installation et Lancement Local

### Prérequis

- **Node.js** (v18+ recommandé)
- **Git**
- Un compte **Supabase**

### 1. Configuration de Supabase

1. Créez un nouveau projet.
2. Allez dans **SQL Editor** et exécutez l'intégralité du script SQL `schema.sql` (à créer, contenant toutes les commandes `CREATE TABLE`, `CREATE FUNCTION`, `ALTER TABLE`...).
3. Allez dans **Project Settings > API**. Gardez cette page ouverte, vous aurez besoin des clés.

### 2. Installation du Projet

```bash
git clone [repository_url]
cd [project_folder]/frontend
npm install
cd [project_folder]/backend
npm install