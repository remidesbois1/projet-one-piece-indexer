const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * @route   GET /api/search
 * @desc    Recherche : Textuelle (Crops) OU Sémantique Rerankée (Pages)
 */
router.get('/', async (req, res) => {
  const { q, page = 1, limit = 10 } = req.query;
  const userApiKey = req.headers['x-google-api-key'];

  if (!q || q.length < 2) {
    return res.status(400).json({ error: "La recherche doit contenir au moins 2 caractères." });
  }

  const pageInt = parseInt(page);
  const limitInt = parseInt(limit);
  const offset = (pageInt - 1) * limitInt;

  try {
    let finalResults = [];
    let totalCount = 0;

    // ============================================================
    // MODE 1 : SÉMANTIQUE AVEC RERANKING (Retrieve & Rerank)
    // ============================================================
    if (userApiKey) {
        const genAI = new GoogleGenerativeAI(userApiKey);
        
        // --- ÉTAPE 1 : RETRIEVE (Récupération des candidats) ---
        
        const embedModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
        const embeddingResult = await embedModel.embedContent(q);
        
        const candidateLimit = 30; 
        
        const { data: candidates, error } = await supabase.rpc('match_pages', {
            query_embedding: embeddingResult.embedding.values,
            match_threshold: 0.60,
            match_count: candidateLimit
        });

        if (error) throw error;

        if (!candidates || candidates.length === 0) {
            return res.status(200).json({ results: [], totalCount: 0 });
        }

        // --- ÉTAPE 2 : RERANK (Le Juge IA) ---
        
        const rerankModel = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite", 
            generationConfig: { responseMimeType: "application/json" }
        });

        const candidatesForAI = candidates.map((c) => {
            let descContent = "";
            let description = c.description;

            if (!description) {
                return { id: c.id, text: "Pas de description" };
            }

            if (typeof description === 'object') {
                 descContent = `${description.content || ""} (Personnages: ${description.metadata?.characters?.join(', ') || 'N/A'})`;
            } 
            else if (typeof description === 'string') {
                try {
                    const json = JSON.parse(description);
                    descContent = `${json.content || ""} (Personnages: ${json.metadata?.characters?.join(', ') || 'N/A'})`;
                } catch(e) {
                    descContent = description;
                }
            }

            const finalText = String(descContent);

            return { 
                id: c.id, 
                text: finalText.substring(0, 400) 
            };
        });

        const prompt = `
        Tu es l'expert ultime de One Piece. Ta mission est de retrouver LA page spécifique recherchée par l'utilisateur parmi des candidats imparfaits.
        
        Requête utilisateur : "${q}"

        Règles de notation AGRESSIVES (Polarise tes scores) :
        
        1. **LA PAGE ÉLUE (90-100)** : Correspondance sémantique évidente. Les personnages clés sont là ET font l'action décrite. C'est indéniablement la bonne page.
        
        2. **LE DOUTE PERMIS (70-85)** : Très forte ressemblance, contexte correct, mais il manque un petit détail ou la description est floue.
        
        3. **LA SANCTION IMMÉDIATE (< 40)** : 
           - Si c'est le bon personnage mais la MAUVAISE action (ex: cherche "Luffy mange", trouve "Luffy dort") -> **SANCTIONNE (Max 30)**.
           - Si c'est la bonne action mais le MAUVAIS personnage -> **SANCTIONNE (Max 20)**.
           - Si c'est juste une page d'ambiance ou de décor -> **0**.

        Généralement il doit y avoir une page proche de 100 et le reste beaucoup plus bas.

        **Important** : Ne sois pas tiède, au contraire soit vraiement très aggressif sur la notation. Si une page ne correspond pas précisément à l'action demandée, n'hésite pas à lui mettre un score très bas (10-20), même si le personnage est présent. Je veux isoler la bonne page du bruit.

        Renvoie UNIQUEMENT un JSON : [{ "id": 123, "score": 95 }, { "id": 456, "score": 15 }]
        
        Candidats :
        ${JSON.stringify(candidatesForAI)}
        `;

        console.log(`⚖️ [Rerank] Analyse de ${candidates.length} pages via Gemini Flash...`);
        
        let scores = [];
        try {
            const rerankResult = await rerankModel.generateContent(prompt);
            scores = JSON.parse(rerankResult.response.text());
        } catch (err) {
            console.error("❌ [Rerank] Erreur IA, fallback sur score vecteur.", err.message);
            scores = candidates.map(c => ({ id: c.id, score: c.similarity * 100 }));
        }

        // --- ÉTAPE 3 : FUSION & TRI ---
        finalResults = candidates.map(c => {
            const aiData = scores.find(s => s.id === c.id);
            const finalScore = aiData ? aiData.score : 0; 

            let snippet = "";
            const desc = c.description;
            if (desc && typeof desc === 'object') {
                snippet = desc.content || "";
            } else if (typeof desc === 'string') {
                try {
                    snippet = JSON.parse(desc).content || "";
                } catch(e) { snippet = desc; }
            }

            return {
                type: 'semantic',
                id: `page-${c.id}`,
                page_id: c.id,
                url_image: c.url_image,
                content: snippet,
                // CORRECTION ICI : Ajout de la Page dans le contexte
                context: `Tome ${c.tome_numero} - Chap. ${c.chapitre_numero} - Page ${c.numero_page}`,
                similarity: finalScore / 100,
                debug_vector: c.similarity
            };
        })
        .filter(item => item.similarity >= 0.60)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limitInt);

        totalCount = finalResults.length;
    } 
    
    // ============================================================
    // MODE 2 : RECHERCHE TEXTUELLE (CLASSIQUE)
    // ============================================================
    else {
        const { data, error } = await supabase.rpc('search_bulles', {
            search_term: q,
            page_limit: limitInt,
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
            // CORRECTION ICI : Ajout de la Page dans le contexte
            context: `Tome ${b.tome_numero} - Chap. ${b.chapitre_numero} - Page ${b.numero_page}`,
            similarity: null
        }));

        totalCount = data.length > 0 ? data[0].total_count : 0;
    }

    res.status(200).json({ results: finalResults, totalCount });

  } catch (error) {
    console.error("🚨 Erreur SearchRoutes:", error.message);
    res.status(500).json({ error: "Erreur interne du moteur de recherche." });
  }
});

module.exports = router;