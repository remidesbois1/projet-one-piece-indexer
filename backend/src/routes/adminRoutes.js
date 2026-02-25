const express = require('express');
const router = express.Router();
const { authMiddleware, roleCheck } = require('../middleware/auth');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const { supabaseAdmin } = require('../config/supabaseClient');
const { logBubbleHistory } = require('../utils/auditLogger');
const { generateGeminiEmbedding } = require('../utils/geminiClient');
const { generateVoyageEmbedding } = require('../utils/voyageClient');

// Ensure environment variables are loaded
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const r2Config = {
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
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

router.post('/chapitres/upload', authMiddleware, roleCheck(['Admin']), upload.single('cbzFile'), async (req, res) => {
  const { tome_id, numero, titre } = req.body;
  const file = req.file;

  if (!tome_id || !numero || !titre || !file) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "tome_id, numero, titre et un fichier sont requis." });
  }

  try {
    const { data: newChapitre, error: chapError } = await supabaseAdmin
      .from('chapitres')
      .insert({ id_tome: tome_id, numero: parseInt(numero), titre: titre })
      .select()
      .single();

    if (chapError) {
      if (chapError.code === '23505') return res.status(409).json({ error: `Le chapitre ${numero} existe déjà.` });
      throw chapError;
    }

    console.log(`[Upload] Chapitre ${newChapitre.id} créé. Traitement R2...`);

    const fileStream = fs.createReadStream(file.path);
    const zip = fileStream.pipe(unzipper.Parse({ forceStream: true }));

    let pageCounter = 1;
    const validImageExtensions = /\.(webp|jpg|avif|jpeg|png)$/i;
    const errors = [];

    for await (const entry of zip) {
      const fileName = entry.path;
      const fileType = entry.type;

      if (fileType === 'File' && validImageExtensions.test(fileName) && !fileName.includes('__MACOSX')) {
        try {
          const fileBuffer = await entry.buffer();

          const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '');
          const extension = path.extname(safeFileName);
          const contentType = mime.lookup(extension) || 'application/octet-stream';

          const storagePath = `tome-${tome_id}/chapitre-${numero}/${pageCounter}-${safeFileName}`;

          await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: storagePath,
            Body: fileBuffer,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000',
          }));

          const publicUrl = `${PUBLIC_URL_BASE}/${storagePath}`;

          // Insertion de la page en BDD Supabase
          const { error: pageError } = await supabaseAdmin
            .from('pages')
            .insert({
              id_chapitre: newChapitre.id,
              numero_page: pageCounter,
              url_image: publicUrl,
              statut: 'not_started'
            });

          if (pageError) throw pageError;

          pageCounter++;

        } catch (err) {
          console.error(`Erreur image ${fileName}:`, err);
          errors.push(`Erreur sur ${fileName}: ${err.message}`);
        }
      } else {
        entry.autodrain();
      }
    }

    res.status(201).json({
      message: `Chapitre ${numero} migré sur R2 avec succès. ${pageCounter - 1} pages traitées.`,
      warnings: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error("Erreur S3:", error);
    res.status(500).json({ error: "Echec du traitement.", details: error.message });
  } finally {
    if (file && fs.existsSync(file.path)) {
      fs.unlink(file.path, () => { });
    }
  }
});

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

const AI_MODEL_KEYS = ['model_ocr', 'model_reranking', 'model_description'];
const DEFAULT_MODELS = {
  model_ocr: 'gemini-2.5-flash-lite',
  model_reranking: 'gemini-2.5-flash-lite',
  model_description: 'gemini-3-flash-preview'
};

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
    models[row.key] = row.value;
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
  const { model_ocr, model_reranking, model_description } = req.body;

  try {
    const updates = [];
    if (model_ocr) updates.push({ key: 'model_ocr', value: model_ocr });
    if (model_reranking) updates.push({ key: 'model_reranking', value: model_reranking });
    if (model_description) updates.push({ key: 'model_description', value: model_description });

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

let availableModelsCache = null;
let availableModelsCacheTime = 0;
const AVAILABLE_CACHE_TTL = 60 * 60 * 1000;

router.get('/ai-models/available', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const now = Date.now();
    if (availableModelsCache && (now - availableModelsCacheTime) < AVAILABLE_CACHE_TTL) {
      return res.json(availableModelsCache);
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GOOGLE_API_KEY non configurée sur le serveur." });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
    );
    if (!response.ok) throw new Error(`Google API error: ${response.status}`);

    const data = await response.json();
    const models = (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({
        id: m.name.replace('models/', ''),
        displayName: m.displayName,
        description: m.description,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    availableModelsCache = models;
    availableModelsCacheTime = now;
    res.json(models);
  } catch (error) {
    console.error("Erreur list available models:", error);
    res.status(500).json({ error: "Erreur récupération des modèles disponibles." });
  }
});

let freeTierCache = null;
let freeTierCacheTime = 0;
const FREE_TIER_CACHE_TTL = 24 * 60 * 60 * 1000;

async function pingModel(modelId, apiKey) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "1" }] }],
          generationConfig: { maxOutputTokens: 1 }
        })
      }
    );

    if (response.ok) return { id: modelId, freeTier: true };

    if (response.status === 429) {
      const body = await response.json();
      const msg = body.error?.message || '';
      if (msg.includes('limit: 0')) {
        return { id: modelId, freeTier: false };
      }
      return { id: modelId, freeTier: true };
    }

    return { id: modelId, freeTier: null };
  } catch {
    return { id: modelId, freeTier: null };
  }
}

