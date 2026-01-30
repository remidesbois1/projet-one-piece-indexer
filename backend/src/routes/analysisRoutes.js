const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const { supabaseAdmin } = require('../config/supabaseClient');



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