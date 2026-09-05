# Falcon-OCR Poneglyph dans Chrome / WebGPU

Export du modèle final `Remidesbois/Falcon-OCR-Poneglyph` en ONNX avec cache KV.
La page `/sandbox/falcon` permet de charger le modèle, sélectionner une image et
la transcrire localement. Falcon est également proposé dans le sélecteur OCR de
la sandbox et de l’annotation.

## Reproduire l’export

Le checkpoint PyTorch doit être dans `../finetune_falcon_ocr/outputs/release`.
Python 3.12 est recommandé. Depuis la racine du projet :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\docker_scripts\export_falcon_ocr_onnx\run.ps1
npm.cmd run dev --workspace frontend
```

Le script accepte `-Python`, `-Source` et `-Output`. Les dépendances peuvent être
installées dans un venv ; transmettre alors le chemin de son `python.exe`.
Les fichiers sont générés dans `frontend/public/models/falcon-ocr` (ignoré par Git).
Ouvrir `http://localhost:3000/sandbox/falcon` dans Chrome. WebGPU et `shader-f16`
doivent être disponibles. Aucun backend Python n’intervient dans la transcription.

En développement, le navigateur utilise automatiquement l’export local s’il est
présent. Sinon, et en production, il charge les fichiers publiés sur Hugging Face
à la révision `abd33103ab9fef627d89ef430e1ecb1c15fb7194`. Pour imposer une source,
définir `NEXT_PUBLIC_FALCON_MODEL_BASE` dans `frontend/.env.local`, puis redémarrer
Next.js. Cette variable est prise en compte au build et accepte une URL de dossier
ONNX ou `/models/falcon-ocr` pour l’export local.
Les cinq images de contrôle sont des fichiers de développement locaux : elles
ne sont pas nécessaires pour utiliser son propre fichier et ne sont pas publiées.

## Architecture exportée

- 22 blocs, RMSNorm avec l’epsilon explicite du calcul BF16 d’entraînement,
  attention GQA, sink appris, RoPE temporel et spatial « golden », MLP ReLU².
- Poids principaux et cache KV en FP16. Résidus, calculs de normalisation,
  softmax et projection de sortie du MLP en FP32 : un export intégralement FP16
  produit des dépassements numériques sur ce modèle.
- Un graphe dynamique pour le prefill et le décodage, 618 Mo de poids externes.
  Le cache reste sur GPU entre les tokens ; seuls les identifiants générés sont
  rapatriés. Seule la dernière position est projetée sur le vocabulaire.
- Opérations ONNX standard, opset 17. Pas de fork de Transformers.js/ORT,
  de Triton, de FlexAttention ni de types complexes dans le navigateur.
- ONNX Runtime Web 1.27.0, `executionProviders: ['webgpu']` et
  `session.disable_cpu_ep_fallback = '1'`. Le calcul de forme des sinks est fourni
  par JavaScript pour éviter une affectation de nœuds au fournisseur CPU.

Transformers.js fournit le tokenizer. Le worker exécute les demandes en série et
libère son cache après chaque image. Chaque moteur conserve son propre worker et son état de chargement : Falcon et
PP-OCR peuvent rester chargés et transcrire la même bulle. Les workers sont
libérés lorsque leur fournisseur React est démonté.

Le prétraitement conserve les pixels utiles, les limites 64–896 px, les patches
16×16, la normalisation [-1,1], le prompt et les positions de Falcon. Le navigateur
utilise le redimensionnement Canvas haute qualité ; ses pixels interpolés peuvent
différer de Pillow. L’export mixte ne doit pas hériter des métriques PyTorch sans
une nouvelle évaluation. Le modèle final a été réentraîné sur toutes les bulles :
les exemples locaux vérifient le fonctionnement, pas la généralisation.

## Vérifications effectuées

Chrome sur `localhost:3000`, RTX 5090 (Blackwell), le 5 septembre 2026 :
5/5 transcriptions identiques au modèle Python, accents et ponctuation compris.
Premier exemple : 2 564 ms (compilation initiale comprise). Exemples suivants :
184, 597, 285 et 428 ms. Ces cinq images ne constituent pas un benchmark de vitesse
général ; taille des images et longueur de sortie influencent le temps.

`make_fixtures.py` s’exécute dans l’image d’entraînement avec `/app` monté sur
`finetune_falcon_ocr` et `/browser` sur le dossier ONNX. Il compare le modèle natif
et exporte des données de contrôle locales. `validate_onnx.py --model <dossier>`
vérifie une génération ONNX complète avec cache sur la première fixture.

Références : [WebGPU / ONNX Runtime](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html),
[modèle Falcon-OCR](https://huggingface.co/tiiuae/Falcon-OCR).

## Publier un nouvel export

Avec `HF_TOKEN` dans l’environnement ou dans le fichier `.env` du projet :

```powershell
python docker_scripts/export_falcon_ocr_onnx/upload_onnx.py --directory frontend/public/models/falcon-ocr
```

Le script vérifie les empreintes du graphe et des poids puis ajoute uniquement
les six fichiers de distribution sous `onnx/`. Les images de contrôle restent
locales. Après publication, mettre à jour la révision par défaut dans
`frontend/src/lib/falconWebgpu.js` pour distribuer ce nouvel export.
