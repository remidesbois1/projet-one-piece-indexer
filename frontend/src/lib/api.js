import axios from 'axios';
import { supabase } from './supabaseClient';
import {
    bubbleCreatePayloadSchema,
    bubbleUpdatePayloadSchema,
    f2llmSearchPayloadSchema,
    keywordSearchPayloadSchema,
    moderationCommentPayloadSchema,
    ocrSearchPayloadSchema,
    paginationSchema,
    parsePositiveId,
    reorderBubblesPayloadSchema,
} from './inputSchemas';

const apiClient = axios.create({
    baseURL: process.env.NEXT_PUBLIC_BACKEND_URL,
});

apiClient.interceptors.request.use(async (config) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (typeof window !== 'undefined') {

        const pathSegments = window.location.pathname.split('/');
        const possibleSlug = pathSegments[1];

        const nonMangaRoutes = ['login', 'favicon.ico', 'api', '_next', 'manifest.json', ''];
        if (possibleSlug && !nonMangaRoutes.includes(possibleSlug)) {
            config.params = { ...config.params, manga: possibleSlug };
        }
    }

    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
});

export const getTomes = (mangaSlug, { signal } = {}) => apiClient.get('/tomes', {
    params: mangaSlug ? { manga: mangaSlug } : {},
    signal,
});
export const getChapitres = (id_tome) => apiClient.get(`/chapitres/tome/${id_tome}`);
export const getPages = (id_chapitre) => apiClient.get(`/pages?id_chapitre=${id_chapitre}`);
export const getPageById = (id) => apiClient.get(`/pages/${id}`);

export const getBubblesForPage = (pageId) => apiClient.get(`/pages/${parsePositiveId(pageId)}/bulles`);
export const createBubble = (bubbleData) => apiClient.post('/bulles', bubbleCreatePayloadSchema.parse(bubbleData));
export const updateBubbleText = (id, text) => apiClient.put(`/bulles/${parsePositiveId(id)}`, bubbleUpdatePayloadSchema.parse({ texte_propose: text }));
export const updateBubbleGeometry = (id, geometry) => apiClient.put(`/bulles/${parsePositiveId(id)}`, bubbleUpdatePayloadSchema.parse(geometry));
export const deleteBubble = (id) => apiClient.delete(`/bulles/${parsePositiveId(id)}`);
export const deleteBubblesForPage = (pageId) => apiClient.delete(`/bulles/page/${parsePositiveId(pageId)}`);
export const deleteBubblesForChapter = (chapterId) => apiClient.delete(`/bulles/chapter/${parsePositiveId(chapterId)}`);
export const reorderBubbles = (pageId, orderedBubbles) => apiClient.put('/bulles/reorder', {
    pageId: parsePositiveId(pageId),
    orderedBubbles: reorderBubblesPayloadSchema.parse(orderedBubbles),
});

export const searchBubbles = (
    query,
    page = 1,
    limit = 10,
    mode = 'keyword',
    filters = {},
    rerank = false,
    localOnly = false,
    { signal } = {}
) => {
    const request = keywordSearchPayloadSchema.parse({ query, page, limit, mode, filters, rerank, localOnly });
    const params = new URLSearchParams({
        q: request.query,
        page: request.page.toString(),
        limit: request.limit.toString(),
        mode: request.mode,
        rerank: request.rerank.toString(),
        local_only: request.localOnly.toString(),
    });

    if (request.filters.characters.length > 0) {
        params.append('characters', JSON.stringify(request.filters.characters));
    }
    if (request.filters.arc) {
        params.append('arc', request.filters.arc);
    }
    if (request.filters.tome) {
        params.append('tome', request.filters.tome.toString());
    }

    return apiClient.get(`/search?${params.toString()}`, { signal });
};
export const searchF2llmLocal = ({ query, embedding, page = 1, limit = 10, filters = {}, signal }) => {
    const request = f2llmSearchPayloadSchema.parse({ query, embedding, page, limit, filters });
    return apiClient.post('/search/f2llm-local', {
        query: request.query,
        embedding: request.embedding,
        page: request.page,
        limit: request.limit,
        characters: request.filters.characters,
        arc: request.filters.arc,
        tome: request.filters.tome,
    }, { signal });
};
export const searchOcrPageMatch = ({ bubbles, page = 1, limit = 24, filters = {}, provider = 'unknown', rawText = '', signal }) => {
    const request = ocrSearchPayloadSchema.parse({ bubbles, page, limit, filters, provider, rawText });
    return apiClient.post('/search/ocr-match', {
        bubbles: request.bubbles,
        page: request.page,
        limit: request.limit,
        provider: request.provider,
        raw_text: request.rawText,
        characters: request.filters.characters,
        arc: request.filters.arc,
        tome: request.filters.tome,
    }, { signal });
};
export const searchSemantic = (query, limit = 6) => apiClient.get(`/search/semantic?q=${query}&limit=${limit}`);

