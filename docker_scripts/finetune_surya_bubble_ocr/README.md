# Fine-tuning Surya OCR 2 classique — profil RTX 3090

Ce package entraîne `datalab-to/surya-ocr-2` sur des crops de bulles validées.
Il ne concerne pas le modèle BBox pleine page.

Le pipeline complet conserve le contrat existant :

1. export Supabase avec split strict par page ;
2. fine-tuning Surya ;
3. benchmark génération sur le test held-out ;
4. fusion éventuelle de l'adapter ;
5. upload Hugging Face et artefacts fournisseur.

## Profil 3090 par défaut

Le profil par défaut est un fine-tuning hybride :

- backbone langage complet entraînable ;
- merger multimodal entraînable ;
- 4 derniers blocs vision entraînables ;
- reste du backbone vision gelé ;
- BF16, TF32 et `adamw_torch_fused` ;
- batch physique 16, accumulation 2, soit le même batch effectif de 32 ;
- gradient checkpointing désactivé pour privilégier le débit ;
- LR langage `1.2e-5`, LR merger `0.5x`, LR vision `0.25x` ;
- 5 époques, cosine avec plancher à 10 %, early stopping de patience 2 ;
- évaluation CER générative à chaque époque, avec baseline initiale optionnelle ;

Le modèle fait environ 666 M de paramètres. Le profil conserve le fine-tuning
hybride complet sur les 24 Go de la RTX 3090, sans quantification.

## Résultat publié — 30 juillet 2026

Le run final RTX 3090 a évalué les 1 423 bulles du test held-out :

| Métrique | Résultat |
| --- | ---: |
| CER | **0,451 %** |
| WER | **1,656 %** |
| Exact match | **90,65 %** |
| Levenshtein moyen | **0,1595** |
| Sorties vides | **0 %** |
| Limite de génération atteinte | **0 / 1 423** |

