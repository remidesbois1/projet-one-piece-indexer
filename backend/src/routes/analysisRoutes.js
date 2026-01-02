const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require("@google/generative-ai"); 
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Initialisation Supabase Admin
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function fileToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType
    },
  };
}

// Analyse Vision (Texte Bulle)
const analyzeWithGeminiVision = async (imageUrl, coords, apiKey) => {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });

    const imageResponse = await axios({ url: imageUrl, responseType: 'arraybuffer' });
    
    const inputBuffer = Buffer.from(imageResponse.data);
    const metadata = await sharp(inputBuffer).metadata();
    
    const cropOptions = {
        left: Math.max(0, Math.floor(coords.x)),
        top: Math.max(0, Math.floor(coords.y)),
        width: Math.min(metadata.width - coords.x, Math.floor(coords.w)),
        height: Math.min(metadata.height - coords.y, Math.floor(coords.h))
    };

    const croppedBuffer = await sharp(inputBuffer)
      .extract(cropOptions)
      .toFormat('png') 
      .toBuffer();

    const prompt = `
    Tu es un expert en numérisation de manga.
    Ta tâche est de transcrire le texte présent dans cette bulle de dialogue.
    
    Règles strictes :
    1. Transcris EXACTEMENT le texte visible (OCR).
    2. Corrige automatiquement les erreurs mineures d'OCR.
    3. Rétablis la casse naturelle.
    4. Ne traduis pas. Reste en Français.
    5. Renvoie UNIQUEMENT le texte final.
    `;

    const imagePart = fileToGenerativePart(croppedBuffer, "image/png");

    console.log(`[Vision] Envoi à Gemini Flash-Lite (Clé utilisateur)...`);
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    let text = response.text();

    return text.trim();

  } catch (error) {
    console.error("[Vision Error]", error.message);
    return null;
  }
};

// Fonction Embedding Text
const generateEmbedding = async (text, apiKey) => {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
        
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("[Embedding Error]", error.message);
        throw error;
    }
};

// --- ROUTES ---

router.post('/bubble', authMiddleware, async (req, res) => {
    const { id_page, x, y, w, h } = req.body;
    const userApiKey = req.headers['x-google-api-key'];

    if (!userApiKey) {
        return res.status(400).json({ error: 'Clé API Google manquante (x-google-api-key).' });
    }
    
    if (id_page === undefined || x === undefined) {
        return res.status(400).json({ error: 'Coordonnées manquantes.' });
    }

    try {
        const { data: pageData, error: pageError } = await supabaseAdmin
            .from('pages')
            .select('url_image')
            .eq('id', id_page)
            .single();

        if (pageError || !pageData) return res.status(404).json({ error: "Page introuvable." });

        const resultText = await analyzeWithGeminiVision(pageData.url_image, { x, y, w, h }, userApiKey);

        if (!resultText) {
            return res.status(200).json({ 
                texte_ocr_brut: null, 
                texte_propose: "<ÉCHEC LECTURE>" 
            });
        }

        res.status(200).json({
            texte_ocr_brut: resultText,
            texte_propose: resultText
        });

    } catch (error) {
        console.error("Erreur serveur:", error);
        res.status(500).json({ error: "Erreur interne." });
    }
});

router.post('/page-description', authMiddleware, async (req, res) => {
    const { id_page, description } = req.body;
    const userApiKey = req.headers['x-google-api-key'];

    if (!userApiKey) {
        return res.status(400).json({ error: 'Clé API Google manquante.' });
    }

    if (!id_page || !description) {
        return res.status(400).json({ error: 'Données manquantes (id_page ou description).' });
    }

    try {
        let textToEmbed = "";
        if (typeof description === 'string') {
             try {
                const jsonDesc = JSON.parse(description);
                textToEmbed = `${jsonDesc.content || ""} ${(jsonDesc.metadata?.characters || []).join(" ")} ${jsonDesc.metadata?.arc || ""}`;
             } catch (e) {
                textToEmbed = description;
             }
        } else {
             textToEmbed = `${description.content || ""} ${(description.metadata?.characters || []).join(" ")} ${description.metadata?.arc || ""}`;
        }

        console.log(`[Embedding] Génération pour la page ${id_page}...`);
        const embeddingVector = await generateEmbedding(textToEmbed, userApiKey);

        const { error } = await supabaseAdmin
            .from('pages')
            .update({ 
                description: description, 
                embedding: embeddingVector 
            })
            .eq('id', id_page);

        if (error) throw error;

        res.status(200).json({ success: true, message: "Description et vecteurs mis à jour." });

    } catch (error) {
        console.error("Erreur sauvegarde description:", error);
        res.status(500).json({ error: error.message || "Erreur interne." });
    }
});

module.exports = router;