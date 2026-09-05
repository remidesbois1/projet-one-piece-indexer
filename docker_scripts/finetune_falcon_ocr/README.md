# Falcon-OCR × Poneglyph — RTX 5090

Pipeline Docker dédié à la **reconnaissance du texte des bulles**, inspiré de
`finetune_lighton_ocr` et `finetune_surya_bubble_ocr`, sans entraînement de détection.
Il entraîne [tiiuae/Falcon-OCR](https://huggingface.co/tiiuae/Falcon-OCR) et publie
sur [Remidesbois/Falcon-OCR-Poneglyph](https://huggingface.co/Remidesbois/Falcon-OCR-Poneglyph).

## Lancement Windows

Depuis la racine du projet :

```powershell
# Construction, export, vérification GPU, entraînement, rapports et publication
.\docker_scripts\finetune_falcon_ocr\run.ps1
```

Le script utilise le `.env` à la racine du projet, complété par `backend/.env`
pour l’accès aux pages privées R2. Les valeurs du `.env` racine ont priorité.
Variables nécessaires :

```dotenv
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
HF_TOKEN=...
R2_ENDPOINT=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_PAGES_BUCKET_NAME=...
```

Le token Hugging Face doit permettre l’écriture dans le dépôt cible. Le pipeline
utilise exclusivement `FALCON_REPO_ID` pour sa destination : le `HF_REPO` des
entraînements LightOn/Surya n’est pas repris. Les secrets restent dans
l’environnement du conteneur et ne sont jamais intégrés à l’image ni aux rapports.

Docker Desktop doit fonctionner avec son moteur Linux/WSL2 et l’accès GPU NVIDIA.
Le pilote de cette machine détecté le 5 septembre 2026 est le 616.64, avec une
RTX 5090 de 32 Go. Les résultats de vérification GPU du dernier lancement sont
conservés dans `outputs/smoke_report.json`.
Le smoke test du 5 septembre a validé les 9 707 bulles (aucune exclusion), un
batch physique de 32 à 13,75 Gio de mémoire CUDA, deux pas d’optimisation sur
64 bulles et la génération sur 16 bulles de tailles variées. Ce contrôle court
ne mesure pas encore la qualité ni la durée de l’entraînement complet.
Prévoir environ 20 Go libres pour checkpoints/poids, en plus de Docker et des données.

Pour commencer par les vérifications :

```powershell
.\docker_scripts\finetune_falcon_ocr\run.ps1 -Action check
.\docker_scripts\finetune_falcon_ocr\run.ps1 -Action smoke -SkipBuild
.\docker_scripts\finetune_falcon_ocr\run.ps1 -SkipBuild
```

`check` contrôle les variables et la configuration. `smoke` exporte les bulles et
teste réellement sur GPU la rétropropagation, la parité des logits avec Falcon
officiel, puis sauvegarde/recharge un modèle et compare ses prédictions. Il
n’effectue que deux pas d’optimisation de test après calibration mémoire, avec
des poids temporaires non sauvegardés, puis vérifie la génération batchée. Il ne
lance pas l’entraînement complet et ne publie rien. Les contrôles de gradients,
parité, sauvegarde/rechargement et calibration sont également exécutés
automatiquement avant chaque entraînement complet.

Les références `r2://` sont lues via le client S3 avec les identifiants existants
du backend. Un décalage d’horloge explicitement signalé par R2 est corrigé pour
la signature du client uniquement, à partir de sa réponse HTTPS.

## Toutes les bulles, avec des métriques interprétables

1. Export exhaustif des lignes `bulles.statut = 'Validé'`, avec `texte_propose`
   comme cible et un crop RGB par bulle. Les textes d’un caractère sont conservés.
   Les références vides, coordonnées invalides et pages absentes sont comptabilisées
   par identifiant dans `dataset_report.json`. Une erreur de téléchargement ou de
   décodage fait échouer l’export, plutôt que réduire silencieusement le corpus.
2. Répartition stable d’environ 70/15/15 par **page**. Les pages reliées par une
   image de page ou un crop exactement identique restent ensemble. Les doublons
   sont conservés : chaque annotation exploitable sera vue au réentraînement final.
   Les quasi-doublons et les pages d’une même série ne sont pas tous regroupés ;
   ces scores ne sont donc pas un benchmark sur des séries totalement inconnues.
3. Fine-tuning complet sur train, CER génératif sur **toute** la validation à
   chaque époque, sélection du meilleur checkpoint et early stopping. Le modèle
   doit au moins égaler le CER de validation de Falcon de base pour être publié.
   Ce contrôle ne consulte pas le test.
4. Évaluation du checkpoint sélectionné et du modèle de base sur **tout** le test,
   depuis les images et le prompt fixe uniquement. Les résultats sont sauvegardés
   avant le réentraînement final. Aucun paramètre n’est choisi à partir du test.
5. Par défaut, réentraînement **depuis le modèle de base sur 100 % des bulles
   exportées**, pendant le nombre d’époques sélectionné. Train, val et test sont
   alors réunis, sans nouvelle sélection. Toutes les bulles sont parcourues à
   chaque époque, y compris le dernier batch incomplet.
6. Publication des poids finaux à la racine du dépôt et du checkpoint évalué dans
   `evaluated/`, avec une fiche qui distingue explicitement les deux.

**Les métriques de test décrivent `evaluated/`, pas les poids réentraînés sur
100 % des données.** Ces derniers n’ont plus de test indépendant. Leur supériorité
ne peut pas être garantie sans nouvelles annotations. Pour publier directement
le checkpoint mesuré, définir `FALCON_REFIT_ALL=0` avant un nouveau run.

Le premier export crée un snapshot immuable. Les lancements suivants le relisent
et vérifient les empreintes des images, les identifiants et l’absence de fuite.
Pour intégrer de nouvelles annotations, utiliser un **nouveau dossier de dataset
et un nouveau dossier de sortie**, montés explicitement dans Docker ; le script
ne supprime pas les snapshots précédents. Une reprise avec une configuration ou
des données différentes est refusée.

## Choix pour la 5090

| Réglage | Défaut | Raison |
| --- | --- | --- |
| Base Docker | PyTorch 2.11.0 / CUDA 13.0 / cuDNN 9 | Blackwell et API utilisée par le code Falcon épinglé |
| Entraînement | Tous les ~300 M paramètres | Taille adaptée aux 32 Go, sans quantification ni adapter |
| Précision | BF16 autocast, poids maîtres et Adam FP32 | Tensor cores et stabilité des petites mises à jour |
| Résolution | 64–896 px | Conserver les glyphes, respecter le budget de tokens image |
| Batch physique | Calibration 32 / 16 / 8 / 4 / 2 / 1 | Vrai backward + allocation Adam, marge de 15 % |
| Batch effectif | 32 bulles | Accumulation exacte, dernier groupe pondéré correctement |
| Batch de validation/test | 32 bulles | Mesuré sur toute la validation de la 5090 ; réglable via `FALCON_EVAL_BATCH` |
| Optimiseur | AdamW fusionné, LR `1e-5` | Point de départ conservateur pour le fine-tuning complet |
| Scheduler | Warmup 5 %, cosine, plancher 10 % | Adaptation progressive, puis stabilisation |
| Durée de sélection | 8 époques maximum, patience 2 | Arrêt selon la généralisation mesurée |
| Mémoire | Checkpointing des blocs au-delà de 8 192 tokens par batch ; loss par blocs | Éviter les recalculs sur les petites bulles et garder la protection sur les grandes |
| Préparation CPU | Un batch préparé en avance, dans l’ordre | Recouvrir la lecture/préparation avec le calcul GPU ; mêmes augmentations |
| Augmentation | Contraste/luminosité/netteté légers | Préserver accents, ponctuation et géométrie |

La calibration utilise un crop carré à la résolution maximale et la cible la
plus longue, pour ne pas sous-estimer le pire batch. Elle réserve de la marge
pour le bureau Windows. Elle ne modifie pas les poids (`lr=0`). Les résultats
réels sont écrits dans `calibration.json`. Aucun temps d’entraînement ni score
final n’est promis sans mesure sur ce GPU et ce snapshot.

Falcon publié est un modèle d’inférence spécialisé : son `forward` standard ne
calcule aucune loss, son cache KV est mutable, et son MLP Triton n’a pas de
backward. `model.py` utilise les mêmes poids, masques hybrides et positions 3D
dans un chemin différentiable. L’attention SDPA représente le *sink* par une clé
supplémentaire à valeur nulle, en conservant ses gradients. Les tests comparent
sa sortie et tous ses gradients à une référence dense indépendante.
Les poids publiés restent compatibles avec le code et l’API Falcon d’origine.

La génération projette seulement la dernière position sur le vocabulaire et
évite les synchronisations CPU/GPU par élément. Sur le checkpoint de l’époque 1,
la validation complète des 1 457 bulles a pris 59,9 secondes avec un batch de 32
(24,3 bulles/s, pic CUDA de 3,82 Gio pour ce processus). Le changement de batch
peut modifier quelques décisions proches en BF16 : CER de 0,762 % contre
0,729 % avec le batch de 2 sur ce checkpoint. Les références, la résolution et
la limite de génération restent identiques. Ces mesures ne prédisent pas les
résultats des prochaines époques.

Le padding spatial suit le rectangle réellement occupé par les images du batch,
au lieu d’allouer systématiquement 896 × 896 pixels par image. La résolution des
images, leurs pixels utiles, les positions et les cibles ne changent pas.
Sur un benchmark de 1 024 bulles avec augmentation et AdamW (`lr=0` pour préserver
les poids), la boucle complète est passée de 74,4 à 205,9 bulles/s, avec un pic
CUDA de 12,70 Gio. La parité de la loss et de tous les gradients a été vérifiée
en FP32 ; en BF16, les pertes moyennes des deux boucles diffèrent de moins de
1e-8 sur ce benchmark. La mémoire libre seule ne prédit pas le débit.
Le contrôle sur les 6 749 bulles d’une époque entière a ensuite mesuré 199,3
bulles/s (33,9 secondes, 211 pas AdamW à LR nul, pic de 12,97 Gio). Il conserve
les poids et sert seulement à mesurer la vitesse ; les résultats du vrai
fine-tuning dépendent des mises à jour et des validations suivantes.

Le lanceur alloue un terminal Docker pour les barres en direct. Si la sortie est
redirigée, la validation affiche son avancement et son estimation de temps toutes
les 20 secondes, entre deux batchs.

La loss supervise seulement la transcription et `<|end_of_query|>`, en moyenne
par bulle. Le vocabulaire de 65 536 tokens n’est projeté que sur ces positions,
par blocs de 128 tokens. Aucune cible n’est tronquée : un dépassement du budget
arrête le lancement et indique la variable à augmenter.

## Suivi et résultats

Le terminal affiche progression, ETA, loss, bulles/s, mémoire GPU et scores de
validation. Chaque étape d’optimisation ajoute une ligne à `outputs/steps.jsonl`.
Pour TensorBoard, ouvrir un second terminal :

```powershell
.\docker_scripts\finetune_falcon_ocr\run.ps1 -Action dashboard -SkipBuild
```

Puis ouvrir [localhost:6006](http://localhost:6006). Le port n’est exposé que sur
la machine locale. Les événements restent dans `outputs/tensorboard/`.

Le dossier `outputs/release/` destiné au Hub contient :

- poids complets, tokenizer, configuration et fichiers Python du modèle ;
- `evaluated/` : checkpoint indépendant évalué, si refit activé ;
- `benchmark_test.json`, `benchmark_base_test.json`, `predictions_test.csv` ;
- CER/WER corpus, CER strict, exact match, taux de sorties vides et tronquées ;
- intervalle CER à 95 % par bootstrap de pages, analyses par longueur/forme ;
- courbes d’apprentissage, comparaison avant/après et distribution des erreurs ;
- images de bulles avec référence et prédiction : six plus grosses erreurs,
  puis jusqu’à deux textes exacts ;
- fiche modèle, empreinte du corpus, paramètres, versions et code d’entraînement.

Les URLs de stockage des pages, le dataset complet et les états d’optimiseur ne
sont pas publiés. Le commit Hugging Face intervient seulement quand tous les
artefacts existent et leurs empreintes ont été enregistrées. En cas d’erreur
réseau après l’entraînement :

```powershell
.\docker_scripts\finetune_falcon_ocr\run.ps1 -Action publish -SkipBuild
```

## Personnalisation et reprise

Les variables `FALCON_*` du terminal PowerShell priment sur le `.env` :

```powershell
$env:FALCON_UPLOAD = '0'          # conserver localement, publication ultérieure
$env:FALCON_EPOCHS = '8'
$env:FALCON_LR = '0.00001'
$env:FALCON_MAX_NEW_TOKENS = '256'
$env:FALCON_MICRO_BATCH = '0'     # calibration automatique
```

Tous les champs de `config.py` sont configurables avec le préfixe `FALCON_`.
La révision du modèle est épinglée ; la changer demande de revérifier le contrat
du code distant. Les checkpoints de sélection et de refit contiennent poids,
optimiseur, scheduler, époque, sélection et identité des données. Une interruption
reprend à la dernière **époque terminée** ; l’époque incomplète est rejouée.
`FALCON_EVAL_BATCH` peut changer lors d’une reprise, y compris pour les anciens
checkpoints. Les paramètres d’apprentissage et l’identité du corpus doivent
toujours correspondre ; poids, optimiseur et scheduler sont restaurés.
`FALCON_CHECKPOINT_TOKEN_BUDGET` (défaut : `8192`, `0` pour checkpointing systématique)
et `FALCON_PREFETCH_BATCHES` (défaut : `1`, `0` pour préparation séquentielle)
peuvent également changer à la reprise. Ces réglages ne changent ni les batchs
effectifs ni l’ordre des données ; les calculs BF16 peuvent varier légèrement.
Les logs de steps peuvent donc contenir une tentative partielle rejouée ; les
historiques d’époques font foi pour les graphiques finaux. Deux processus ne
peuvent pas écrire dans le même dossier de sortie en même temps.

## Docker Linux

```bash
docker build -t poneglyph/falcon-ocr:5090 docker_scripts/finetune_falcon_ocr
docker run --rm --init --gpus device=0 --shm-size 16g \
  --env-file .env \
  --mount type=bind,src="$PWD/docker_scripts/finetune_falcon_ocr/dataset",dst=/workspace/falcon_dataset \
  --mount type=bind,src="$PWD/docker_scripts/finetune_falcon_ocr/outputs",dst=/workspace/outputs_falcon_ocr \
  --mount type=volume,src=poneglyph-falcon-cache,dst=/cache \
  poneglyph/falcon-ocr:5090
```

Créer les deux dossiers de montage avant ce lancement. Les options `--smoke`,
`--export-only`, `--dry-run`, `--publish-only` se placent après le nom de l’image.

## Tests

```bash
python -m unittest discover -s docker_scripts/finetune_falcon_ocr -p 'test_*.py' -v
```

Ces tests CPU sont également exécutés à la construction de l’image. Ils couvrent
les sorties et gradients de l’attention, les masques, les splits/doublons,
l’intégrité des images, la couverture du corpus, les métriques, la production
des graphiques et le refus de publier une release modifiée. Ils ne remplacent
pas le smoke test CUDA imposé au démarrage.

Une vérification CPU optionnelle emploie les vrais blocs et le tokenizer Falcon,
avec seulement ses kernels d’inférence GPU remplacés par des calculs denses :

```bash
hf download tiiuae/Falcon-OCR --revision 42ec56b72a23984ac059e7c8a6d397a8529423fe \
  --include '*.py' '*.json' --local-dir /tmp/falcon-source
python docker_scripts/finetune_falcon_ocr/verify_upstream_cpu.py /tmp/falcon-source
```

Lors du contrôle local sur une instance réduite à deux blocs de cette architecture,
l’écart maximal des logits FP32 était `8.94e-8`, tous les paramètres recevaient
des gradients finis, et six pas sur un exemple synthétique réduisaient la loss
de `6.1821` à `5.4546`. Le tokenizer/processor réel a également confirmé le masquage
exact de la cible et du stop, et une inférence sans référence. Ce sont des tests
de fonctionnement CPU, **pas des résultats OCR Poneglyph**.

Sources : [modèle et API Falcon](https://huggingface.co/tiiuae/Falcon-OCR),
[code officiel](https://github.com/tiiuae/Falcon-Perception),
[PyTorch 2.11 CUDA 13](https://dev-discuss.pytorch.org/t/transitioning-pypi-cuda-wheels-to-cuda-13-0-as-the-stable-release-2-11/3325).