async function processInBatches(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

router.get('/ai-models/check-availability', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  try {
    const now = Date.now();
    if (freeTierCache && (now - freeTierCacheTime) < FREE_TIER_CACHE_TTL) {
      return res.json(freeTierCache);
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GOOGLE_API_KEY non configurée sur le serveur." });

    let models = availableModelsCache;
    if (!models) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
      );
      if (!response.ok) throw new Error(`Google API error: ${response.status}`);
      const data = await response.json();
      models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => ({ id: m.name.replace('models/', '') }));
    }

    const results = await processInBatches(
      models.map(m => m.id),
      (id) => pingModel(id, apiKey),
      5
    );

    const availability = {};
    results.forEach(r => { availability[r.id] = r.freeTier; });

    freeTierCache = availability;
    freeTierCacheTime = now;
    res.json(availability);
  } catch (error) {
    console.error("Erreur check availability:", error);
    res.status(500).json({ error: "Erreur vérification disponibilité." });
  }
});

router.post('/upload/page', authMiddleware, roleCheck(['Admin']), upload.single('file'), async (req, res) => {
  const { key } = req.body;
  const file = req.file;

  if (!key || !file) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "key et file sont requis." });
  }

  try {
    const fileBuffer = fs.readFileSync(file.path);
    const contentType = file.mimetype || 'image/avif';

    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    }));

    const publicUrl = `${PUBLIC_URL_BASE}/${key}`;
    res.json({ url: publicUrl });
  } catch (error) {
    console.error("Erreur upload page:", error);
    res.status(500).json({ error: "Erreur upload vers R2." });
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
    const { data, error } = await supabaseAdmin
      .from('pages')
      .select('id, description, embedding_voyage, embedding_gemini, id_chapitre, numero_page, statut')
      .order('id_chapitre', { ascending: true })
      .order('numero_page', { ascending: true });

    if (error) throw error;

    const stats = data.map(page => ({
      id: page.id,
      chapitre_id: page.id_chapitre,
      numero: page.numero_page,
      has_voyage: page.embedding_voyage !== null,
      has_gemini: page.embedding_gemini !== null,
      has_description: page.description !== null && page.description !== '',
      statut: page.statut
    }));

    res.json(stats);
  } catch (error) {
    console.error("Erreur embedding-stats:", error);
    res.status(500).json({ error: "Erreur lors de la récupération des statistiques d'embeddings." });
  }
});

router.post('/ai-models/trigger-backfill', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  // We trigger this asynchronously and return immediately to avoid timeout
  res.json({ message: "Processus de backfill démarré en tâche de fond." });

  (async () => {
    try {
      console.log("[Backfill] Démarrage du backfill Gemini...");

      // Step 1: Get pages where embedding_gemini is null and we have either a description or validated bulles.
      // Easiest is to get all pages without gemini embedding. 
      const { data: pagesToProcess, error: pagesError } = await supabaseAdmin
        .from('pages')
        .select(`
            id,
            description,
            bulles ( texte_propose, statut )
        `)
        .is('embedding_gemini', null);

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
            // Call Gemini for embedding (using backend key implicitly stored in env)
            // Need to use process.env.GOOGLE_API_KEY inside generateGeminiEmbedding, which it does.
            const embedding = await generateGeminiEmbedding(contentToEmbed, "RETRIEVAL_DOCUMENT");

            // Save it back to supabase
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
          // Small delay to prevent rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`[Backfill] Terminé. Traitées: ${processed}, Erreurs: ${errors}`);
    } catch (e) {
      console.error("[Backfill] Erreur globale lors du backfill:", e);
    }
  })();
});

