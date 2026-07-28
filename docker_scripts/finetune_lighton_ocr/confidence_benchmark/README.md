# Benchmark de confiance LightOnOCR-2

Ce dossier contient une expérience isolée de l'intégration produit. Elle répond à
deux questions :

1. une confiance agrégée permet-elle de prioriser les bulles qui contiennent une
   erreur OCR ?
2. une faible probabilité du token généré permet-elle de localiser le fragment
   erroné ?

Le jeu évalué est le split test public figé de
`Remidesbois/LightonOCR-2-1b-poneglyph`. Les identifiants de ce split sont
recroisés avec les lignes actuellement `Validé` de Supabase, puis les crops et
ground truths sont réexportés depuis Supabase.

## Exécution

Depuis la racine du dépôt :

```powershell
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py all
```

Commandes séparées :

```powershell
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py export
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py infer
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py profile
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py analyze
```

Options utiles :

```powershell
# Smoke test déterministe
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py all --limit 8

# Reprendre une inférence interrompue
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py infer --resume

# Autre modèle ou révision immuable
python docker_scripts/finetune_lighton_ocr/confidence_benchmark/lighton_confidence_benchmark.py infer --model-id Remidesbois/LightonOCR-2-1b-poneglyph --revision COMMIT
```

Les secrets sont chargés depuis `.env` à la racine, comme dans les scripts de
fine-tune. Les données et résultats sont locaux et ignorés par Git.

## Sorties

- `data/ground_truth.jsonl` : ground truths et chemins des crops ;
- `data/export_report.json` : provenance et contrôles Supabase/Hugging Face ;
- `results/predictions.jsonl` : sortie brute par bulle, probabilité, marge et
  alternatives par token ;
- `results/sample_records.csv` et `token_records.csv` : tables plates ;
- `results/metrics.json` : métriques, intervalles bootstrap et budgets de revue ;
- `results/performance_profile.json` : profil A/B sans/avec scores ;
- `results/lighton_confidence_*.png` : graphiques ;
- `results/REPORT.md` : rapport généré à partir des mesures.

## Limite d'interprétation

La probabilité softmax est la probabilité du prochain token sous le modèle, pas
une probabilité calibrée que la transcription soit correcte. Une insertion dans
la référence (caractère omis par l'OCR) n'a aucun token généré auquel rattacher
une confiance locale ; elle est donc mesurée au niveau bulle, mais exclue de la
vérité terrain token stricte.

Le profil de performance compare `output_scores=False` à
`output_scores=True + compute_transition_scores` sur 128 crops, trois fois, avec
ordre alterné. Il ne calcule volontairement pas les alternatives top-k : le
benchmark montre que la probabilité minimale du token choisi est aussi
discriminante que la marge top-1/top-2.
