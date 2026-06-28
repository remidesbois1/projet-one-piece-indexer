const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');


const fs = require('fs');
const path = require('path');

const { supabaseAdmin } = require('../config/supabaseClient');



const { generateVoyageEmbedding } = require('../utils/voyageClient');



const { generateGeminiEmbedding } = require('../utils/geminiClient');
const { generateF2llmEmbedding } = require('../utils/f2llmClient');
const { buildPageEmbeddingText } = require('../utils/pageEmbeddingText');

router.post('/page-description', authMiddleware, async (req, res) => {
    const { id_page, description, embedding_voyage, embedding_gemini, embedding_f2llm } = req.body;

    if (!id_page || !description) {
        return res.status(400).json({ error: 'Données manquantes (id_page ou description).' });
    }

    try {
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

        let finalDescStr = typeof description === 'string' ? description : JSON.stringify(description);

        let voyageEmb = embedding_voyage || null;
        let geminiEmb = embedding_gemini || null;
        let f2llmEmb = embedding_f2llm || null;

        if (!voyageEmb || !geminiEmb || !f2llmEmb) {
            const { data: pageData } = await supabaseAdmin
                .from('pages')
                .select('url_image, bulles(texte_propose, statut)')
                .eq('id', id_page)
                .single();
            const pageImageUrl = pageData?.url_image || null;

            let contentToEmbed = jsonDesc.content || '';
            if (jsonDesc.metadata?.characters) {
                contentToEmbed += ' ' + jsonDesc.metadata.characters.join(' ');
            }
            contentToEmbed = contentToEmbed.trim();

            if (contentToEmbed.length > 0) {
                const promises = [];

                if (!voyageEmb) {
                    promises.push(generateVoyageEmbedding(contentToEmbed, "document")
                        .then(emb => voyageEmb = emb)
                        .catch(e => console.error("Erreur Voyage embedding:", e.message)));
                }

                if (!geminiEmb) {
                    promises.push(generateGeminiEmbedding(contentToEmbed, "RETRIEVAL_DOCUMENT", pageImageUrl)
                        .then(emb => geminiEmb = emb)
                        .catch(e => console.error("Erreur Gemini embedding:", e.message)));
                }

                if (!f2llmEmb) {
                    const f2llmText = buildPageEmbeddingText({ description: jsonDesc, bulles: pageData?.bulles || [] });
                    promises.push(generateF2llmEmbedding(f2llmText, "document")
                        .then(emb => f2llmEmb = emb)
                        .catch(e => console.error("Erreur F2LLM embedding:", e.message)));
                }

                await Promise.all(promises);
            }
        }

        const { error } = await supabaseAdmin
            .from('pages')
            .update({
                description: finalDescStr,
                embedding_voyage: voyageEmb,
                embedding_gemini: geminiEmb,
                embedding_f2llm: f2llmEmb
            })
            .eq('id', id_page);

        if (error) throw error;

        res.status(200).json({ success: true, message: "Description et vecteurs mis à jour." });

    } catch (error) {
        console.error("Erreur sauvegarde description:", error);
        res.status(500).json({ error: error.message || "Erreur interne." });
    }
});

router.get('/metadata-suggestions', async (req, res) => {
    const { manga } = req.query;
    try {
        let query = supabaseAdmin
            .from('pages')
            .select('description, chapitres!inner(tomes!inner(mangas!inner(slug)))')
            .not('description', 'is', null);

        if (manga) {
            query = query.eq('chapitres.tomes.mangas.slug', manga);
        }

        const { data, error } = await query;

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
