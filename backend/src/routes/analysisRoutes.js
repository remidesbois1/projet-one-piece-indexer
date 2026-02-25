const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const { supabaseAdmin } = require('../config/supabaseClient');



const { generateVoyageEmbedding } = require('../utils/voyageClient');



const { generateGeminiEmbedding } = require('../utils/geminiClient');

router.post('/page-description', authMiddleware, async (req, res) => {
    const { id_page, description } = req.body;
    const userGeminiKey = req.headers['x-user-gemini-key'];

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

        if (userGeminiKey && finalDesc.metadata && finalDesc.metadata.characters && finalDesc.metadata.characters.length > 0) {
            try {
                const genAI = new GoogleGenerativeAI(userGeminiKey);
                const model = genAI.getGenerativeModel({
                    model: 'gemini-2.5-flash-lite',
                    systemInstruction: `Tu es un expert One Piece. On te donne une description JSON d'une page de manga.
Ta SEULE mission : remplacer les noms de personnages français/incorrects par les noms officiels.
Exemples : Pipo → Usopp, Chapeau de Paille → Luffy, Hermep → Helmeppo, Kobby → Koby, Sanji la jambe noire → Sanji, Zorro → Zoro, Patty → Paty, Sandy → Sanji, Baggy → Buggy.
NE CHANGE RIEN D'AUTRE. Garde exactement la même structure JSON. Renvoie UNIQUEMENT le JSON modifié, sans markdown ni explication.`
                });

                const result = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: finalDescStr }] }],
                    generationConfig: { temperature: 0.0, maxOutputTokens: 2048 }
                });

                let responseText = result.response.text().trim();
                responseText = responseText.replace(/```json|```/gi, '').trim();
                finalDesc = JSON.parse(responseText);
                finalDescStr = JSON.stringify(finalDesc);
                console.log(`[Analyse] Description normalisée pour la page ${id_page}.`);
            } catch (normErr) {
                console.warn(`[Analyse] Échec de normalisation pour la page ${id_page}, utilisation de la description originale.`, normErr.message);
            }
        } else if (!userGeminiKey && finalDesc.metadata && finalDesc.metadata.characters && finalDesc.metadata.characters.length > 0) {
            console.log(`[Analyse] Pas de clé Gemini fournie, normalisation ignorée pour la page ${id_page}.`);
        }


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
                generateGeminiEmbedding(contentToEmbed, "RETRIEVAL_DOCUMENT").catch(e => {
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