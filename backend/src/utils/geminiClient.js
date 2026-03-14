const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');

const GEMINI_EMBED_MODEL = 'gemini-embedding-2-preview';

/**
 * Generate a multimodal embedding using Gemini embedding-2-preview.
 * Sends both description text AND the page image for a richer vector.
 * @param {string} text - The text description to embed.
 * @param {string|null} imageUrl - Optional URL of the page image.
 * @param {string} taskType - The task type for the embedding.
 * @returns {Promise<number[]>} - The 3072d embedding vector.
 */
async function generateGeminiEmbedding(text, taskType = "RETRIEVAL_QUERY", imageUrl = null) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        throw new Error('GOOGLE_API_KEY is not defined in environment variables.');
    }

    const ai = new GoogleGenAI({ apiKey });

    try {
        const parts = [];

        // Always include text
        if (text) {
            parts.push({ text });
        }

        // Include image if URL is provided
        if (imageUrl) {
            try {
                const imageResponse = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: { 'User-Agent': 'OnePieceIndexer/1.0' }
                });

                const imageBuffer = Buffer.from(imageResponse.data);
                const imgBase64 = imageBuffer.toString('base64');

                // Determine MIME type from response or URL
                let mimeType = imageResponse.headers['content-type'] || 'image/jpeg';
                if (imageUrl.endsWith('.avif')) mimeType = 'image/avif';
                else if (imageUrl.endsWith('.webp')) mimeType = 'image/webp';
                else if (imageUrl.endsWith('.png')) mimeType = 'image/png';

                parts.push({
                    inlineData: {
                        mimeType,
                        data: imgBase64,
                    }
                });
            } catch (imgError) {
                console.warn(`[Gemini Embed] Could not download image ${imageUrl}, embedding text only:`, imgError.message);
                // Continue with text-only embedding
            }
        }

        if (parts.length === 0) {
            throw new Error('No content to embed (no text and no image).');
        }

        const response = await ai.models.embedContent({
            model: GEMINI_EMBED_MODEL,
            contents: {
                parts,
            },
            taskType,
        });

        if (response.embeddings && response.embeddings.length > 0) {
            return response.embeddings[0].values;
        } else {
            throw new Error('No embedding array returned from Gemini API.');
        }
    } catch (error) {
        console.error('Error generating Gemini embedding:', error.message);
        throw error;
    }
}

module.exports = { generateGeminiEmbedding };
