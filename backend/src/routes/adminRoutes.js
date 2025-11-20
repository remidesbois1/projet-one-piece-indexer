const express = require('express');
const router = express.Router();
const { authMiddleware, roleCheck } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');

// Création d'un client Supabase avec les droits d'administration (SERVICE_ROLE)
// Attention: Assure-toi que SUPABASE_SERVICE_ROLE_KEY est bien dans ton .env
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- CONFIGURATION UPLOAD STREAMING ---

// Dossier temporaire pour stocker les CBZ pendant le traitement
const UPLOAD_DIR = 'temp_uploads/';

// On s'assure que le dossier existe au démarrage
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

// Configuration Multer : Stockage Disque (et non RAM)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    // Nom unique : timestamp + random + extension originale
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// --- ROUTES ---

// Route pour créer un Tome
router.post('/tomes', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { numero, titre } = req.body;

  if (!numero || !titre) {
    return res.status(400).json({ error: "Les champs 'numero' et 'titre' sont requis." });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('tomes')
      .insert({ numero: parseInt(numero), titre: titre })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') { // Code erreur Postgres pour violation d'unicité
        return res.status(409).json({ error: `Le tome numéro ${numero} existe déjà.` });
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (error) {
    console.error("Erreur création tome:", error);
    res.status(500).json({ error: "Erreur serveur lors de la création du tome." });
  }
});

// Route pour uploader un Chapitre (CBZ) avec Streaming
router.post('/chapitres/upload', authMiddleware, roleCheck(['Admin']), upload.single('cbzFile'), async (req, res) => {
  const { tome_id, numero, titre } = req.body;
  const file = req.file;

  // Validation basique
  if (!tome_id || !numero || !titre || !file) {
    // Si Multer a déjà écrit le fichier mais que les params sont mauvais, on nettoie
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "tome_id, numero, titre et un fichier sont requis." });
  }

  try {
    // 1. Création du chapitre en base de données
    const { data: newChapitre, error: chapError } = await supabaseAdmin
      .from('chapitres')
      .insert({ id_tome: tome_id, numero: parseInt(numero), titre: titre })
      .select()
      .single();

    if (chapError) {
      if (chapError.code === '23505') {
        return res.status(409).json({ error: `Le chapitre ${numero} existe déjà pour ce tome.` });
      }
      throw chapError;
    }

    console.log(`[Upload] Chapitre ${newChapitre.id} créé. Début du traitement du fichier ${file.path}...`);

    // 2. Préparation du Streaming
    // On crée un flux de lecture depuis le fichier temporaire sur le disque
    const fileStream = fs.createReadStream(file.path);
    
    // On pipe ce flux vers unzipper
    const zip = fileStream.pipe(unzipper.Parse({ forceStream: true }));

    let pageCounter = 1;
    const validImageExtensions = /\.(webp|jpg|avif|jpeg|png)$/i;
    const errors = [];

    // 3. Boucle sur chaque fichier contenu dans le ZIP
    for await (const entry of zip) {
      const fileName = entry.path;
      const fileType = entry.type; // 'Directory' ou 'File'

      // Filtre : On ne prend que les fichiers images, et on ignore les dossiers système macOS (__MACOSX)
      if (fileType === 'File' && validImageExtensions.test(fileName) && !fileName.includes('__MACOSX')) {
        
        try {
          // On charge UNIQUEMENT l'image courante en RAM (Buffer)
          const fileBuffer = await entry.buffer();

          // Nettoyage du nom de fichier pour le stockage
          const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '');
          
          // Structure: tome-ID/chapitre-NUM/page-NUM-nomOriginal
          const storagePath = `tome-${tome_id}/chapitre-${numero}/${pageCounter}-${safeFileName}`;

          // Upload vers Supabase Storage
          const { error: uploadError } = await supabaseAdmin.storage
            .from('manga-pages')
            .upload(storagePath, fileBuffer, {
              contentType: 'image/jpeg', // Idéalement dynamique, mais image/jpeg est souvent accepté génériquement
              upsert: true
            });

          if (uploadError) throw uploadError;

          // Récupération de l'URL publique
          const { data: urlData } = supabaseAdmin.storage
            .from('manga-pages')
            .getPublicUrl(storagePath);

          // Enregistrement de la page en BDD
          const { error: pageError } = await supabaseAdmin
            .from('pages')
            .insert({
              id_chapitre: newChapitre.id,
              numero_page: pageCounter,
              url_image: urlData.publicUrl,
              statut: 'not_started'
            });

          if (pageError) throw pageError;

          // Incrément du compteur seulement si succès
          pageCounter++;

        } catch (err) {
          console.error(`Erreur lors du traitement de l'image ${fileName}:`, err);
          errors.push(`Erreur sur ${fileName}: ${err.message}`);
        }
      } else {
        // IMPORTANT : Si ce n'est pas une image valide, on doit "vider" l'entrée pour passer à la suivante
        entry.autodrain();
      }
    }

    // Fin du traitement
    if (errors.length > 0) {
      console.warn("Upload terminé avec des erreurs mineures :", errors);
    }

    res.status(201).json({
      message: `Chapitre ${numero} créé avec succès. ${pageCounter - 1} pages traitées.`,
      warnings: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error("Erreur CRITIQUE lors de l'upload du chapitre:", error);
    res.status(500).json({
      error: "Le traitement du fichier a échoué.",
      details: error.message
    });
  } finally {
    // 4. NETTOYAGE IMPÉRATIF
    // On supprime le fichier temporaire du disque serveur
    if (file && fs.existsSync(file.path)) {
      fs.unlink(file.path, (err) => {
        if (err) console.error("Erreur lors de la suppression du fichier temporaire:", err);
        else console.log(`[Cleanup] Fichier temporaire ${file.path} supprimé.`);
      });
    }
  }
});

module.exports = router;