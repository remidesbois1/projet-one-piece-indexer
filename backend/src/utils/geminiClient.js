const axios = require('axios');
const { readPageImage } = require('./pageStorage');
const { logger } = require('./logger');

const GEMINI_EMBED_MODEL = 'gemini-embedding-2-preview';

async function generateGeminiEmbedding(text, taskType = "RETRIEVAL_QUERY", imageUrl = null) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY is not defined.');

    const parts = [];

    if (text) parts.push({ text: text.trim() });

    if (imageUrl) {
        try {
            const { buffer, contentType } = await readPageImage(imageUrl);
            const imgBase64 = buffer.toString('base64');
            parts.push({ inlineData: { mimeType: contentType, data: imgBase64 } });
        } catch (imgError) {
            logger.warn('gemini_embedding_image_skipped', {
                error_code: imgError?.code || imgError?.name || 'IMAGE_READ_FAILED',
            });
        }
    }

    if (parts.length === 0) throw new Error('No content to embed.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${apiKey}`;

    const response = await axios.post(url, {
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts },
        taskType
    });

    const embedding = response.data?.embedding?.values;
    if (!embedding) throw new Error('No embedding returned from Gemini API.');
    return embedding;
}

module.exports = { generateGeminiEmbedding };
