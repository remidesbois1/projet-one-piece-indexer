# Poneglyph Modal Training

This is the lightweight MLOps launcher for Poneglyph fine-tuning jobs.

## Database schema

Apply this migration to Supabase before using the admin page:

```text
backend/sql/2026-07-01_add_training_jobs.sql
```

You can verify the migration from the backend package:

```powershell
cd backend
npm run training:schema -- --check
```

To apply it through the Supabase Management API, provide a personal access token with database write access:

```powershell
cd backend
$env:SUPABASE_ACCESS_TOKEN="..."
npm run training:schema
```

The backend returns `503 Schema fine-tuning non installe` until `training_jobs` and `model_versions` are visible through PostgREST.

## Modal resources

Create the required secrets in Modal:

```powershell
modal secret create poneglyph-supabase SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
modal secret create poneglyph-huggingface HF_TOKEN=...
modal secret create poneglyph-admin PONEGLYPH_INTERNAL_API_SECRET=...
```

Deploy the app:

```powershell
$env:PYTHONUTF8="1"
$env:PYTHONIOENCODING="utf-8"
modal deploy docker_scripts/modal_training_app.py
```

The default app and volume names are:

```text
PONEGLYPH_MODAL_APP_NAME=poneglyph-training
PONEGLYPH_MODAL_VOLUME_NAME=poneglyph-datasets
```

The deployed GPU training entrypoints are selected from the `gpu` param:

```text
L40S      -> train_model
A100-80GB -> train_model_a100_80gb
H100      -> train_model_h100
H200      -> train_model_h200
B200      -> train_model_b200
```

When only `kind` and `gpu` are provided, the launcher/backend apply these tuned defaults. Explicit params always override the preset. `final eval = 0` means the final held-out test benchmark runs on the full test split.

### GPU presets

#### Surya bubble OCR

| GPU | epochs | batch | grad accum | LR | LoRA | final eval | gen eval | eval steps | eval batch | workers | patience | ckpts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| L40S | 6 | 2 | 8 | 0.00005 | 64 | 0 | 96 | 300 | 1 | 2 | 4 | 4 |
| A100-80GB | 6 | 4 | 4 | 0.00005 | 64 | 0 | 128 | 300 | 2 | 4 | 4 | 4 |
| H100 | 6 | 4 | 4 | 0.00005 | 96 | 0 | 160 | 300 | 2 | 4 | 4 | 4 |
| H200 | 6 | 6 | 3 | 0.00005 | 96 | 0 | 192 | 300 | 3 | 6 | 4 | 4 |
| B200 | 6 | 8 | 2 | 0.00005 | 128 | 0 | 224 | 300 | 4 | 8 | 4 | 4 |

#### Surya bbox OCR

| GPU | epochs | batch | grad accum | LR | LoRA | final eval | gen eval | eval steps | eval batch | workers | patience | ckpts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| L40S | 6 | 1 | 8 | 0.00005 | 64 | 0 | 24 | 250 | 1 | 2 | 4 | 4 |
| A100-80GB | 6 | 2 | 4 | 0.00005 | 64 | 0 | 32 | 250 | 1 | 4 | 4 | 4 |
| H100 | 6 | 2 | 4 | 0.00005 | 96 | 0 | 40 | 250 | 2 | 4 | 4 | 4 |
| H200 | 6 | 3 | 3 | 0.00005 | 96 | 0 | 48 | 250 | 2 | 6 | 4 | 4 |
| B200 | 6 | 4 | 2 | 0.00005 | 128 | 0 | 64 | 250 | 2 | 8 | 4 | 4 |

#### LightOn OCR