Modèle : [`Remidesbois/surya-bubble-ocr-poneglyph`](https://huggingface.co/Remidesbois/surya-bubble-ocr-poneglyph).
Le benchmark détaillé est publié avec le modèle dans `benchmark_test.json`.

## Optimisations spécifiques

- Un seul passage multimodal du processor par batch, contre un passage groupé
  plus deux passages supplémentaires par image auparavant.
- La tête de vocabulaire ne calcule les logits que sur le suffixe OCR supervisé,
  pas sur les tokens de l'image et du prompt.
- Regroupement des exemples par coût token estimé pour réduire le padding.
- Cache LRU des crops dans le processus principal et mémoire épinglée ; les
  workers DataLoader sont désactivés pour éviter le verrou CUDA/Triton observé.
- Fast Gated DeltaNet via `flash-linear-attention` et `causal-conv1d`.
  L'image Docker refuse de démarrer l'entraînement si ce chemin manque.
- Le wheel `causal-conv1d` est compilé uniquement pour SM 8.6 afin d'éviter
  neuf architectures inutiles dans une image dédiée à la RTX 3090.
- SDPA PyTorch pour les 6 couches d'attention complète. FlashAttention 2 n'est
  pas imposé : il reste sélectionnable avec `SURYA_ATTN_IMPLEMENTATION`.
- Évaluation génération batchée et échantillon de validation stratifié.

Les kernels d'inférence locaux `surya_hybrid_flash_kvcache.py` et
`surya_mlp_kernels.py` ne sont pas réutilisés directement : ils sont conçus
pour le décodage mono-token et n'ont pas de backward. Les principes transférables
(BF16, kernels fusionnés, formes regroupées et travail limité aux logits utiles)
sont appliqués ici.

## Améliorations qualité

- Loss moyenne par bulle plutôt que moyenne globale par token : les longs
  dialogues ne dominent plus les textes très courts.
- Pondération légère des textes de 1–8 caractères et des onomatopées.
- Augmentations manga conservatrices : contraste, luminosité, netteté, léger
  flou et rotation maximale de 1 degré.
- Budget image borné entre 65 536 et 1 048 576 pixels pour conserver les détails
  sans laisser un crop aberrant provoquer un OOM.
- Sélection du meilleur checkpoint sur le CER et test final complet.
- Le benchmark initial reste disponible avec `SURYA_EVAL_ON_START=1`, mais il
  est désactivé par défaut : il ne change pas l'entraînement et gardait la barre
  principale à 0 % pendant toute la génération de référence.

## Lancement

Validation rapide du contrat :

```bash
python run_pipeline.py --dry-run --check-remote
python train_surya_bubble_ocr.py --validate-setup
python train_surya_bubble_ocr.py --train-smoke-steps 1
```

Pipeline complet :

```bash
python run_pipeline.py
```

Dans le conteneur RunPod, les chemins par défaut sont :

```text
/workspace/surya_bubble_dataset
/workspace/outputs_surya_bubble_ocr
/workspace/hf-cache
```

## Réglages principaux

```bash
SURYA_TRAIN_MODE=hybrid          # hybrid, full ou lora
SURYA_TRAIN_BATCH=16
SURYA_EVAL_BATCH=16
SURYA_GRAD_ACCUM=2
SURYA_LR=1.2e-5
SURYA_EPOCHS=5
SURYA_VISION_TRAIN_LAST_BLOCKS=4
SURYA_VISION_LR_MULTIPLIER=0.25
SURYA_MERGER_LR_MULTIPLIER=0.50
SURYA_GRADIENT_CHECKPOINTING=0
SURYA_TORCH_COMPILE=0
SURYA_DATALOADER_WORKERS=0
SURYA_EVAL_ON_START=0
SURYA_GEN_EVAL_BATCH=8
SURYA_GEN_EVAL_MAX_SAMPLES=256
SURYA_MAX_NEW_TOKENS=256
SURYA_RESUME_FROM_CHECKPOINT=auto
SURYA_HF_UPLOAD_WORKERS=4
```

`SURYA_TORCH_COMPILE=1` reste expérimental avec les kernels Triton DeltaNet.
Il faut le comparer localement après le premier epoch chaud avant de le garder.

Le collator peut être rebenchmarké sur le dataset exporté :

```bash
python benchmark_training_hotpath.py \
  --metadata /workspace/surya_bubble_dataset/train/metadata.jsonl \
  --output /workspace/outputs_surya_bubble_ocr/collator_benchmark.json
```

Sur la validation locale RTX 3090, batch 16 sur des crops réels, la médiane est
passée de 167,7 ms à 18,3 ms, soit 9,18x, avec égalité exacte de tous les tokens
supervisés. Ce nombre mesure le pipeline CPU/processor, pas le débit final GPU.
À ce coût-là, des workers DataLoader n'apportent pas de débit utile face à un
pas GPU de 1,111 s. Ils sont donc désactivés : après l'initialisation CUDA/Triton,
leur création par `fork` peut hériter d'un verrou et bloquer avant le premier
batch. `--validate-setup` consomme maintenant un vrai batch via le DataLoader
configuré afin de détecter cette régression avant un entraînement complet.

Le premier pas `Trainer` compile les kernels CUDA/Triton et prend environ
60 secondes avec un cache vide sur la 3090. La barre reste à 0 % pendant ce seul
pas, mais la GPU travaille. Les pas suivants prennent environ 2,5 secondes avec
l'accumulation 2×16 (cohérent avec ~1,11 s par micro-batch). Les caches
TorchInductor et Triton sont persistés dans le volume Hugging Face : un nouveau
conteneur a validé le même premier pas en 5,25 secondes une fois le cache chaud.

La génération réserve jusqu'à 256 nouveaux tokens. Le tokenizer Surya OCR 2
utilisé ici est presque caractère par caractère : sur les 9 527 bulles validées,
le p99 est à environ 115 tokens et le maximum à 186 tokens avec le suffixe de
conversation. L'ancienne limite
de 96 tronquait 244 références valides. Le chargement du dataset refuse
maintenant de démarrer si une cible dépasse le budget, et le benchmark publie
`token_limit_rate` pour rendre toute sortie arrêtée par la limite visible.

Un lancement interrompu reprend automatiquement le dernier `checkpoint-*`
présent dans le dossier d'outputs. Utiliser
`SURYA_RESUME_FROM_CHECKPOINT=0` pour repartir volontairement de zéro.

L'early stopping est calculé après le benchmark génératif, directement sur son
CER. Cela évite l'ordre d'appel de `EarlyStoppingCallback`, qui recevait
`eval_loss` avant la disponibilité de `eval_cer` et se désactivait.

La publication utilise l'uploader Hugging Face `upload_large_folder`, résumable
et adapté au fichier `model.safetensors` d'environ 1,33 Go.

Le benchmark complet forward + backward + AdamW sur le groupe de crops le plus
coûteux confirme le batch physique 16 : 18,00 Gio alloués, 18,45 Gio réservés
et 1,111 s par pas chaud. Le batch 8 atteint 10,77 Gio et 0,653 s, soit environ
18 % de débit par bulle en moins. Le batch 32 provoque un OOM dans DeltaNet.

Repli si d'autres applications occupent la VRAM :

```bash
SURYA_TRAIN_BATCH=8
SURYA_EVAL_BATCH=8
SURYA_GRAD_ACCUM=4
SURYA_GEN_EVAL_BATCH=4
```

Mode rsLoRA de secours :

```bash
SURYA_TRAIN_MODE=lora
SURYA_LORA_R=64
SURYA_USE_RSLORA=1
SURYA_USE_DORA=0
```

Ce mode cible également `in_proj_qkv`, `in_proj_z`, `in_proj_a`,
`in_proj_b` et `out_proj`, absents de l'ancienne configuration LoRA.
