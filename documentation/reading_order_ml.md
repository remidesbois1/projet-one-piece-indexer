# Système d'ordre de lecture via Machine Learning

Ce document détaille le fonctionnement du modèle d'IA dédié au tri chronologique des bulles de texte dans les planches de manga.

## Architecture du Modèle

Le modèle est un **CNN (Convolutional Neural Network)** spécialisé dans la comparaison de paires de bulles.

- **Entrée** : Tenseur de `(7, 256, 256)`
  - 3 canaux RGB (image de la page).
  - 2 canaux Masques (Bulle A et Bulle B).
  - 2 canaux **CoordConv** (Coordonnées X et Y normalisées de -1 à 1).
- **Backbone** : Architecture de type **ResNet** (Blocs Résiduels) pour une extraction de caractéristiques profonde.
- **Innovation Spatiale** : Utilisation de `AdaptiveAvgPool2d(8)`. 
  - *Pourquoi ?* On garde une grille de 8x8 (64 zones). Cela permet au modèle de conserver une précision chirurgicale sur la topologie.
- **Sortie** : Valeur scalaire entre 0 et 1 via Sigmoid (Probabilité que A soit lu avant B).

## Processus d'Entraînement

### Dataset
- **Pages** : ~273 planches de One Piece annotées.
- **Paires** : ~26 000 combinaisons de paires générées.
- **Augmentation** : ColorJitter (luminosité, contraste) pour la robustesse.

### Métriques de Performance
- **Accuracy (Validation)** : **98.3%**
- **Loss** : ~0.0001
- **Taille ONNX** : **~170 MB**

## Fonctionnement du Tri (Algorithme)

1. **Extraction** : Pour chaque paire possible de bulles (A, B) sur une page.
2. **Inférence** : Le modèle prédit si A est lu avant B.
3. **Score Global** : On calcule un score de "priorité" pour chaque bulle en fonction de ses victoires face aux autres.
4. **Tri** : Les bulles sont triées par score décroissant.
