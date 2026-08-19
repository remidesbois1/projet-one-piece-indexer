const express = require('express');
const router = express.Router();
const { authMiddleware, roleCheck } = require('../middleware/auth');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const inputLimits = require('@poneglyph/shared/input-limits.json');

const { supabaseAdmin } = require('../config/supabaseClient');
const { logBubbleHistory } = require('../utils/auditLogger');
const { clearBubbleGeometryCache } = require('../utils/bubbleGeometry');
const { generateGeminiEmbedding } = require('../utils/geminiClient');
const { generateVoyageEmbedding } = require('../utils/voyageClient');
const { generateF2llmEmbedding } = require('../utils/f2llmClient');
const { buildPageEmbeddingText } = require('../utils/pageEmbeddingText');
const { cancelModalCall, submitTrainingJob } = require('../utils/modalTrainingLauncher');
const {
  PageStorageError,
  createPageStorageRef,
  getPrivatePagesBucketName,
  normalizePageStorageKey,
} = require('../utils/pageStorage');
const { getPageImagePath } = require('../utils/publicMedia');
const { isPageImageValidationError, preparePageUpload } = require('../services/pageUpload');
const { chapterUploadBodySchema, validateRequest } = require('../validation/requestSchemas');
const {
  chapterArchiveUploadMiddleware,
  createChapterImportHandlers,
} = require('./chapterImportRoutes');

// Ensure environment variables are loaded
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const r2Config = {
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) ? {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  } : undefined,
};

// Log warning if variables are missing
if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.warn('[AdminRoutes] Warning: R2 environment variables are missing. S3 client might not work correctly.');
}

const s3Client = new S3Client(r2Config);
const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const PUBLIC_URL_BASE = process.env.R2_PUBLIC_URL;

const UPLOAD_DIR = 'temp_uploads/';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });
const pageUpload = multer({
  storage: storage,
  limits: {
    fileSize: inputLimits.pageImageBytes,
    files: 1,
    fields: 1,
    parts: 2,
    fieldNameSize: 100,
    fieldSize: 2048,
  },
});

function uploadSinglePage(req, res, next) {
  pageUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'L’image de page dépasse la taille maximale autorisée.' });
    }
    if (String(error.code || '').startsWith('LIMIT_')) {
      return res.status(400).json({ error: 'Le formulaire d’upload de page est invalide.' });
    }
    return next(error);
  });
}
const chapterImportHandlers = createChapterImportHandlers();

const TRAINING_JOB_CONFIGS = {
  surya_bubble_ocr: {
    label: 'Surya bubble OCR',
    hfRepo: 'Remidesbois/surya-bubble-ocr-poneglyph',
  },
  surya_bbox: {
    label: 'Surya bbox OCR',
    hfRepo: 'Remidesbois/surya-ocr-2-poneglyph-bbox',
  },
  lighton_ocr: {
    label: 'LightOn OCR',
    hfRepo: 'Remidesbois/LightonOCR-2-1b-poneglyph',
  },
  ppocrv6_bubble_line: {
    label: 'YOLO26n + PP-OCRv6 bubble line',
    hfRepo: 'Remidesbois/pp-ocrv6-one-piece-bubble-line-rec',
  },
};

const TRAINING_KIND_ALIASES = {
  finetune_surya_bubble_ocr: 'surya_bubble_ocr',
  surya_bbox_ocr: 'surya_bbox',
  finetune_surya_ocr_bbox: 'surya_bbox',
  finetune_lighton_ocr: 'lighton_ocr',
  ppocrv6_line_rec: 'ppocrv6_bubble_line',
  paddleocr_line_rec: 'ppocrv6_bubble_line',
};

const ALLOWED_TRAINING_PROVIDERS = new Set(['modal', 'runpod', 'local']);
const ALLOWED_MODAL_GPUS = new Set(['A100-80GB', 'L40S', 'H100', 'H200', 'B200']);