| GPU | epochs | batch | grad accum | LR | LoRA | final eval | gen eval | eval steps | eval batch | workers | patience | ckpts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| L40S | 8 | 2 | 8 | 0.00005 | 64 | 0 | 96 | 300 | 1 | 2 | 4 | 4 |
| A100-80GB | 8 | 4 | 4 | 0.00005 | 64 | 0 | 128 | 300 | 2 | 4 | 4 | 4 |
| H100 | 8 | 4 | 4 | 0.00005 | 96 | 0 | 160 | 300 | 2 | 4 | 4 | 4 |
| H200 | 8 | 6 | 3 | 0.00005 | 96 | 0 | 192 | 300 | 3 | 6 | 4 | 4 |
| B200 | 8 | 8 | 2 | 0.00005 | 128 | 0 | 224 | 300 | 4 | 8 | 4 | 4 |

#### YOLO26n + PP-OCRv6 bubble line

This combined job first trains the YOLO26n bubble-line detector, then uses the
fresh `best.pt` to export stitched single-line bubble crops from Supabase and
train the PP-OCRv6 recognizer. The H100 preset is throughput-oriented: YOLO
uses a large batch and PP-OCRv6 trains with real batch 16, no gradient
accumulation, DataLoader workers, pinned memory, and backbone tuning enabled.

| GPU | PP epochs | PP batch | grad accum | PP LR | YOLO epochs | YOLO batch | YOLO imgsz | YOLO workers | image width | train backbone | pin memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| L40S | 10 | 2 | 8 | 0.00002 | 120 | 16 | 960 | 2 | 960 | yes | no |
| A100-80GB | 12 | 4 | 4 | 0.00002 | 140 | 24 | 1024 | 4 | 960 | yes | no |
| H100 | 14 | 16 | 1 | 0.00002 | 160 | 96 | 1024 | 8 | 960 | yes | yes |
| H200 | 14 | 6 | 3 | 0.00002 | 180 | 40 | 1024 | 8 | 960 | yes | no |
| B200 | 16 | 8 | 2 | 0.00002 | 200 | 48 | 1280 | 8 | 960 | yes | no |

## Manual submission

```powershell
python docker_scripts/modal_training_launcher.py submit-training-job --job-id <training_job_uuid> --training-kind surya_bubble_ocr --params-json "{\"gpu\":\"L40S\"}"
```

LightOn OCR text training uses the same launcher:

```powershell
python docker_scripts/modal_training_launcher.py submit-training-job --job-id <training_job_uuid> --training-kind lighton_ocr --params-json "{\"gpu\":\"L40S\",\"hf_repo\":\"Remidesbois/LightonOCR-2-1b-poneglyph\"}"
```

YOLO26n + PP-OCRv6 bubble-line training is one combined job. Use H100 for the
fast profile:

```powershell
python docker_scripts/modal_training_launcher.py submit-training-job --job-id <training_job_uuid> --training-kind ppocrv6_bubble_line --params-json "{\"gpu\":\"H100\",\"hf_repo\":\"Remidesbois/pp-ocrv6-one-piece-bubble-line-rec\"}"
```

On Windows, use `--params-file` when JSON quoting gets in the way:

```powershell
$paramsPath = "$env:TEMP\poneglyph-train-dry-run.json"
@{ gpu = "L40S"; dry_run = $true; skip_upload = $true } | ConvertTo-Json -Compress | Set-Content -LiteralPath $paramsPath -Encoding UTF8
python docker_scripts/modal_training_launcher.py submit-train-model --job-id <training_job_uuid> --training-kind surya_bubble_ocr --params-file $paramsPath
```

`dry_run=true` reloads the Modal Volume, verifies the dataset path, runs the package dry-run, and does not create a `model_versions` candidate.

The backend admin API uses the same launcher. A submitted job writes the dataset to:

```text
/mnt/poneglyph_datasets/<job_id>/<dataset_kind>/
```

The CPU function prepares the dataset under `/tmp` first, copies the final dataset into the Modal Volume, writes `dataset_manifest.json`, and commits the volume. The GPU function reloads the volume, runs the existing package `run_pipeline.py`, uploads to Hugging Face when `HF_TOKEN` is available, and writes metrics/status back to Supabase.
