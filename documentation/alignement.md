# Documentation : Algorithme d'Alignement "Pixel-Perfect" (Line-Art Matching)

Cette documentation explique le fonctionnement du Web Worker chargé d'aligner automatiquement une page de manga numérisée en Noir & Blanc avec sa version colorisée.

## 1. Le Problème Initial

L'alignement de pages de manga présente un défi majeur : **les pages ne sont jamais découpées (rognées) de la même manière**. 
* La page couleur peut avoir des marges plus grandes.
* Le dessinateur a pu étendre le ciel ou un décor sur la version couleur, ce qui modifie la taille globale du dessin.
* Les algorithmes classiques (comme OpenCV ORB/RANSAC) échouent car ils essaient de faire correspondre des "coins" ou de compenser des déformations 3D qui n'existent pas ici, créant des distorsions.
* Se baser sur la "boîte englobante" (Bounding Box) échoue dès qu'un bout de bulle ou de bordure est présent sur une version et pas sur l'autre.

## 2. La Solution : L'Alignement par "Encre" (Ink-based Template Matching)

Pour contourner ces problèmes, l'algorithme ignore totalement les bords de la page, les marges, et le blanc. **Il ne se concentre que sur les traits noirs du dessin original (le Line-Art).** Le principe est simple : on isole le trait de crayon de l'image N&B, et on le superpose sur l'image couleur jusqu'à ce que les traits correspondent parfaitement, peu importe ce qu'il y a autour.

### Étape 1 : Extraction du Line-Art (L'Encre)
L'algorithme parcourt l'image Noir et Blanc et calcule la luminance de chaque pixel. 
Si un pixel est suffisamment sombre (en dessous d'un certain seuil), il est considéré comme faisant partie du dessin (l'encre). On stocke les coordonnées `(X, Y)` de tous ces pixels sombres. 
*Note : Pour garantir de hautes performances (exécution < 1 seconde), on échantillonne ces points pour ne garder que quelques milliers de points de référence maximum.*

### Étape 2 : La Recherche Pyramidale (Brute-Force Intelligent)
Superposer les images à l'aveugle prendrait trop de temps. L'algorithme utilise donc une approche "Pyramidale" en 3 passes :

1. **Recherche Grossière (Basse résolution) :**
   * Les deux images sont fortement réduites (ex: 150 pixels de large).
   * L'algorithme teste des dizaines d'échelles (zooms) allant de 80% à 120%, ainsi que de grands décalages (translations X et Y).
   * Il calcule le taux d'erreur (voir la méthode MAD ci-dessous) et retient la meilleure combinaison Échelle/Position.

2. **Affinage (Moyenne résolution) :**
   * Les images sont un peu agrandies (ex: 500 pixels de large).
   * L'algorithme ne cherche plus partout. Il se concentre autour de la meilleure position trouvée à l'étape précédente.
   * Il teste des échelles beaucoup plus précises (+/- 4% par petits pas) et affine la position.

3. **Pixel Perfect (Haute résolution) :**
   * L'échelle finale exacte est fixée. L'image couleur est redimensionnée avec cette échelle précise.
   * En utilisant la résolution d'origine de l'image N&B, l'algorithme cherche la translation parfaite au pixel près (dans un tout petit rayon de +/- 6 pixels).

### 3. Comment est calculé le "Match" ? (La méthode MAD)
La fonction mathématique utilisée pour comparer les images est la **Mean Absolute Difference (MAD)** modifiée.

Pour chaque point d'encre `(X, Y)` du calque N&B :
* On regarde à quel pixel cela correspond sur l'image Couleur (en appliquant le décalage actuel).
* On calcule la différence de luminosité entre le trait N&B et le pixel Couleur correspondant.
* On fait la moyenne de toutes ces différences.

**Pourquoi c'est infaillible ?** Parce que l'algorithme ne calcule l'erreur *que* là où il y a de l'encre sur le N&B. Si l'image Couleur a des dessins en plus dans le ciel (là où le N&B est blanc), l'algorithme ne les regarde même pas. Il cherche uniquement à faire coïncider les contours noirs avec les contours colorisés.

## 4. Matrice de Rendu Final
Une fois l'échelle (Scale) et les décalages (Translate X, Translate Y) trouvés, l'algorithme génère une matrice de transformation Affine Standard 2D :
`[Scale, 0, 0, Scale, TranslateX, TranslateY]`

Lors de l'affichage ou de la génération finale, un fond blanc opaque de la taille exacte de l'image N&B est d'abord dessiné. L'image couleur y est ensuite projetée avec cette matrice. Ce processus garantit qu'aucun décalage de ratio ou d'espace vide ne viendra corrompre le rendu.