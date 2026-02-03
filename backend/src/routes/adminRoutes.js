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

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
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

router.post('/tomes', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { numero, titre } = req.body;
  if (!numero || !titre) return res.status(400).json({ error: "Requis: numero, titre" });
  try {
    const { data, error } = await supabaseAdmin.from('tomes').insert({ numero: parseInt(numero), titre }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: `Le tome ${numero} existe déjà.` });
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
    const { data, error } = await supabaseAdmin
      .from('tomes')
      .select(`
        id, numero, titre,
        chapitres (
          id, numero, titre,
          pages (
            id, numero_page, statut, url_image,
            bulles ( count )
          )
        )
      `)
      .order('numero', { ascending: true });

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

module.exports = router;

