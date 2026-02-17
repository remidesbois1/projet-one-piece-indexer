const axios = require('axios');

const VOYAGE_API_URL_EMBED = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_API_URL_RERANK = 'https://api.voyageai.com/v1/rerank';
const VOYAGE_MODEL_EMBED = 'voyage-4-large';
const VOYAGE_MODEL_RERANK = 'rerank-2.5';

async function generateVoyageEmbedding(text, inputType = null) {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
        throw new Error('VOYAGE_API_KEY is not defined in environment variables.');
    }

    try {
        const payload = {
            model: VOYAGE_MODEL_EMBED,
            input: [text],
            output_dimension: 1024
        };

        if (inputType) {
            payload.input_type = inputType;
        }

        const response = await axios.post(
            VOYAGE_API_URL_EMBED,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                }
            }
        );

        if (response.data && response.data.data && response.data.data.length > 0) {
            return response.data.data[0].embedding;
        } else {
            throw new Error('No embedding returned from Voyage AI.');
        }
    } catch (error) {
        console.error('Error generating Voyage embedding:', error.response ? error.response.data : error.message);
        throw error;
    }
}


/**
 * Reranks a list of documents using Voyage AI.
 * @param {string} query - The search query.
 * @param {Array<string>} documents - The list of document texts to rerank.
 * @returns {Promise<Array<{index: number, relevance_score: number}>>} - The reranked results.
 */
async function rerankVoyage(query, documents) {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
        throw new Error('VOYAGE_API_KEY is not defined in environment variables.');
    }

    try {
        const payload = {
            model: VOYAGE_MODEL_RERANK,
            query: query,
            documents: documents,
            top_k: documents.length
        };

        const response = await axios.post(
            VOYAGE_API_URL_RERANK,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                }
            }
        );

        if (response.data && response.data.data) {
            return response.data.data;
        } else {
            throw new Error('No reranking results returned from Voyage AI.');
        }
    } catch (error) {
        console.error('Error reranking with Voyage:', error.response ? error.response.data : error.message);
        throw error;
    }
}

module.exports = { generateVoyageEmbedding, rerankVoyage };
