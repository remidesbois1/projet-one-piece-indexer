const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const { GoogleGenerativeAI } = require("@google/generative-ai");

router.get('/', async (req, res) => {
    const { q, page = 1, limit = 10 } = req.query;
    const userApiKey = req.headers['x-google-api-key'];

    if (!q || q.length < 2) return res.status(400).json({ error: "Recherche trop courte" });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let finalResults = [];
    let totalCount = 0;

    try {
        if (userApiKey) {
            // Recherche Vectorielle + Rerank
            const genAI = new GoogleGenerativeAI(userApiKey);
            const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
            
            const { embedding } = await embedModel.embedContent(q);
            
            const { data: candidates, error } = await supabase.rpc('match_pages', {
                query_embedding: embedding.values,
                match_threshold: 0.60,
                match_count: 30
            });

            if (error) throw error;
            if (!candidates?.length) return res.json({ results: [], totalCount: 0 });

            // Reranking IA
            const rerankModel = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash-lite", 
                generationConfig: { responseMimeType: "application/json" }
            });

            const candidatesForAI = candidates.map(c => {
                let desc = c.description;
                try {
                    if (typeof desc === 'string') desc = JSON.parse(desc);
                } catch(e) {}
                
                const content = typeof desc === 'object' 
                    ? `${desc.content || ""} (Persos: ${desc.metadata?.characters?.join(', ')})`
                    : String(desc);

                return { id: c.id, text: content.substring(0, 400) };
            });

            const prompt = `
            Requête: "${q}"
            Trouve la page exacte.
            Notation stricte:
            - 90-100: Correspondance parfaite (Action + Perso).
            - 70-85: Très proche.
            - <40: Erreur de perso ou d'action.
            Renvoie JSON: [{ "id": 123, "score": 95 }]
            Candidats: ${JSON.stringify(candidatesForAI)}`;

            let scores = [];
            try {
                const result = await rerankModel.generateContent(prompt);
                scores = JSON.parse(result.response.text());
            } catch (err) {
                scores = candidates.map(c => ({ id: c.id, score: c.similarity * 100 }));
            }

            finalResults = candidates.map(c => {
                const aiScore = scores.find(s => s.id === c.id)?.score || 0;
                return {
                    type: 'semantic',
                    id: `page-${c.id}`,
                    page_id: c.id,
                    url_image: c.url_image,
                    context: `Tome ${c.tome_numero} - Chap. ${c.chapitre_numero} - Page ${c.numero_page}`,
                    similarity: aiScore / 100
                };
            })
            .filter(r => r.similarity >= 0.60)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, parseInt(limit));

            totalCount = finalResults.length;

        } else {
            // Recherche Classique
            const { data, error } = await supabase.rpc('search_bulles', {
                search_term: q,
                page_limit: parseInt(limit),
                page_offset: offset
            });
            if (error) throw error;

            finalResults = (data || []).map(b => ({
                type: 'bubble',
                id: b.id,
                page_id: b.page_id,
                url_image: b.url_image,
                coords: { x: b.x, y: b.y, w: b.w, h: b.h },
                content: b.texte_propose,
                context: `Tome ${b.tome_numero} - Chap. ${b.chapitre_numero} - Page ${b.numero_page}`
            }));
            totalCount = data.length > 0 ? data[0].total_count : 0;
        }

        res.json({ results: finalResults, totalCount });

    } catch (error) {
        res.status(500).json({ error: "Erreur moteur de recherche" });
    }
});

module.exports = router;