const GPU_TRAINING_PRESETS = {
  surya_bubble_ocr: {
    L40S: { epochs: 6, batch_size: 2, grad_accum: 8, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 96, eval_steps: 300, eval_batch_size: 1, dataloader_workers: 2, early_stopping_patience: 4, save_total_limit: 4 },
    'A100-80GB': { epochs: 6, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 128, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
    H100: { epochs: 6, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 160, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
    H200: { epochs: 6, batch_size: 6, grad_accum: 3, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 192, eval_steps: 300, eval_batch_size: 3, dataloader_workers: 6, early_stopping_patience: 4, save_total_limit: 4 },
    B200: { epochs: 6, batch_size: 8, grad_accum: 2, learning_rate: 0.00005, lora_rank: 128, max_eval_samples: 0, gen_eval_samples: 224, eval_steps: 300, eval_batch_size: 4, dataloader_workers: 8, early_stopping_patience: 4, save_total_limit: 4 },
  },
  surya_bbox: {
    L40S: { epochs: 6, batch_size: 1, grad_accum: 8, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 24, eval_steps: 250, eval_batch_size: 1, dataloader_workers: 2, early_stopping_patience: 4, save_total_limit: 4 },
    'A100-80GB': { epochs: 6, batch_size: 2, grad_accum: 4, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 32, eval_steps: 250, eval_batch_size: 1, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
    H100: { epochs: 6, batch_size: 2, grad_accum: 4, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 40, eval_steps: 250, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
    H200: { epochs: 6, batch_size: 3, grad_accum: 3, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 48, eval_steps: 250, eval_batch_size: 2, dataloader_workers: 6, early_stopping_patience: 4, save_total_limit: 4 },
    B200: { epochs: 6, batch_size: 4, grad_accum: 2, learning_rate: 0.00005, lora_rank: 128, max_eval_samples: 0, gen_eval_samples: 64, eval_steps: 250, eval_batch_size: 2, dataloader_workers: 8, early_stopping_patience: 4, save_total_limit: 4 },
  },
  lighton_ocr: {
    L40S: { epochs: 8, batch_size: 2, grad_accum: 8, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 96, eval_steps: 300, eval_batch_size: 1, dataloader_workers: 2, early_stopping_patience: 4, save_total_limit: 4 },
    'A100-80GB': { epochs: 8, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 128, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
    H100: { epochs: 8, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 160, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
    H200: { epochs: 8, batch_size: 6, grad_accum: 3, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 192, eval_steps: 300, eval_batch_size: 3, dataloader_workers: 6, early_stopping_patience: 4, save_total_limit: 4 },
    B200: { epochs: 8, batch_size: 8, grad_accum: 2, learning_rate: 0.00005, lora_rank: 128, max_eval_samples: 0, gen_eval_samples: 224, eval_steps: 300, eval_batch_size: 4, dataloader_workers: 8, early_stopping_patience: 4, save_total_limit: 4 },
  },
  ppocrv6_bubble_line: {
    L40S: { epochs: 10, batch_size: 2, grad_accum: 8, learning_rate: 0.00002, max_eval_samples: 0, eval_steps: 1, dataloader_workers: 0, early_stopping_patience: 20, save_total_limit: 3, yolo_epochs: 120, yolo_batch_size: 16, yolo_imgsz: 960, yolo_patience: 30, yolo_workers: 2, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
    'A100-80GB': { epochs: 12, batch_size: 4, grad_accum: 4, learning_rate: 0.00002, max_eval_samples: 0, eval_steps: 1, dataloader_workers: 0, early_stopping_patience: 25, save_total_limit: 3, yolo_epochs: 140, yolo_batch_size: 24, yolo_imgsz: 1024, yolo_patience: 35, yolo_workers: 4, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
    H100: { epochs: 14, batch_size: 16, grad_accum: 1, learning_rate: 0.00002, max_eval_samples: 0, eval_steps: 1, dataloader_workers: 8, early_stopping_patience: 30, save_total_limit: 3, yolo_epochs: 160, yolo_batch_size: 96, yolo_imgsz: 1024, yolo_patience: 40, yolo_workers: 8, image_width: 960, train_backbone: true, pin_memory: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
    H200: { epochs: 14, batch_size: 6, grad_accum: 3, learning_rate: 0.00002, max_eval_samples: 0, eval_steps: 1, dataloader_workers: 0, early_stopping_patience: 30, save_total_limit: 3, yolo_epochs: 180, yolo_batch_size: 40, yolo_imgsz: 1024, yolo_patience: 45, yolo_workers: 8, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
    B200: { epochs: 16, batch_size: 8, grad_accum: 2, learning_rate: 0.00002, max_eval_samples: 0, eval_steps: 1, dataloader_workers: 0, early_stopping_patience: 30, save_total_limit: 3, yolo_epochs: 200, yolo_batch_size: 48, yolo_imgsz: 1280, yolo_patience: 50, yolo_workers: 8, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
  },
};

function normalizeTrainingKind(kind) {
  const normalized = TRAINING_KIND_ALIASES[kind] || kind;
  if (!TRAINING_JOB_CONFIGS[normalized]) {
    throw new Error(`Type de fine-tuning non supporté: ${kind}`);
  }
  return normalized;
}

function optionalNumber(value, field, { min = null, max = null } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} doit être un nombre.`);
  if (min !== null && parsed < min) throw new Error(`${field} doit être >= ${min}.`);
  if (max !== null && parsed > max) throw new Error(`${field} doit être <= ${max}.`);
  return parsed;
}

function buildTrainingParams(body = {}, kind) {
  const gpu = body.gpu || 'L40S';
  if (!ALLOWED_MODAL_GPUS.has(gpu)) {
    throw new Error(`GPU Modal non supporté: ${gpu}`);
  }
  const preset = GPU_TRAINING_PRESETS[kind]?.[gpu] || {};

  const params = {
    gpu,
    epochs: optionalNumber(body.epochs ?? preset.epochs, 'epochs', { min: 0.1 }),
    batch_size: optionalNumber(body.batch_size ?? preset.batch_size, 'batch_size', { min: 1 }),
    grad_accum: optionalNumber(body.grad_accum ?? preset.grad_accum, 'grad_accum', { min: 1 }),
    learning_rate: optionalNumber(body.learning_rate ?? preset.learning_rate, 'learning_rate', { min: 0 }),
    lora_rank: optionalNumber(body.lora_rank ?? preset.lora_rank, 'lora_rank', { min: 1 }),
    max_eval_samples: optionalNumber(body.max_eval_samples ?? preset.max_eval_samples, 'max_eval_samples', { min: 0 }),
    gen_eval_samples: optionalNumber(body.gen_eval_samples ?? preset.gen_eval_samples, 'gen_eval_samples', { min: 0 }),
    eval_steps: optionalNumber(body.eval_steps ?? preset.eval_steps, 'eval_steps', { min: 1 }),
    eval_batch_size: optionalNumber(body.eval_batch_size ?? preset.eval_batch_size, 'eval_batch_size', { min: 1 }),
    dataloader_workers: optionalNumber(body.dataloader_workers ?? preset.dataloader_workers, 'dataloader_workers', { min: 0 }),
    early_stopping_patience: optionalNumber(body.early_stopping_patience ?? preset.early_stopping_patience, 'early_stopping_patience', { min: 0 }),
    save_total_limit: optionalNumber(body.save_total_limit ?? preset.save_total_limit, 'save_total_limit', { min: 1 }),
    yolo_epochs: optionalNumber(body.yolo_epochs ?? preset.yolo_epochs, 'yolo_epochs', { min: 1 }),
    yolo_batch_size: optionalNumber(body.yolo_batch_size ?? preset.yolo_batch_size, 'yolo_batch_size', { min: 1 }),
    yolo_imgsz: optionalNumber(body.yolo_imgsz ?? preset.yolo_imgsz, 'yolo_imgsz', { min: 128 }),
    yolo_patience: optionalNumber(body.yolo_patience ?? preset.yolo_patience, 'yolo_patience', { min: 1 }),
    yolo_workers: optionalNumber(body.yolo_workers ?? preset.yolo_workers, 'yolo_workers', { min: 0 }),
    image_width: optionalNumber(body.image_width ?? preset.image_width, 'image_width', { min: 128 }),
    short_oversample: optionalNumber(body.short_oversample ?? preset.short_oversample, 'short_oversample', { min: 1 }),
    short_loss_weight: optionalNumber(body.short_loss_weight ?? preset.short_loss_weight, 'short_loss_weight', { min: 1 }),
    backbone_learning_rate: optionalNumber(body.backbone_learning_rate ?? preset.backbone_learning_rate, 'backbone_learning_rate', { min: 0 }),
    warmup_ratio: optionalNumber(body.warmup_ratio ?? preset.warmup_ratio, 'warmup_ratio', { min: 0, max: 1 }),
    lr_scheduler: body.lr_scheduler ?? preset.lr_scheduler,
    train_backbone: body.train_backbone ?? preset.train_backbone ?? false,
    pin_memory: body.pin_memory ?? preset.pin_memory ?? false,
    hf_repo: typeof body.hf_repo === 'string' && body.hf_repo.trim()
      ? body.hf_repo.trim()
      : TRAINING_JOB_CONFIGS[kind].hfRepo,
    skip_upload: body.skip_upload === true,
    shard_dataset: body.shard_dataset === true,
  };

  Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);
  return params;
}

function isMissingTrainingSchemaError(error) {
  return error?.code === 'PGRST205' || /training_jobs|model_versions/i.test(error?.message || '');
}

function trainingSchemaErrorResponse(res, error) {
  if (isMissingTrainingSchemaError(error)) {
    return res.status(503).json({
      error: "Schéma fine-tuning non installé.",
      details: "Appliquez backend/sql/2026-07-01_add_training_jobs.sql sur Supabase avant d'utiliser cette page.",
    });
  }
  return null;
}

router.get('/mangas/all', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('mangas').select('*').order('titre');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/mangas/:id/toggle', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { id } = req.params;
  const { data: manga, error: fetchErr } = await supabaseAdmin.from('mangas').select('enabled').eq('id', id).single();
  if (fetchErr || !manga) return res.status(404).json({ error: "Manga introuvable." });

  const { data, error } = await supabaseAdmin.from('mangas').update({ enabled: !manga.enabled }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/tomes', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { numero, titre } = req.body;
  let { manga } = req.query;
  if (Array.isArray(manga)) manga = manga[0];

  if (!numero || !titre) return res.status(400).json({ error: "Requis: numero, titre" });
  if (!manga) return res.status(400).json({ error: "Manga contexte requis." });

  try {
    const { data: mangaData, error: mangaError } = await supabaseAdmin
      .from('mangas')
      .select('id')
      .eq('slug', manga)
      .single();

    if (mangaError || !mangaData) return res.status(404).json({ error: "Manga introuvable." });

    const { data, error } = await supabaseAdmin
      .from('tomes')
      .insert({
        numero: parseInt(numero),
        titre,
        manga_id: mangaData.id
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: `Le tome ${numero} existe déjà pour ce manga.` });
    console.error("Erreur création tome:", error);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

router.post('/chapitres/upload', authMiddleware, roleCheck(['Admin']), chapterArchiveUploadMiddleware, validateRequest(
  { body: chapterUploadBodySchema },
  { onInvalid: (req) => req.file?.path && fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path) }
), chapterImportHandlers.create);

router.get('/chapter-imports/:id', authMiddleware, roleCheck(['Admin']), chapterImportHandlers.get);

router.get('/hierarchy', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
  try {
    const { manga } = req.query; // Get manga slug

    let query = supabaseAdmin
      .from('tomes')
      .select(`
        id, numero, titre,
        mangas!inner(slug),
        chapitres (
          id, numero, titre,
          pages (
            id, numero_page, statut, url_image,
            bulles ( count )
          )
        )
      `)
      .order('numero', { ascending: true });

    if (manga) {
      query = query.eq('mangas.slug', manga);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Sort nested manually if needed, or rely on client. Supabase nested order is tricky sometimes.
    // Let's sort chapters and pages in JS to be safe
    data.forEach(tome => {
      tome.chapitres.sort((a, b) => a.numero - b.numero);
      tome.chapitres.forEach(chap => {
        chap.pages.sort((a, b) => a.numero_page - b.numero_page);
        chap.pages.forEach(page => {
          page.url_image = getPageImagePath(page.id);
        });
      });
    });

    res.status(200).json(data);
  } catch (error) {
    console.error("Erreur hiérarchie:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des données." });
  }
});

router.get('/pages/:id/bulles', authMiddleware, roleCheck(['Admin', 'Modo']), async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabaseAdmin
      .from('bulles')
      .select('id, x, y, w, h, texte_propose, statut, id_user_createur, order')
      .eq('id_page', id)
      .order('order', { ascending: true });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error("Erreur bulles admin:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des bulles." });
  }
});

router.get('/banned-ips', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('banned_ips')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error("Erreur banned_ips:", error);
    res.status(500).json({ error: "Erreur récupération IPs." });
  }
});

router.post('/banned-ips', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { ip, reason } = req.body;
  if (!ip) return res.status(400).json({ error: "IP requise" });

  try {
    const { data, error } = await supabaseAdmin
      .from('banned_ips')
      .insert({ ip, reason })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: "Cette IP est déjà bannie." });
      throw error;
    }
    res.status(201).json(data);
  } catch (error) {
    console.error("Erreur ban IP:", error);
    res.status(500).json({ error: "Erreur lors du bannissement." });
  }
});

router.delete('/banned-ips/:ip', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { ip } = req.params;
  try {
    const { error } = await supabaseAdmin
      .from('banned_ips')
      .delete()
      .eq('ip', ip);

    if (error) throw error;
    res.status(200).json({ message: "IP débannie" });
  } catch (error) {
    console.error("Erreur deban IP:", error);
    res.status(500).json({ error: "Erreur lors du débannissement." });
  }
});

router.get('/covers', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { manga } = req.query;
    if (!manga) return res.status(400).json({ error: "Manga requis." });

    const { data: tomes, error } = await supabaseAdmin
      .from('tomes')
      .select('id, numero, titre, cover_url, mangas!inner(slug)')
      .eq('mangas.slug', manga)
      .order('numero', { ascending: true });

    if (error) throw error;

    const { data: mangaData, error: mangaError } = await supabaseAdmin
      .from('mangas')
      .select('id, titre, cover_url')
      .eq('slug', manga)
      .single();

    if (mangaError) throw mangaError;

    res.status(200).json({
      manga: mangaData,
      tomes: tomes
    });
  } catch (error) {
    console.error("Erreur covers:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des couvertures." });
  }
});

router.post('/covers', authMiddleware, roleCheck(['Admin']), upload.single('cover'), async (req, res) => {
  const { type, id } = req.body;
  const file = req.file;

  if (!type || !id || !file) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Type, id et fichier sont requis." });
  }

  try {
    const fileBuffer = fs.readFileSync(file.path);
    const extension = path.extname(file.originalname);
    const safeFileName = `${type}-${id}-${Date.now()}${extension}`;
    const storagePath = `covers/${safeFileName}`;
    const contentType = mime.lookup(extension) || 'image/jpeg';

    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    }));

    const publicUrl = `${PUBLIC_URL_BASE}/${storagePath}`;

    if (type === 'manga') {
      const { error } = await supabaseAdmin
        .from('mangas')
        .update({ cover_url: publicUrl })
        .eq('id', id);
      if (error) throw error;
    } else if (type === 'tome') {
      const { error } = await supabaseAdmin
        .from('tomes')
        .update({ cover_url: publicUrl })
        .eq('id', id);
      if (error) throw error;
    } else {
      throw new Error("Type invalide.");
    }

    res.status(200).json({ url: publicUrl });
  } catch (error) {
    console.error("Erreur upload cover:", error);
    res.status(500).json({ error: "Erreur lors de l'upload de la couverture." });
  } finally {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

const AI_MODEL_KEYS = [
  'model_ocr',
  'model_description',
  'model_chatgpt_ocr',
  'gemini_thinking_level',
  'chatgpt_reasoning_effort',
  'chatgpt_fast_mode',
];
const DEFAULT_MODELS = {
  model_ocr: 'gemini-2.5-flash-lite',
  model_description: 'gemini-3-flash-preview',
  model_chatgpt_ocr: 'gpt-5.6-luna',
  gemini_thinking_level: 'default',
  chatgpt_reasoning_effort: 'low',
  chatgpt_fast_mode: false,
};
const AI_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;
const GEMINI_THINKING_LEVELS = new Set(['default', 'none', 'minimal', 'low', 'medium', 'high']);
const OPENAI_REASONING_EFFORTS = new Set(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

let aiModelsCache = null;
let aiModelsCacheTime = 0;
const CACHE_TTL = 60 * 1000;

async function getAiModelsFromDb() {
  const now = Date.now();
  if (aiModelsCache && (now - aiModelsCacheTime) < CACHE_TTL) {
    return aiModelsCache;
  }

  const { data, error } = await supabaseAdmin
    .from('app_settings')
    .select('key, value')
    .in('key', AI_MODEL_KEYS);

  if (error) throw error;

  const models = { ...DEFAULT_MODELS };
  (data || []).forEach(row => {
    models[row.key] = row.key === 'chatgpt_fast_mode' ? row.value === 'true' : row.value;
  });

  aiModelsCache = models;
  aiModelsCacheTime = now;
  return models;
}

router.get('/ai-models', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const models = await getAiModelsFromDb();
    res.json(models);
  } catch (error) {
    console.error("Erreur get AI models:", error);
    res.status(500).json({ error: "Erreur récupération des modèles IA." });
  }
});

router.put('/ai-models', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const {
    model_ocr,
    model_description,
    model_chatgpt_ocr,
    gemini_thinking_level,
    chatgpt_reasoning_effort,
    chatgpt_fast_mode,
  } = req.body;

  if (![model_ocr, model_description, model_chatgpt_ocr].every(value => typeof value === 'string' && AI_MODEL_ID_PATTERN.test(value.trim()))
      || !GEMINI_THINKING_LEVELS.has(gemini_thinking_level)
      || !OPENAI_REASONING_EFFORTS.has(chatgpt_reasoning_effort)
      || typeof chatgpt_fast_mode !== 'boolean') {
    return res.status(400).json({ error: 'Configuration IA invalide.' });
  }

  try {
    const updates = [
      { key: 'model_ocr', value: model_ocr.trim() },
      { key: 'model_description', value: model_description.trim() },
      { key: 'model_chatgpt_ocr', value: model_chatgpt_ocr.trim() },
      { key: 'gemini_thinking_level', value: gemini_thinking_level },
      { key: 'chatgpt_reasoning_effort', value: chatgpt_reasoning_effort },
      { key: 'chatgpt_fast_mode', value: String(chatgpt_fast_mode) },
    ];

    for (const { key, value } of updates) {
      const { error } = await supabaseAdmin
        .from('app_settings')
        .upsert({ key, value }, { onConflict: 'key' });
      if (error) throw error;
    }

    aiModelsCache = null;
    const models = await getAiModelsFromDb();
    res.json(models);
  } catch (error) {
    console.error("Erreur update AI models:", error);
    res.status(500).json({ error: "Erreur mise à jour des modèles IA." });
  }
});

router.get('/ai-models/public', async (req, res) => {
  try {
    const models = await getAiModelsFromDb();
    res.json(models);
  } catch (error) {
    console.error("Erreur get public AI models:", error);
    res.status(500).json({ error: "Erreur récupération des modèles IA." });
  }
});

router.post('/upload/page', authMiddleware, roleCheck(['Admin']), uploadSinglePage, async (req, res) => {
  const { key } = req.body;
  const file = req.file;

  if (!key || !file) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "key et file sont requis." });
  }

  try {
    const normalizedKey = normalizePageStorageKey(key);
    const { buffer: fileBuffer, contentType } = await preparePageUpload(file.path);

    const pagesBucketName = getPrivatePagesBucketName();
    await s3Client.send(new PutObjectCommand({
      Bucket: pagesBucketName,
      Key: normalizedKey,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: 'private, no-store',
    }));
    clearBubbleGeometryCache();

    const pageStorageRef = createPageStorageRef(pagesBucketName, normalizedKey);
    res.json({ url: pageStorageRef });
  } catch (error) {
    if (error instanceof PageStorageError && error.code === 'INVALID_PAGE_KEY') {
      return res.status(400).json({ error: 'La clé de stockage de la page est invalide.' });
    }
    if (error?.code === 'PAGE_IMAGE_TOO_LARGE') {
      return res.status(413).json({ error: 'L’image de page dépasse la taille maximale autorisée.' });
    }
    if (isPageImageValidationError(error)) {
      return res.status(415).json({ error: "Le fichier doit être une image JPEG, PNG, WebP ou AVIF valide." });
    }
    console.error("Erreur upload page:", error);
    return res.status(500).json({ error: "Erreur upload vers R2." });
  } finally {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

router.post('/tomes/batch-pages', authMiddleware, roleCheck(['Admin']), express.json({ limit: '10mb' }), async (req, res) => {
  const { tome_id, chapters } = req.body;

  if (!tome_id || !chapters || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ error: "tome_id et chapters sont requis." });
  }

  try {
    const results = [];

    for (const chapter of chapters) {
      const { data: newChap, error: chapError } = await supabaseAdmin
        .from('chapitres')
        .insert({ id_tome: tome_id, numero: parseInt(chapter.numero), titre: chapter.titre })
        .select()
        .single();

      if (chapError) {
        if (chapError.code === '23505') {
          results.push({ numero: chapter.numero, error: `Le chapitre ${chapter.numero} existe déjà.` });
          continue;
        }
        throw chapError;
      }

      const pagesToInsert = chapter.pages.map(p => ({
        id_chapitre: newChap.id,
        numero_page: p.numero_page,
        url_image: p.url_image,
        statut: 'not_started'
      }));

      const { error: pagesError } = await supabaseAdmin
        .from('pages')
        .insert(pagesToInsert);

      if (pagesError) throw pagesError;

      results.push({ numero: chapter.numero, id: newChap.id, pages: pagesToInsert.length });
    }

    res.status(201).json({ message: "Batch créé avec succès.", results });
  } catch (error) {
    console.error("Erreur batch-pages:", error);
    res.status(500).json({ error: "Erreur lors de la création batch.", details: error.message });
  }
});

router.get('/ai-models/embedding-stats', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { manga } = req.query;

    let query = supabaseAdmin
      .from('pages')
      .select(`
        id, description, embedding_voyage, embedding_gemini, embedding_f2llm, id_chapitre, numero_page, statut, url_image,
        chapitres!inner(
          numero,
          tomes!inner(
            numero,
            mangas!inner(slug)
          )
        )
      `);

    if (manga) {
      query = query.eq('chapitres.tomes.mangas.slug', manga);
    }

    const { data, error } = await query;
    if (error) throw error;

    const stats = data.map(page => ({
      id: page.id,
      chapitre_id: page.id_chapitre,
      chapitre_numero: page.chapitres?.numero,
      tome_numero: page.chapitres?.tomes?.numero,
      numero: page.numero_page,
      url_image: getPageImagePath(page.id),
      has_voyage: page.embedding_voyage !== null,
      has_gemini: page.embedding_gemini !== null,
      has_f2llm: page.embedding_f2llm !== null,
      has_description: page.description !== null && page.description !== '',
      statut: page.statut
    }));

    stats.sort((a, b) => {
      if (a.tome_numero !== b.tome_numero) return (a.tome_numero || 0) - (b.tome_numero || 0);
      if (a.chapitre_numero !== b.chapitre_numero) return (a.chapitre_numero || 0) - (b.chapitre_numero || 0);
      return (a.numero || 0) - (b.numero || 0);
    });

    res.json(stats);
  } catch (error) {
    console.error("Erreur embedding-stats:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des statistiques d'embeddings." });
  }
});


router.post('/ai-models/save-page-data', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { id_page, description, embedding_voyage, embedding_gemini, embedding_f2llm } = req.body;

  if (!id_page) return res.status(400).json({ error: "Page ID requis." });

  try {
    const updateData = {};
    if (description) updateData.description = typeof description === 'string' ? description : JSON.stringify(description);
    if (embedding_voyage) updateData.embedding_voyage = embedding_voyage;
    if (embedding_gemini) updateData.embedding_gemini = embedding_gemini;
    if (embedding_f2llm) updateData.embedding_f2llm = embedding_f2llm;

    const { error } = await supabaseAdmin
      .from('pages')
      .update(updateData)
      .eq('id', id_page);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error("Erreur save-page-data:", error);
    res.status(500).json({ error: "Erreur lors de la sauvegarde des données de la page." });
  }
});

router.post('/ai-models/generate-voyage-embedding', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texte requis." });

  try {
    const embedding = await generateVoyageEmbedding(text, "document");
    res.json({ embedding });
  } catch (error) {
    console.error("Erreur generation Voyage:", error);
    res.status(500).json({ error: "Erreur lors de la génération de l'embedding Voyage." });
  }
});

router.post('/ai-models/generate-f2llm-embedding', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texte requis." });

  try {
    const embedding = await generateF2llmEmbedding(text, "document");
    res.json({ embedding });
  } catch (error) {
    console.error("Erreur generation F2LLM:", error);
    res.status(500).json({ error: error.message || "Erreur lors de la generation de l'embedding F2LLM." });
  }
});

router.post('/ai-models/trigger-backfill', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { manga } = req.query;
  res.json({ message: "Processus de backfill Gemini (multimodal) démarré en tâche de fond." });

  (async () => {
    try {
      console.log(`[Backfill] Démarrage du backfill Gemini multimodal${manga ? ` pour ${manga}` : ''}...`);

      let query = supabaseAdmin
        .from('pages')
        .select(`
            id, description, url_image,
            bulles ( texte_propose, statut ),
            chapitres!inner( tomes!inner( mangas!inner(slug) ) )
        `)
        .is('embedding_gemini', null);

      if (manga) {
        query = query.eq('chapitres.tomes.mangas.slug', manga);
      }

      const { data: pagesToProcess, error: pagesError } = await query;
      if (pagesError) throw pagesError;

      let processed = 0;
      let errors = 0;

      for (const page of pagesToProcess) {
        let contentToEmbed = "";

        if (page.description) {
          let desc = page.description;
          try {
            if (typeof desc === 'string') desc = JSON.parse(desc).content;
            else if (typeof desc === 'object') desc = desc.content;
          } catch (e) { }
          if (desc) contentToEmbed += desc + " ";
        }

        if (page.bulles && page.bulles.length > 0) {
          const texts = page.bulles
            .filter(b => b.statut === 'validated' && b.texte_propose)
            .map(b => b.texte_propose)
            .join(' ');
          if (texts) contentToEmbed += texts;
        }

        contentToEmbed = contentToEmbed.trim();

        if (contentToEmbed.length > 0) {
          try {
            const embedding = await generateGeminiEmbedding(contentToEmbed, "RETRIEVAL_DOCUMENT", page.url_image || null);

            const { error: updateError } = await supabaseAdmin
              .from('pages')
              .update({ embedding_gemini: embedding })
              .eq('id', page.id);

            if (updateError) {
              console.error(`[Backfill] Erreur Update Supabase pour la page ${page.id}:`, updateError);
              errors++;
            } else {
              processed++;
            }
          } catch (embedError) {
            console.error(`[Backfill] Erreur Gemini Embedding pour la page ${page.id}:`, embedError.message);
            errors++;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`[Backfill] Terminé. Traitées: ${processed}, Erreurs: ${errors}`);
    } catch (e) {
      console.error("[Backfill] Erreur globale lors du backfill:", e);
    }
  })();
});

router.post('/ai-models/trigger-backfill-voyage', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { manga } = req.query;
  res.json({ message: "Processus de backfill Voyage démarré en tâche de fond." });

  (async () => {
    try {
      console.log(`[Backfill Voyage] Démarrage du backfill Voyage${manga ? ` pour ${manga}` : ''}...`);

      let query = supabaseAdmin
        .from('pages')
        .select(`
            id, description,
            bulles ( texte_propose, statut ),
            chapitres!inner( tomes!inner( mangas!inner(slug) ) )
        `)
        .is('embedding_voyage', null);

      if (manga) {
        query = query.eq('chapitres.tomes.mangas.slug', manga);
      }

      const { data: pagesToProcess, error: pagesError } = await query;
      if (pagesError) throw pagesError;

      let processed = 0;
      let errors = 0;

      for (const page of pagesToProcess) {
        let contentToEmbed = "";

        if (page.description) {
          let desc = page.description;
          try {
            if (typeof desc === 'string') desc = JSON.parse(desc).content;
            else if (typeof desc === 'object') desc = desc.content;
          } catch (e) { }
          if (desc) contentToEmbed += desc + " ";
        }

        if (page.bulles && page.bulles.length > 0) {
          const texts = page.bulles
            .filter(b => b.statut === 'validated' && b.texte_propose)
            .map(b => b.texte_propose)
            .join(' ');
          if (texts) contentToEmbed += texts;
        }

        contentToEmbed = contentToEmbed.trim();

        if (contentToEmbed.length > 0) {
          try {
            const embedding = await generateVoyageEmbedding(contentToEmbed, "document");

            const { error: updateError } = await supabaseAdmin
              .from('pages')
              .update({ embedding_voyage: embedding })
              .eq('id', page.id);

            if (updateError) {
              console.error(`[Backfill Voyage] Erreur Update Supabase pour la page ${page.id}:`, updateError);
              errors++;
            } else {
              processed++;
            }
          } catch (embedError) {
            console.error(`[Backfill Voyage] Erreur Voyage Embedding pour la page ${page.id}:`, embedError.message);
            errors++;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`[Backfill Voyage] Terminé. Traitées: ${processed}, Erreurs: ${errors}`);
    } catch (e) {
      console.error("[Backfill Voyage] Erreur globale lors du backfill:", e);
    }
  })();
});

router.post('/ai-models/trigger-backfill-f2llm', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { manga } = req.query;
  res.json({ message: "Processus de backfill F2LLM demarre en tache de fond." });

  (async () => {
    try {
      console.log(`[Backfill F2LLM] Demarrage${manga ? ` pour ${manga}` : ''}...`);

      let query = supabaseAdmin
        .from('pages')
        .select(`
            id, description,
            bulles ( texte_propose, statut ),
            chapitres!inner( tomes!inner( mangas!inner(slug) ) )
        `)
        .is('embedding_f2llm', null)
        .not('description', 'is', null);

      if (manga) {
        query = query.eq('chapitres.tomes.mangas.slug', manga);
      }

      const { data: pagesToProcess, error: pagesError } = await query;
      if (pagesError) throw pagesError;

      let processed = 0;
      let skipped = 0;
      let errors = 0;

      for (const page of pagesToProcess || []) {
        const contentToEmbed = buildPageEmbeddingText(page);
        if (!contentToEmbed) {
          skipped++;
          continue;
        }

        try {
          const embedding = await generateF2llmEmbedding(contentToEmbed, "document");
          const { error: updateError } = await supabaseAdmin
            .from('pages')
            .update({ embedding_f2llm: embedding })
            .eq('id', page.id);

          if (updateError) throw updateError;
          processed++;
        } catch (embedError) {
          console.error(`[Backfill F2LLM] Erreur pour la page ${page.id}:`, embedError.message);
          errors++;
        }
      }

      console.log(`[Backfill F2LLM] Termine. Traitees: ${processed}, ignorees: ${skipped}, erreurs: ${errors}`);
    } catch (e) {
      console.error("[Backfill F2LLM] Erreur globale:", e);
    }
  })();
});

router.post('/training-jobs', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  let createdJob = null;
  try {
    const kind = normalizeTrainingKind(req.body.kind);
    const provider = req.body.provider || 'modal';
    if (!ALLOWED_TRAINING_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: `Provider non supporté: ${provider}` });
    }

    const params = buildTrainingParams(req.body.params || req.body, kind);
    const insertPayload = {
      kind,
      status: 'queued',
      provider,
      modal_volume_name: provider === 'modal' ? (process.env.PONEGLYPH_MODAL_VOLUME_NAME || 'poneglyph-datasets') : null,
      hf_repo: params.hf_repo,
      params_json: params,
      created_by: req.user.id,
    };

    const { data, error } = await supabaseAdmin
      .from('training_jobs')
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;
    createdJob = data;

    if (provider !== 'modal') {
      return res.status(201).json(createdJob);
    }

    const launch = await submitTrainingJob({
      jobId: createdJob.id,
      trainingKind: kind,
      params,
    });

    const { data: launchedJob, error: updateError } = await supabaseAdmin
      .from('training_jobs')
      .update({
        modal_call_id: launch.modal_call_id,
        modal_function_name: launch.function_name,
        summary_json: {
          launcher: launch,
          app_name: launch.app_name,
        },
      })
      .eq('id', createdJob.id)
      .select()
      .single();

    if (updateError) throw updateError;
    return res.status(201).json(launchedJob);
  } catch (error) {
    console.error("Erreur creation training job:", error);
    if (createdJob?.id) {
      await supabaseAdmin
        .from('training_jobs')
        .update({ status: 'failed', error_message: error.message })
        .eq('id', createdJob.id);
    }
    if (!createdJob) {
      const schemaResponse = trainingSchemaErrorResponse(res, error);
      if (schemaResponse) return schemaResponse;
    }
    return res.status(createdJob ? 502 : 400).json({
      error: "Impossible de lancer le fine-tuning.",
      details: error.message,
      job: createdJob,
    });
  }
});

router.get('/training-jobs', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    let query = supabaseAdmin
      .from('training_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(0, limit - 1);

    if (req.query.kind) {
      query = query.eq('kind', normalizeTrainingKind(req.query.kind));
    }
    if (req.query.status) {
      query = query.eq('status', req.query.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("Erreur list training jobs:", error);
    const schemaResponse = trainingSchemaErrorResponse(res, error);
    if (schemaResponse) return schemaResponse;
    res.status(500).json({ error: "Erreur récupération des jobs de fine-tuning.", details: error.message });
  }
});

router.get('/training-jobs/:id', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { data: job, error } = await supabaseAdmin
      .from('training_jobs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) {
      const schemaResponse = trainingSchemaErrorResponse(res, error);
      if (schemaResponse) return schemaResponse;
      return res.status(404).json({ error: "Job introuvable." });
    }
    if (!job) return res.status(404).json({ error: "Job introuvable." });

    const { data: versions, error: versionsError } = await supabaseAdmin
      .from('model_versions')
      .select('*')
      .eq('training_job_id', req.params.id)
      .order('created_at', { ascending: false });

    if (versionsError) throw versionsError;
    res.json({ ...job, model_versions: versions || [] });
  } catch (error) {
    console.error("Erreur get training job:", error);
    const schemaResponse = trainingSchemaErrorResponse(res, error);
    if (schemaResponse) return schemaResponse;
    res.status(500).json({ error: "Erreur récupération du job.", details: error.message });
  }
});

router.post('/training-jobs/:id/cancel', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { data: job, error } = await supabaseAdmin
      .from('training_jobs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) {
      const schemaResponse = trainingSchemaErrorResponse(res, error);
      if (schemaResponse) return schemaResponse;
      return res.status(404).json({ error: "Job introuvable." });
    }
    if (!job) return res.status(404).json({ error: "Job introuvable." });
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      return res.status(409).json({ error: `Job déjà terminé avec le statut ${job.status}.` });
    }

    let cancelResult = null;
    if (job.provider === 'modal' && job.modal_call_id) {
      cancelResult = await cancelModalCall({ modalCallId: job.modal_call_id, terminateContainers: true });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('training_jobs')
      .update({
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        summary_json: {
          ...(job.summary_json || {}),
          cancellation: cancelResult || { provider: job.provider, modal_call_id: job.modal_call_id || null },
        },
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) throw updateError;
    res.json(updated);
  } catch (error) {
    console.error("Erreur cancel training job:", error);
    const schemaResponse = trainingSchemaErrorResponse(res, error);
    if (schemaResponse) return schemaResponse;
    res.status(502).json({ error: "Impossible d'annuler le job.", details: error.message });
  }
});

router.post('/model-versions/:id/promote', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const { data: version, error } = await supabaseAdmin
      .from('model_versions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) {
      const schemaResponse = trainingSchemaErrorResponse(res, error);
      if (schemaResponse) return schemaResponse;
      return res.status(404).json({ error: "Version modèle introuvable." });
    }
    if (!version) return res.status(404).json({ error: "Version modèle introuvable." });

    await supabaseAdmin
      .from('model_versions')
      .update({ is_active: false })
      .eq('kind', version.kind)
      .eq('is_active', true);

    const promotedAt = new Date().toISOString();
    const { data: promoted, error: promoteError } = await supabaseAdmin
      .from('model_versions')
      .update({
        is_candidate: false,
        is_active: true,
        promoted_at: promotedAt,
      })
      .eq('id', version.id)
      .select()
      .single();

    if (promoteError) throw promoteError;

    await supabaseAdmin
      .from('app_settings')
      .upsert({
        key: `active_model_version_${version.kind}`,
        value: JSON.stringify({
          model_version_id: promoted.id,
          kind: promoted.kind,
          hf_repo: promoted.hf_repo,
          hf_revision: promoted.hf_revision,
          promoted_at: promotedAt,
        }),
      }, { onConflict: 'key' });

    res.json(promoted);
  } catch (error) {
    console.error("Erreur promotion model version:", error);
    const schemaResponse = trainingSchemaErrorResponse(res, error);
    if (schemaResponse) return schemaResponse;
    res.status(500).json({ error: "Erreur promotion du modèle.", details: error.message });
  }
});


module.exports = router;


