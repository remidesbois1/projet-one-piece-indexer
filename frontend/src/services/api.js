import axios from 'axios';
import { supabase } from '../supabaseClient';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_BACKEND_URL,
});

// Intercepteur pour ajouter les headers d'authentification et les clés API
apiClient.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const googleApiKey = localStorage.getItem('google_api_key');

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (googleApiKey) {
    config.headers['x-google-api-key'] = googleApiKey;
  }
  return config;
});

// --- API Endpoints ---

// Tomes & Chapitres
export const getTomes = () => apiClient.get('/tomes');
export const getChapitres = (id_tome) => apiClient.get(`/chapitres/tome/${id_tome}`);
export const getPages = (id_chapitre) => apiClient.get(`/pages?id_chapitre=${id_chapitre}`);
export const getPageById = (id) => apiClient.get(`/pages/${id}`);

// Bulles
export const getBubblesForPage = (pageId) => apiClient.get(`/pages/${pageId}/bulles`);
export const createBubble = (bubbleData) => apiClient.post('/bulles', bubbleData);
export const updateBubbleText = (id, text) => apiClient.put(`/bulles/${id}`, { texte_propose: text });
export const deleteBubble = (id) => apiClient.delete(`/bulles/${id}`);
export const reorderBubbles = (orderedBubbles) => apiClient.put('/bulles/reorder', { orderedBubbles });

// Recherche
export const searchBubbles = (query, page = 1, limit = 10) => {
  return apiClient.get(`/search?q=${query}&page=${page}&limit=${limit}`);
};
export const searchSemantic = (query, limit = 10) => apiClient.get(`/search/semantic?q=${query}&limit=${limit}`);

// Modération
export const getPendingBubbles = (page = 1, limit = 5) => apiClient.get(`/bulles/pending?page=${page}&limit=${limit}`);
export const validateBubble = (id) => apiClient.put(`/bulles/${id}/validate`, {});
export const validateAllBubbles = () => apiClient.put('/bulles/validate-all', {});
export const rejectBubble = (id) => apiClient.put(`/bulles/${id}/reject`, {});
export const getPagesForReview = () => apiClient.get('/moderation/pages');
export const approvePage = (pageId) => apiClient.put(`/moderation/pages/${pageId}/approve`, {});
export const rejectPage = (pageId) => apiClient.put(`/moderation/pages/${pageId}/reject`, {});
export const submitPageForReview = (pageId) => apiClient.put(`/pages/${pageId}/submit-review`, {});

// Admin
export const createTome = (tomeData) => apiClient.post('/admin/tomes', tomeData);
export const uploadChapter = (formData) => apiClient.post('/admin/chapitres/upload', formData);

// Analyse & IA
export const analyseBubble = (bubbleData) => apiClient.post('/analyse/bubble', bubbleData);
export const savePageDescription = (pageId, description) => apiClient.post('/analyse/page-description', { id_page: pageId, description });
export const getMetadataSuggestions = () => apiClient.get('/analyse/metadata-suggestions');
export const correctText = (text) => apiClient.post('/analyse/correct-text', { text });

// Utils
export const getBubbleCrop = (id) => apiClient.get(`/bulles/${id}/crop`, { responseType: 'blob' });
export const getMySubmissions = (page = 1, limit = 10) => apiClient.get(`/user/bulles?page=${page}&limit=${limit}`);
export const getStatsSummary = () => apiClient.get('/stats/summary');
export const getTopContributors = () => apiClient.get('/stats/top-contributors');