export const getPendingBubbles = (page = 1, limit = 5) => {
    const pagination = paginationSchema.parse({ page, limit });
    return apiClient.get('/bulles/pending', { params: pagination });
};
export const validateBubble = (id) => apiClient.put(`/bulles/${parsePositiveId(id)}/validate`, {});
export const validateAllBubbles = () => apiClient.put('/bulles/validate-all', {});
export const rejectBubble = (id, comment) => apiClient.put(
    `/bulles/${parsePositiveId(id)}/reject`,
    moderationCommentPayloadSchema.parse({ comment })
);
export const getPagesForReview = () => apiClient.get('/moderation/pages');
export const approvePage = (pageId) => apiClient.put(`/moderation/pages/${pageId}/approve`, {});
export const approveAllPages = () => apiClient.put('/moderation/pages/approve-all', {});
export const rejectPage = (pageId, comment) => apiClient.put(`/moderation/pages/${pageId}/reject`, { comment });
export const submitPageForReview = (pageId) => apiClient.put(`/pages/${pageId}/submit-review`, {});
export const updatePageStatus = (pageId, statut) => apiClient.put(`/pages/${pageId}/status`, { statut });

export const createTome = (tomeData, mangaSlug) => apiClient.post('/admin/tomes', tomeData, { params: mangaSlug ? { manga: mangaSlug } : {} });
export const uploadChapter = (formData, {
    idempotencyKey,
    signal,
    onUploadProgress,
} = {}) => apiClient.post('/admin/chapitres/upload', formData, {
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    signal,
    onUploadProgress,
});
export const getChapterImport = (jobId, { signal } = {}) => apiClient.get(
    `/admin/chapter-imports/${encodeURIComponent(jobId)}`,
    { signal }
);


export const savePageDescription = (pageId, description, embedding_voyage = null, embedding_gemini = null, embedding_f2llm = null) => {
    return apiClient.post('/analyse/page-description', { 
        id_page: pageId, 
        description, 
        embedding_voyage, 
        embedding_gemini,
        embedding_f2llm,
    });
};
export const getMetadataSuggestions = (mangaSlug, { signal } = {}) => apiClient.get('/analyse/metadata-suggestions', {
    params: mangaSlug ? { manga: mangaSlug } : {},
    signal,
});



export const getBubbleCrop = (id) => apiClient.get(`/bulles/${parsePositiveId(id)}/crop`, { responseType: 'blob' });
export const getMySubmissions = (page = 1, limit = 10, mangaSlug) => {
    const params = { page, limit };
    if (mangaSlug) params.manga = mangaSlug;
    return apiClient.get('/user/bulles', { params });
};
export const getStatsSummary = () => apiClient.get('/stats/summary');
export const getLandingStats = () => apiClient.get('/stats/landing');
export const getTopContributors = () => apiClient.get('/stats/top-contributors');


export const getBubbleHistory = (id) => apiClient.get(`/bulles/${parsePositiveId(id)}/history`);
export const getAdminHierarchy = () => apiClient.get('/admin/hierarchy');
export const getAdminBubblesForPage = (pageId) => apiClient.get(`/admin/pages/${pageId}/bulles`);
export const getBannedIps = () => apiClient.get('/admin/banned-ips');
export const banIp = (ip, reason) => apiClient.post('/admin/banned-ips', { ip, reason });
export const unbanIp = (ip) => apiClient.delete(`/admin/banned-ips/${ip}`);

export const getCovers = (mangaSlug) => apiClient.get('/admin/covers', { params: { manga: mangaSlug } });
export const uploadCover = (formData) => apiClient.post('/admin/covers', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
});

export const submitSearchFeedback = (feedbackData) => apiClient.post('/search/feedback', feedbackData);

export const getAiModels = () => apiClient.get('/admin/ai-models');
export const updateAiModels = (models) => apiClient.put('/admin/ai-models', models);
export const getPublicAiModels = () => apiClient.get('/admin/ai-models/public');

export const getEmbeddingStats = (mangaSlug) => apiClient.get('/admin/ai-models/embedding-stats', { params: mangaSlug ? { manga: mangaSlug } : {} });
export const triggerGeminiBackfill = (mangaSlug) => apiClient.post('/admin/ai-models/trigger-backfill', { manga: mangaSlug });
export const triggerVoyageBackfill = (mangaSlug) => apiClient.post('/admin/ai-models/trigger-backfill-voyage', { manga: mangaSlug });
export const triggerF2llmBackfill = (mangaSlug) => apiClient.post('/admin/ai-models/trigger-backfill-f2llm', { manga: mangaSlug });
export const savePageData = (data) => apiClient.post('/admin/ai-models/save-page-data', data);
export const generateVoyageEmbedding = (text) => apiClient.post('/admin/ai-models/generate-voyage-embedding', { text });
export const generateF2llmEmbedding = (text) => apiClient.post('/admin/ai-models/generate-f2llm-embedding', { text });

export const uploadPageToR2 = (formData) => apiClient.post('/admin/upload/page', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
});
export const batchCreatePages = (data) => apiClient.post('/admin/tomes/batch-pages', data);
export const getAllMangas = () => apiClient.get('/admin/mangas/all');
export const toggleMangaEnabled = (id) => apiClient.patch(`/admin/mangas/${id}/toggle`);

export const createTrainingJob = (payload) => apiClient.post('/admin/training-jobs', payload);
export const getTrainingJobs = (params = {}) => apiClient.get('/admin/training-jobs', { params });
export const getTrainingJob = (id) => apiClient.get(`/admin/training-jobs/${id}`);
export const cancelTrainingJob = (id) => apiClient.post(`/admin/training-jobs/${id}/cancel`);
export const promoteModelVersion = (id) => apiClient.post(`/admin/model-versions/${id}/promote`);
