# Système d'ordre de lecture via Machine Learning (ReaderNet V5)

Ce document détaille le fonctionnement du modèle d'IA dédié au tri des bulles de texte dans les planches de manga. La version **V5** marque le passage à une architecture ultra-légère.

## Architecture du Modèle (ReaderNet V5)

Contrairement aux versions précédentes qui analysaient des images de paires de bulles, la V5 sépare la vision de la page et la géométrie des bulles pour une efficacité maximale.

- **Entrée Visuelle (Global)** : Tenseur de `(1, 1, 256, 384)`
  - 1 canal Grayscale (image de la page entière).
  - Redimensionnement : Letterbox de hauteur 256px, centrée horizontalement sur 384px (adapté aux doubles pages).
- **Entrée Géométrique (Local)** : Vecteur de `(1, 12)` par paire (A, B)
  - Coordonnées normalisées [0-1] de la Bulle A et de la Bulle B (X, Y, W, H).
  - Vecteurs relatifs : ΔX, ΔY, Distance Euclidienne, Angle (en π).
- **Backbone** : Architecture de type **MobileNetV3 / Inverted Residuals** (légère et rapide).
- **Head** : MLP (Multi-Layer Perceptron) combinant les features visuelles (128D) et géométriques (12D).
- **Sortie** : Valeur scalaire (Logit) transformée en probabilité via Sigmoid (Probabilité que A soit lu avant B).

## Processus d'Entraînement

### Dataset (V5)
- **Pages** : ~388 planches annotées.
- **Paires** : ~33 200 combinaisons de paires (+1.3% vs V4).
- **Augmentation** : Grayscale, ColorJitter, Random Noise.

### Métriques de Performance
- **Validation Accuracy (V5)** : **98.0%**
- **Poids ONNX** : **2.47 MB** (vs 170 MB en V4, soit **70x plus léger**)
- **Parameters** : ~618 209 (vs 44 millions en V4)

## Avantages de la V5

1. **Vitesse Web** : Le Backbone CNN (le plus lourd) est exécuté une seule fois par page. L'inférence sur les paires n'est plus qu'un calcul matriciel (MLP) quasi instantané.
2. **Légèreté** : Le modèle est téléchargé instantanément sur mobile/navigateur.
3. **Optimisation** : Prétraitement en niveaux de gris pour économiser 3x la RAM GPU du client.

## Fonctionnement du Tri

1. **Inference Globale** : Le modèle extrait les "Features" de la page (les cases et gouttières) une seule fois.
2. **Calcul de Paires** : Pour chaque paire (A, B), le modèle combine les Features de la page avec les vecteurs géométriques de A et B.
3. **Scoring** : Calcul de la probabilité de lecture A -> B.
4. **Tri** : Classement final des bulles par score de priorité.
