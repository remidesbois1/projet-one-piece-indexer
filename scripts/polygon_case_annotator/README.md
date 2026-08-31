# Annotateur de cases polygonales

Lancer depuis la racine du projet :

```powershell
python scripts/polygon_case_annotator/annotator.py
```

Pour que l’outil télécharge lui-même les pages depuis Supabase et les images
hébergées par les URLs Cloudflare R2 :

```powershell
pip install -r scripts/polygon_case_annotator/requirements.txt
python scripts/polygon_case_annotator/annotator.py --sync
```

Les variables `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` (ou
`SUPABASE_KEY`) sont lues dans le `.env` du projet. Pour les références privées
`r2://`, les variables `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` et
`R2_SECRET_ACCESS_KEY` sont lues dans `backend/.env`. Les images sont mises en
cache dans le dossier du dataset et ne sont pas retéléchargées à chaque fois.
Le module autonome est aussi disponible via
`python scripts/polygon_case_annotator/sync_r2.py`.

## Entraîner le détecteur polygonal

Après avoir exporté les annotations avec `Exporter YOLO`, le dataset se trouve
dans `scripts/polygon_case_annotator/dataset`. Pour lancer un premier
entraînement segmentation :

```powershell
python scripts/polygon_case_annotator/train_polygon.py --epochs 100 --imgsz 1504 --batch 2
```

Le script utilise `yolo11n-seg.pt` par défaut, crée un run dans `runs/`, puis
copie automatiquement le meilleur poids vers
`models/latest_polygon_seg.pt`. Pour une nouvelle itération, relancez le même
script après avoir réexporté le dataset. Le bouton `Analyser toutes · dernier
modèle` utilise ce poids automatiquement ; les modèles plus anciens sont
également recherchés dans `runs/**/weights/best.pt`. S’il n’existe aucun poids
local, le bouton télécharge automatiquement `weights/best.pt` depuis le dépôt
Hugging Face `Remidesbois/Yolo11-seg-Panel-Poneglyph`.

L’outil utilise son propre cache dans `scripts/polygon_case_annotator/cache`, reprend les annotations sauvegardées, et trouve automatiquement le meilleur `best.pt` disponible (ou `yolo26n.pt` comme dernier recours).

- `Détecter toutes les pages` produit une première annotation à partir des rectangles du modèle, convertis en quadrilatères.
- `Analyser toutes · ONNX Hugging Face` télécharge puis met en cache le modèle [panel_detector.onnx](https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/blob/main/panel_detector.onnx), et lance l’analyse page par page.
- `Analyser page · ONNX` applique ce même modèle uniquement à la page affichée.
- `Ajouter 4 points` permet de créer un trapèze/quadrilatère ; les sommets sont conservés dans l’ordre de clic.
- Cliquer-glisser un sommet modifie précisément la case ; cliquer-glisser son intérieur déplace toute la case.
- En cliquant-maintenant un sommet, le panneau de zoom apparaît immédiatement centré sur ce sommet, reste centré sur le sommet déplacé, puis disparaît au relâchement. Le dépassement du bord de page est rempli en noir.
- Pendant le déplacement d’un sommet, il s’accroche au pixel sombre le plus proche dans un rayon de 8 pixels. Maintenir `Shift` désactive cet aimant et place le sommet exactement sous la souris.
- `↑`, `↓` et le tri droite-vers-gauche/haut-vers-bas gèrent l’ordre de lecture.
- `Exporter YOLO` crée un dataset de segmentation YOLO avec exactement 4 points par annotation (`train/`, `val/`, `data.yaml`).
- La barre de progression et le journal intégré indiquent le téléchargement, le chargement du modèle, la page en cours et le nombre de cases détectées.

Options utiles :

```powershell
python scripts/polygon_case_annotator/annotator.py --dataset chemin/dataset.json --model chemin/best.pt
```

Dépendances : `pillow` et, pour la pré-détection, `ultralytics`. Le dataset sauvegardé est `scripts/polygon_case_annotator/polygon_annotations.json`.
