// Ce script permet d'uploader une image pour une page spécifique et de mettre à jour la BDD.
require('dotenv').config({ path: '.env' }); // Charge le .env du backend
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialisation du client Supabase
const supabaseUrl = process.env.SUPABASE_URL;
// ATTENTION: Pour les opérations d'écriture (upload, update), il faut la clé SERVICE_ROLE
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

const BUCKET_NAME = 'manga-pages';

const uploadPage = async (pageId, filePath) => {
  if (!pageId || !filePath) {
    console.error('Erreur: Vous devez fournir un ID de page et un chemin de fichier.');
    console.log('Usage: node scripts/uploadPage.js <pageId> <filePath>');
    return;
  }

  try {
    console.log(`Lecture du fichier: ${filePath}...`);
    const fileContent = fs.readFileSync(filePath);
    const fileName = `${pageId}_${path.basename(filePath)}`;

    // 1. Upload de l'image sur Supabase Storage
    console.log(`Upload de "${fileName}" vers le bucket "${BUCKET_NAME}"...`);
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, fileContent, {
        cacheControl: '3600',
        upsert: true, // Écrase le fichier s'il existe déjà
      });

    if (uploadError) throw uploadError;

    // 2. Récupération de l'URL publique
    console.log('Récupération de l\'URL publique...');
    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName);

    // 3. Mise à jour de la table 'pages' avec la nouvelle URL
    console.log(`Mise à jour de la page ${pageId} avec l'URL: ${publicUrl}`);
    const { error: updateError } = await supabase
      .from('pages')
      .update({ url_image: publicUrl })
      .eq('id', pageId);
      
    if (updateError) throw updateError;

    console.log('\n✅ Opération terminée avec succès !');

  } catch (error) {
    console.error('\n❌ Une erreur est survenue:', error.message);
  }
};

// Récupération des arguments depuis la ligne de commande
const [,, pageId, filePath] = process.argv;
uploadPage(pageId, filePath);