router.post('/ai-models/trigger-backfill-voyage', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  // We trigger this asynchronously and return immediately to avoid timeout
  res.json({ message: "Processus de backfill Voyage démarré en tâche de fond." });

  (async () => {
    try {
      console.log("[Backfill Voyage] Démarrage du backfill Voyage...");

      const { data: pagesToProcess, error: pagesError } = await supabaseAdmin
        .from('pages')
        .select(`
            id,
            description,
            bulles ( texte_propose, statut )
        `)
        .is('embedding_voyage', null);

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
            // Call Voyage for embedding
            const embedding = await generateVoyageEmbedding(contentToEmbed, "document");

            // Save it back to supabase
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
          // Small delay to prevent rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`[Backfill Voyage] Terminé. Traitées: ${processed}, Erreurs: ${errors}`);
    } catch (e) {
      console.error("[Backfill Voyage] Erreur globale lors du backfill:", e);
    }
  })();
});
router.post('/ai-models/normalize-descriptions', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const userGeminiKey = req.headers['x-user-gemini-key'];
  if (!userGeminiKey) {
    return res.status(403).json({ error: "Une clé API Gemini est requise." });
  }

  res.json({ message: "Normalisation des descriptions démarrée en tâche de fond." });

  (async () => {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      console.log("[Normalize] Démarrage de la normalisation des noms de personnages...");

      const { data: pages, error: pagesError } = await supabaseAdmin
        .from('pages')
        .select('id, description')
        .not('description', 'is', null);

      if (pagesError) throw pagesError;

      const pagesWithDesc = pages.filter(p => {
        if (!p.description) return false;
        try {
          const d = typeof p.description === 'string' ? JSON.parse(p.description) : p.description;
          return d.metadata?.characters?.length > 0;
        } catch { return false; }
      });

      console.log(`[Normalize] ${pagesWithDesc.length} pages avec personnages à traiter.`);

      const genAI = new GoogleGenerativeAI(userGeminiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        systemInstruction: `Tu es un expert One Piece. On te donne une description JSON d'une page de manga.
Ta SEULE mission : remplacer les noms de personnages français/incorrects par les noms officiels.
Exemples : Pipo → Usopp, Chapeau de Paille → Luffy (ou Mugiwara), Hermep → Helmeppo, Kobby → Koby, Sanji la jambe noire → Sanji, Zorro → Zoro, Patty → Paty, Pépé → Zeff, Sandy → Sanji, Baggy → Buggy.
NE CHANGE RIEN D'AUTRE. Garde exactement la même structure JSON. Renvoie UNIQUEMENT le JSON modifié, sans markdown ni explication.`
      });

      let processed = 0, errors = 0;

      for (const page of pagesWithDesc) {
        try {
          let desc = typeof page.description === 'string' ? JSON.parse(page.description) : page.description;
          const descStr = JSON.stringify(desc);

          const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: descStr }] }],
            generationConfig: { temperature: 0.0, maxOutputTokens: 2048 }
          });

          let responseText = result.response.text().trim();
          responseText = responseText.replace(/```json|```/gi, '').trim();
          const normalizedDesc = JSON.parse(responseText);

          const normalizedStr = JSON.stringify(normalizedDesc);
          const { error: updateError } = await supabaseAdmin
            .from('pages')
            .update({ description: normalizedStr, embedding_voyage: null, embedding_gemini: null })
            .eq('id', page.id);

          if (updateError) {
            console.error(`[Normalize] Erreur update page ${page.id}:`, updateError);
            errors++;
            continue;
          }

          let contentToEmbed = normalizedDesc.content || '';
          if (normalizedDesc.metadata?.characters) {
            contentToEmbed += ' ' + normalizedDesc.metadata.characters.join(' ');
          }
          contentToEmbed = contentToEmbed.trim();

          if (contentToEmbed.length > 0) {
            try {
              const [voyageEmb, geminiEmb] = await Promise.all([
                generateVoyageEmbedding(contentToEmbed, "document"),
                generateGeminiEmbedding(contentToEmbed, "RETRIEVAL_DOCUMENT")
              ]);

              await supabaseAdmin
                .from('pages')
                .update({ embedding_voyage: voyageEmb, embedding_gemini: geminiEmb })
                .eq('id', page.id);
            } catch (embErr) {
              console.error(`[Normalize] Erreur embedding page ${page.id}:`, embErr.message);
              errors++;
            }
          }

          processed++;
          console.log(`[Normalize] Page ${page.id} traitée (${processed}/${pagesWithDesc.length})`);
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (err) {
          console.error(`[Normalize] Erreur page ${page.id}:`, err.message);
          errors++;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      console.log(`[Normalize] Terminé. Traitées: ${processed}, Erreurs: ${errors}`);
    } catch (e) {
      console.error("[Normalize] Erreur globale:", e);
    }
  })();
});

module.exports = router;


