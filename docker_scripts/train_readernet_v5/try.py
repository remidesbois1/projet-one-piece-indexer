import json
import os
import torch
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from tqdm import tqdm

# On importe ton architecture et tes constantes depuis ton script d'entraînement
from train_readernet import ReaderNetV8, CANVAS_W, CANVAS_H, BUBBLE_CROP_SIZE

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset" / "val" # On utilise 'val' car on a besoin des annotations
OUTPUT_DIR = SCRIPT_DIR / "eval_visualizations"

def crop_bubble(img_np, box):
    x, y, w, h = box
    x1, y1 = max(0, int(x * CANVAS_W)), max(0, int(y * CANVAS_H))
    x2, y2 = min(CANVAS_W, int((x + w) * CANVAS_W)), min(CANVAS_H, int((y + h) * CANVAS_H))
    if x2 <= x1 or y2 <= y1: return np.zeros((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE), dtype=np.float32)
    return np.array(Image.fromarray((img_np[y1:y2, x1:x2]*255).astype(np.uint8)).resize((BUBBLE_CROP_SIZE, BUBBLE_CROP_SIZE)), dtype=np.float32) / 255.0

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # 1. Charger le modèle
    model_path = SCRIPT_DIR / "dataset" / "readernet_v8.pt"
    if not model_path.exists():
        print(f"Erreur: Modèle introuvable à {model_path}")
        return

    print("Chargement du modèle...")
    model = ReaderNetV8().to(device)
    model.load_state_dict(torch.load(model_path, map_location=device))
    model.eval()

    # 2. Charger les annotations de validation
    ann_path = DATASET_DIR / "annotations.json"
    with open(ann_path) as f:
        annotations = json.load(f)

    print(f"Génération des visualisations dans le dossier: {OUTPUT_DIR.name}/")
    
    # On va visualiser les 50 premières pages pour ne pas tout spammer
    for page in tqdm(annotations[:50], desc="Inférence et Dessin"):
        img_path = DATASET_DIR / "images" / page["image"]
        if not img_path.exists(): continue

        # Extraire les bulles uniques de l'annotation
        nodes = []
        for pair in page["pairs"]:
            a_tuple = (pair["a"]["x"], pair["a"]["y"], pair["a"]["w"], pair["a"]["h"])
            b_tuple = (pair["b"]["x"], pair["b"]["y"], pair["b"]["w"], pair["b"]["h"])
            if a_tuple not in nodes: nodes.append(a_tuple)
            if b_tuple not in nodes: nodes.append(b_tuple)

        N = len(nodes)
        if N < 2: continue

        # Préparer l'image pour le modèle
        img_pil = Image.open(img_path).convert("L").resize((CANVAS_W, CANVAS_H), Image.BILINEAR)
        img_np = np.array(img_pil, dtype=np.float32) / 255.0

        geoms, crops = [], []
        for (x, y, w, h) in nodes:
            geom = [x, y, w, h, w*h, 1.0-(x+w/2), h/(w+1e-6), x+w/2, y+h/2]
            geoms.append(geom)
            crops.append(crop_bubble(img_np, (x, y, w, h)))

        # Convertir en Tensors (Batch de taille 1)
        t_img = torch.from_numpy(img_np).unsqueeze(0).unsqueeze(0).to(device)
        t_geoms = torch.tensor(geoms, dtype=torch.float32).unsqueeze(0).to(device)
        t_crops = torch.tensor(np.array(crops), dtype=torch.float32).unsqueeze(0).unsqueeze(2).to(device)
        t_pad_mask = torch.zeros(1, N, dtype=torch.bool).to(device) # Pas de padding car batch=1

        # 3. Inférence
        with torch.no_grad():
            with torch.autocast("cuda", enabled=(device.type == "cuda")):
                pair_logits, rank_logits = model(t_img, t_geoms, t_crops, t_pad_mask)
            
            pair_probs = torch.sigmoid(pair_logits).cpu().numpy()[0]
            rank_scores = torch.sigmoid(rank_logits).cpu().numpy()[0]

        # Calcul de l'ordre final
        pred_combined_scores = pair_probs.sum(axis=1) + 0.1 * rank_scores
        pred_order_indices = np.argsort(-pred_combined_scores).tolist() # L'indice 0 est la première bulle

        # 4. Dessin
        # On repasse l'image en RGB et on la double de taille pour que le texte soit lisible
        draw_img = img_pil.convert("RGB").resize((CANVAS_W * 2, CANVAS_H * 2), Image.NEAREST)
        draw = ImageDraw.Draw(draw_img)

        # On prépare les centres pour tracer les lignes
        centers = {}

        for rank, node_idx in enumerate(pred_order_indices):
            x, y, w, h = nodes[node_idx]
            # Mise à l'échelle (x2)
            px, py = int(x * CANVAS_W * 2), int(y * CANVAS_H * 2)
            pw, ph = int(w * CANVAS_W * 2), int(h * CANVAS_H * 2)
            cx, cy = px + pw // 2, py + ph // 2
            centers[rank] = (cx, cy)

            # Dessiner la boîte de la bulle
            draw.rectangle([px, py, px + pw, py + ph], outline=(0, 255, 0), width=3)
            
            # Dessiner le numéro d'ordre (Ombre noire + Texte Cyan)
            draw.text((px + 5, py + 5), str(rank + 1), fill="black", font_size=26)
            draw.text((px + 4, py + 4), str(rank + 1), fill=(0, 255, 255), font_size=26)

        # Dessiner le chemin de lecture (lignes rouges avec opacité)
        for i in range(N - 1):
            pt1 = centers[i]
            pt2 = centers[i + 1]
            draw.line([pt1, pt2], fill=(255, 0, 0), width=4)
            # Petit cercle à l'arrivée pour faire "flèche"
            draw.ellipse([pt2[0]-4, pt2[1]-4, pt2[0]+4, pt2[1]+4], fill=(255, 255, 0))

        # 5. Sauvegarde
        draw_img.save(OUTPUT_DIR / f"pred_{page['image']}")

    print("Terminé ! Va jeter un œil dans le dossier 'eval_visualizations'.")

if __name__ == "__main__":
    main()