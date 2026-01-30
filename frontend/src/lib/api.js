import axios from 'axios';
import { supabase } from './supabaseClient';

const apiClient = axios.create({
    baseURL: process.env.NEXT_PUBLIC_BACKEND_URL,
});

apiClient.interceptors.request.use(async (config) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    let googleApiKey = null;
    if (typeof window !== 'undefined') {
        googleApiKey = localStorage.getItem('google_api_key');
    }

    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    if (googleApiKey) {
        config.headers['x-google-api-key'] = googleApiKey;
    }
    return config;
});

export const getTomes = () => apiClient.get('/tomes');
export const getChapitres = (id_tome) => apiClient.get(`/chapitres/tome/${id_tome}`);
export const getPages = (id_chapitre) => apiClient.get(`/pages?id_chapitre=${id_chapitre}`);
export const getPageById = (id) => apiClient.get(`/pages/${id}`);

export const getBubblesForPage = (pageId) => apiClient.get(`/pages/${pageId}/bulles`);
export const createBubble = (bubbleData) => apiClient.post('/bulles', bubbleData);
export const updateBubbleText = (id, text) => apiClient.put(`/bulles/${id}`, { texte_propose: text });
export const updateBubbleGeometry = (id, geometry) => apiClient.put(`/bulles/${id}`, { ...geometry });
export const deleteBubble = (id) => apiClient.delete(`/bulles/${id}`);
export const reorderBubbles = (orderedBubbles) => apiClient.put('/bulles/reorder', { orderedBubbles });

export const searchBubbles = (query, page = 1, limit = 10, mode = 'keyword', filters = {}) => {
    const params = new URLSearchParams({
        q: query,
        page: page.toString(),
        limit: limit.toString(),
        mode
    });

    if (filters.characters && filters.characters.length > 0) {
        params.append('characters', JSON.stringify(filters.characters));
    }
    if (filters.arc) {
        params.append('arc', filters.arc);
    }
    if (filters.tome) {
        params.append('tome', filters.tome.toString());
    }

    return apiClient.get(`/search?${params.toString()}`);
};
export const searchSemantic = (query, limit = 10) => apiClient.get(`/search/semantic?q=${query}&limit=${limit}`);

export const getPendingBubbles = (page = 1, limit = 5) => apiClient.get(`/bulles/pending?page=${page}&limit=${limit}`);
export const validateBubble = (id) => apiClient.put(`/bulles/${id}/validate`, {});
export const validateAllBubbles = () => apiClient.put('/bulles/validate-all', {});
export const rejectBubble = (id, comment) => apiClient.put(`/bulles/${id}/reject`, { comment });
export const getPagesForReview = () => apiClient.get('/moderation/pages');
export const approvePage = (pageId) => apiClient.put(`/moderation/pages/${pageId}/approve`, {});
export const rejectPage = (pageId, comment) => apiClient.put(`/moderation/pages/${pageId}/reject`, { comment });
export const submitPageForReview = (pageId) => apiClient.put(`/pages/${pageId}/submit-review`, {});

export const createTome = (tomeData) => apiClient.post('/admin/tomes', tomeData);
export const uploadChapter = (formData) => apiClient.post('/admin/chapitres/upload', formData);


export const savePageDescription = (pageId, description) => apiClient.post('/analyse/page-description', { id_page: pageId, description });
export const getMetadataSuggestions = () => apiClient.get('/analyse/metadata-suggestions');



export const getBubbleCrop = (id) => apiClient.get(`/bulles/${id}/crop`, { responseType: 'blob' });
export const getMySubmissions = (page = 1, limit = 10) => apiClient.get(`/user/bulles?page=${page}&limit=${limit}`);
export const getStatsSummary = () => apiClient.get('/stats/summary');
export const getLandingStats = () => apiClient.get('/stats/landing');
export const getTopContributors = () => apiClient.get('/stats/top-contributors');

export const getGlossary = () => apiClient.get('/glossary');
export const addGlossaryWord = (word) => apiClient.post('/glossary', { word });
export const deleteGlossaryWord = (word) => apiClient.delete(`/glossary/${encodeURIComponent(word)}`);

export const getBubbleHistory = (id) => apiClient.get(`/bulles/${id}/history`);
export const getAdminHierarchy = () => apiClient.get('/admin/hierarchy');
export const getAdminBubblesForPage = (pageId) => apiClient.get(`/admin/pages/${pageId}/bulles`);

export const submitSearchFeedback = (feedbackData) => apiClient.post('/search/feedback', feedbackData);
