# Pipeline OCR : Découpage Multi-Lignes & Post-Traitement

## Problématique

TrOCR est un modèle conçu pour la **reconnaissance de texte single-line**. L'encoder ViT resize l'image à 384×384 pixels. Quand une bulle contient plusieurs lignes, le texte devient trop petit et le modèle **saute des lignes entières**.

## Architecture

```
Bulle (image brute)
  │
  ▼
┌─────────────────────┐
│  getImageInfo()     │  Extrait les pixels RGBA via OffscreenCanvas
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  splitIntoLines()   │  Projection horizontale → détection des gaps
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     │           │
  1 ligne    N lignes
     │           │
     ▼           ▼
  TrOCR      ┌──────────────────┐
  normal     │  cropLineFromBlob() × N  │  Découpe chaque ligne
             └──────────┬───────┘
                        ▼
                   TrOCR × N (une inférence par ligne)
                        │
                        ▼
              ┌─────────────────┐
              │   joinLines()   │  Recolle les lignes avec gestion casse/ponctuation
              └────────┬────────┘
                       ▼
           ┌───────────────────────┐
           │ fixFrenchPunctuation()│  Nettoyage typographique final
           └───────────────────────┘
```

## Fonctions — `frontend/src/lib/ocr-utils.js`

### `splitIntoLines(imageData, width, height)`

Détecte les lignes de texte dans une image via **projection horizontale des pixels sombres**.

**Algorithme :**
1. Pour chaque rangée `y`, calcule le ratio de pixels sombres (luminance < 128)
2. Les zones avec ratio > 2% sont du texte, les zones en dessous sont des gaps
3. Un gap est validé s'il fait ≥ 2% de la hauteur totale
4. Une ligne est validée si elle fait ≥ 5% de la hauteur totale
5. Ajoute 3% de padding vertical autour de chaque ligne découpée

**Retourne :** `null` si 0-1 ligne (pas de split), sinon un tableau `[{ top, bottom }, ...]`

**Seuils adaptatifs :**

| Paramètre | Valeur | Rôle |
|---|---|---|
| `threshold` | 0.02 (2%) | Ratio min de pixels sombres pour considérer une rangée comme "texte" |
| `minLineHeight` | max(8px, 5% hauteur) | Hauteur min d'une ligne valide |
| `minGapHeight` | max(2px, 2% hauteur) | Hauteur min d'un gap entre lignes |
| `padding` | 3% hauteur | Marge ajoutée autour de chaque ligne découpée |

### `joinLines(lineTexts)`

Recolle les résultats OCR de chaque ligne en gérant la **casse** et la **ponctuation française**.

**Règles :**

| Fin de la ligne précédente | Jointure | Casse du mot suivant |
|---|---|---|
| `'` `'` (apostrophe/élision) | Pas d'espace | Minuscule |
| `-` (trait d'union) | Pas d'espace | Minuscule |
| `. ! ? …` (fin de phrase) | Espace | **Majuscule conservée** |
| Autre (mot normal) | Espace | Minuscule |

La minusculisation du premier caractère empêche TrOCR de capitaliser chaque ligne comme un début de phrase.

### `fixFrenchPunctuation(text)`

Nettoyage typographique final appliqué après la concaténation.

**Corrections :**
- Suppression des `"` (guillemets droits parasites)
- Remplacement `'` → `'` (apostrophe typographique)
- Espaces avant `! ? ; :` (règle française)
- Espaces après `. , ! ? : ;` quand suivi d'une lettre
- Correction `I'` → `l'` et `I` isolé → `Il` (erreur fréquente TrOCR)
- Fusion `? !` → `?!`, `! ?` → `!?`
- Nettoyage des espaces multiples

### `getImageInfo(blob)` / `cropLineFromBlob(blob, lineRegion, width)`

Utilitaires canvas pour extraire les pixels d'un blob et découper une sous-image. Utilisent `OffscreenCanvas` + `createImageBitmap`.

## Trade-offs

| | Single-line (1 inférence) | Multi-line (N inférences) |
|---|---|---|
| **Latence** | ~0.1-0.3s | ~0.1-0.3s × N lignes |

Le split n'est activé que quand **≥ 2 lignes** sont détectées. Les bulles single-line passent directement par le chemin normal sans overhead.
