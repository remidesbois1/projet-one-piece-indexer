const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const { supabaseAdmin } = require('../config/supabaseClient');



const { generateVoyageEmbedding } = require('../utils/voyageClient');



router.post('/page-description', authMiddleware, async (req, res) => {
    const { id_page, description } = req.body;

    if (!id_page || !description) {
        return res.status(400).json({ error: 'Données manquantes (id_page ou description).' });
    }

    try {
        const { data: glossaryData } = await supabaseAdmin.from('glossary').select('*');
        const glossaryDict = glossaryData || [];

        let textToEmbed = "";
        let jsonDesc = description;

        if (typeof description === 'string') {
            try {
                jsonDesc = JSON.parse(description);
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON description format." });
            }
        }

        if (typeof jsonDesc !== 'object' || jsonDesc === null) {
            return res.status(400).json({ error: "Description must be a valid JSON object." });
        }

        const charactersList = jsonDesc.metadata?.characters || [];
        const arc = jsonDesc.metadata?.arc || "";

        let enrichedKeywords = new Set();

        charactersList.forEach(charName => {
            if (!charName) return;
            const lowerChar = charName.toLowerCase().trim();

            const entry = glossaryData.find(g =>
                g.aliases && g.aliases.some(alias => alias.toLowerCase() === lowerChar)
            );

            if (entry && Array.isArray(entry.aliases)) {
                entry.aliases.forEach(a => enrichedKeywords.add(a));
            }
        });

        const keywordsString = Array.from(enrichedKeywords).join(" ");
        const charactersString = charactersList.join(" ");

        textToEmbed = `${jsonDesc.content || ""} ${charactersString} ${arc} ${keywordsString}`;

        console.log(`[Embedding] Génération pour la page ${id_page}... (Texte enrichi de ${Math.round(textToEmbed.length)} chars)`);
        const embeddingVector = await generateVoyageEmbedding(textToEmbed, "document");

        const { error } = await supabaseAdmin
            .from('pages')
            .update({
                description: description,
                embedding_voyage: embeddingVector
            })
            .eq('id', id_page);

        if (error) throw error;

        res.status(200).json({ success: true, message: "Description et vecteurs (Voyage) mis à jour." });

    } catch (error) {
        console.error("Erreur sauvegarde description:", error);
        res.status(500).json({ error: error.message || "Erreur interne." });
    }
});



router.get('/metadata-suggestions', async (req, res) => {
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