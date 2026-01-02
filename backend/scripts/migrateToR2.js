// backend/scripts/migrateToR2.js
require('dotenv').config(); // Charge les variables du .env à la racine du backend
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const mime = require('mime-types');

// --- CONFIGURATION ---
const SUPABASE_BUCKET_NAME = 'manga-pages'; // Le nom de votre bucket actuel sur Supabase

// 1. Client Supabase (BDD)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // INDISPENSABLE pour écrire en BDD sans être loggué
);

// 2. Client S3 (Cloudflare R2)
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'manga-pages';
// On s'assure qu'il n'y a pas de '/' à la fin de l'URL de base pour éviter les doubles slashes
const R2_PUBLIC_URL_BASE = process.env.R2_PUBLIC_URL.replace(/\/$/, ""); 

const migrate = async () => {
  console.log("🚀 Démarrage de la migration vers R2...");

  // 1. Récupérer toutes les pages
  // On utilise le scroll ou une limite haute si vous avez énormément de pages. 
  // Ici on prend tout (attention si > 10 000 pages, il faudra paginer)
  const { data: pages, error } = await supabase
    .from('pages')
    .select('id, url_image')
    .order('id', { ascending: true });

  if (error) {
    console.error("❌ Erreur lors de la récupération des pages:", error);
    return;
  }

  console.log(`📦 ${pages.length} pages trouvées dans la base de données.`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const page of pages) {
    const currentUrl = page.url_image;

    // A. Vérification de sécurité
    if (!currentUrl) {
      console.warn(`⚠️ Page ${page.id} sans URL. Ignorée.`);
      errorCount++;
      continue;
    }

    // B. Vérifier si la page est DÉJÀ sur R2 (pour éviter de refaire le travail)
    if (currentUrl.startsWith(R2_PUBLIC_URL_BASE)) {
      // console.log(`⏩ Page ${page.id} déjà migrée.`);
      skipCount++;
      continue;
    }

    try {
      // C. Extraire le chemin relatif (le "path" du fichier)
      // URL Supabase typique : https://xxx.supabase.co/storage/v1/object/public/manga-pages/tome-1/chapitre-1/image.jpg
      // On veut récupérer : tome-1/chapitre-1/image.jpg
      
      // On splitte l'URL par le nom du bucket pour récupérer la partie droite
      const urlParts = currentUrl.split(`/${SUPABASE_BUCKET_NAME}/`);
      
      if (urlParts.length < 2) {
        throw new Error(`Format d'URL non reconnu : ${currentUrl}`);
      }

      // decodeURI gère les espaces (%20) ou caractères spéciaux dans l'URL originale
      const relativePath = decodeURI(urlParts[1]);

      console.log(`🔄 Migration Page ${page.id} : ${relativePath}`);

      // D. Télécharger l'image depuis Supabase (en mémoire RAM)
      const response = await axios.get(currentUrl, { responseType: 'arraybuffer' });
      const fileBuffer = Buffer.from(response.data, 'binary');
      
      // Détection du Content-Type correct
      const contentType = response.headers['content-type'] || mime.lookup(relativePath) || 'application/octet-stream';

      // E. Upload vers Cloudflare R2
      await s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: relativePath,
        Body: fileBuffer,
        ContentType: contentType,
        // CacheControl: 'public, max-age=31536000', // Optionnel : Cache long
      }));

      // F. Mise à jour de la base de données
      const newUrl = `${R2_PUBLIC_URL_BASE}/${relativePath}`; // R2_PUBLIC_URL_BASE ne doit pas avoir de slash final

      const { error: updateError } = await supabase
        .from('pages')
        .update({ url_image: newUrl })
        .eq('id', page.id);

      if (updateError) throw updateError;

      console.log(`✅ Page ${page.id} terminée.`);
      successCount++;

    } catch (err) {
      console.error(`❌ Erreur sur la Page ${page.id} (${currentUrl}):`, err.message);
      errorCount++;
    }
  }

  console.log("\n📊 Bilan de la migration :");
  console.log(`✅ Migrés avec succès : ${successCount}`);
  console.log(`⏩ Déjà à jour (passés) : ${skipCount}`);
  console.log(`❌ Erreurs : ${errorCount}`);
};

migrate();