const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const { supabaseAdmin } = require('../config/supabaseClient');

function fileToGenerativePart(buffer, mimeType) {
    return {
        inlineData: {
            data: buffer.toString("base64"),
            mimeType
        },
    };
}

const analyzeWithGeminiVision = async (imageUrl, coords, apiKey) => {
    try {
        const parsedUrl = new URL(imageUrl);
        const allowedHosts = [];
        if (process.env.SUPABASE_URL) allowedHosts.push(new URL(process.env.SUPABASE_URL).hostname);
        if (process.env.R2_PUBLIC_URL) {
            try { allowedHosts.push(new URL(process.env.R2_PUBLIC_URL).hostname); } catch (e) { }
        }

        if (!allowedHosts.some(host => parsedUrl.hostname.endsWith(host))) {
            throw new Error("Sécurité : Tentative de téléchargement hors du domaine autorisé (SSRF protection).");
        }

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

        const prompt = process.env.ANALYSIS_PROMPT;

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

router.get('/metadata-suggestions', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('pages')
            .select('description')
            .not('description', 'is', null);

        if (error) throw error;

        const characters = new Set();
        const arcs = new Set();

        data.forEach(item => {
            let desc = item.description;
            if (typeof desc === 'string') {
                try { desc = JSON.parse(desc); } catch (e) { return; }
            }

            if (desc?.metadata) {
                if (Array.isArray(desc.metadata.characters)) {
                    desc.metadata.characters.forEach(c => {
                        if (c && typeof c === 'string') characters.add(c.trim());
                    });
                }
                if (desc.metadata.arc && typeof desc.metadata.arc === 'string') {
                    arcs.add(desc.metadata.arc.trim());
                }
            }
        });

        res.status(200).json({
            characters: Array.from(characters).sort((a, b) => a.localeCompare(b)),
            arcs: Array.from(arcs).sort((a, b) => a.localeCompare(b))
        });
    } catch (error) {
        console.error("Erreur suggestions:", error);
        res.status(500).json({ error: "Erreur lors de la récupération des suggestions." });
    }
});

module.exports = router;