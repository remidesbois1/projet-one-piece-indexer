const express = require('express');
const router = express.Router();
const { authMiddleware, roleCheck } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const unzipper = require('unzipper');
const stream = require('stream');

// Il utilisera les variables d'environnement chargées par l'application principale
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.post('/tomes', authMiddleware, roleCheck(['Admin']), async (req, res) => {
  const { numero, titre } = req.body;
  if (!numero || !titre) {
    return res.status(400).json({ error: "Les champs 'numero' et 'titre' sont requis." });
  }
  try {
    const { data, error } = await supabaseAdmin // On utilise le client admin
      .from('tomes')
      .insert({ numero: parseInt(numero), titre: titre })
      .select()
      .single();
    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: `Le tome numéro ${numero} existe déjà.` });
        }
        throw error;
    }
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: "Erreur serveur lors de la création du tome." });
  }
});

router.post('/chapitres/upload', authMiddleware, roleCheck(['Admin']), upload.single('cbzFile'), async (req, res) => {
    const { tome_id, numero, titre } = req.body;
    const file = req.file;

    if (!tome_id || !numero || !titre || !file) {
        return res.status(400).json({ error: "tome_id, numero, titre et un fichier sont requis." });
    }

    try {
        const { data: newChapitre, error: chapError } = await supabaseAdmin // On utilise le client admin
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

        const fileStream = new stream.PassThrough();
        fileStream.end(file.buffer);
        const zip = fileStream.pipe(unzipper.Parse({ forceStream: true }));
        
        let pageCounter = 1;
        for await (const entry of zip) {
            const fileName = entry.path;
            const fileType = entry.type;
            
            if (fileType === 'File' && /\.(webp|jpg|jpeg|png)$/i.test(fileName)) {
                const fileBuffer = await entry.buffer();
                const storagePath = `tome-${tome_id}/chapitre-${numero}/${pageCounter}-${fileName}`;

                const { error: uploadError } = await supabaseAdmin.storage.from('manga-pages').upload(storagePath, fileBuffer, { contentType: 'image/jpeg', upsert: true });
                if (uploadError) throw uploadError;

                const { data: { publicUrl } } = supabaseAdmin.storage.from('manga-pages').getPublicUrl(storagePath);
                
                const { error: pageError } = await supabaseAdmin.from('pages').insert({ id_chapitre: newChapitre.id, numero_page: pageCounter, url_image: publicUrl });
                if (pageError) throw pageError;

                pageCounter++;
            } else {
                entry.autodrain();
            }
        }
        
        res.status(201).json({ message: `Chapitre ${newChapitre.numero} et ses ${pageCounter - 1} pages créés avec succès.` });

    } catch (error) {
        console.error("Erreur upload de l'upload du chapitre:", error);
        res.status(500).json({ 
            error: "Le traitement du fichier a échoué.",
            details: error.message
        });
    }
});

module.exports = router;