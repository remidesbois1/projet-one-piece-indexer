const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');


const fs = require('fs');
const path = require('path');

const { supabaseAdmin } = require('../config/supabaseClient');



const { generateVoyageEmbedding } = require('../utils/voyageClient');



const { generateGeminiEmbedding } = require('../utils/geminiClient');

router.post('/page-description', authMiddleware, async (req, res) => {
    const { id_page, description } = req.body;

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

        let finalDesc = jsonDesc;
        let finalDescStr = typeof description === 'string' ? description : JSON.stringify(description);



        // Get page image URL for multimodal Gemini embedding
        const { data: pageData } = await supabaseAdmin
            .from('pages')
            .select('url_image')
            .eq('id', id_page)
            .single();
        const pageImageUrl = pageData?.url_image || null;

        let contentToEmbed = finalDesc.content || '';
        if (finalDesc.metadata?.characters) {
            contentToEmbed += ' ' + finalDesc.metadata.characters.join(' ');
        }
        contentToEmbed = contentToEmbed.trim();

        console.log(`[Embedding] Génération pour la page ${id_page}... (${Math.round(contentToEmbed.length)} chars)`);

        let voyageEmb = null;
        let geminiEmb = null;

        if (contentToEmbed.length > 0) {
            const [vEmb, gEmb] = await Promise.all([
                generateVoyageEmbedding(contentToEmbed, "document").catch(e => {
                    console.error("Erreur Voyage embedding:", e.message);
                    return null;
                }),
                // Multimodal: text + image
                generateGeminiEmbedding(contentToEmbed, "RETRIEVAL_DOCUMENT", pageImageUrl).catch(e => {
                    console.error("Erreur Gemini embedding:", e.message);
                    return null;
                })
            ]);
            voyageEmb = vEmb;
            geminiEmb = gEmb;
        }


        const { error } = await supabaseAdmin
            .from('pages')
            .update({
                description: finalDescStr,
                embedding_voyage: voyageEmb,
                embedding_gemini: geminiEmb
            })
            .eq('id', id_page);

        if (error) throw error;

        res.status(200).json({ success: true, message: "Description normalisée et vecteurs (Voyage + Gemini) mis à jour." });

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