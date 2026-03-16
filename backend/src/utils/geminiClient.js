const axios = require('axios');

const GEMINI_EMBED_MODEL = 'gemini-embedding-2-preview';

async function generateGeminiEmbedding(text, taskType = "RETRIEVAL_QUERY", imageUrl = null) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY is not defined.');

    const parts = [];

    if (text) parts.push({ text: text.trim() });

    if (imageUrl) {
        try {
            const imageResponse = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 20000,
                headers: { 'User-Agent': 'OnePieceIndexer/1.0' }
            });
            const imgBase64 = Buffer.from(imageResponse.data).toString('base64');
            const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
            parts.push({ inlineData: { mimeType: contentType, data: imgBase64 } });
        } catch (imgError) {
            console.warn(`[Gemini Embed] Image skipped (${imageUrl}): ${imgError.message}`);
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
