import axios from 'axios';

const apiClient = axios.create({
  baseURL: 'http://localhost:3001/api',
});

const getAuthHeaders = (token) => ({
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

export const getTomes = (token) => apiClient.get('/tomes', getAuthHeaders(token));
export const getChapitres = (id_tome, token) => apiClient.get(`/chapitres?id_tome=${id_tome}`, getAuthHeaders(token));
export const getPages = (id_chapitre, token) => apiClient.get(`/pages?id_chapitre=${id_chapitre}`, getAuthHeaders(token));
export const getPageById = (id, token) => apiClient.get(`/pages/${id}`, getAuthHeaders(token));
export const createBubble = (bubbleData, token) => apiClient.post('/bulles', bubbleData, getAuthHeaders(token));
export const updateBubbleText = (id, text, token) => apiClient.put(`/bulles/${id}`, { texte_propose: text }, getAuthHeaders(token));
export const searchBubbles = (query) => apiClient.get(`/search?q=${query}`);
export const getPendingBubbles = (token) => apiClient.get('/bulles/pending', getAuthHeaders(token));
export const validateBubble = (id, token) => apiClient.put(`/bulles/${id}/validate`, {}, getAuthHeaders(token));
export const rejectBubble = (id, token) => apiClient.put(`/bulles/${id}/reject`, {}, getAuthHeaders(token));
export const getBubbleCrop = (id, token) => apiClient.get(`/bulles/${id}/crop`, {
  ...getAuthHeaders(token),
  responseType: 'blob',
});

// Fonctions Admin
export const createTome = (tomeData, token) => apiClient.post('/admin/tomes', tomeData, getAuthHeaders(token));
export const uploadChapter = (formData, token) => apiClient.post('/admin/chapitres/upload', formData, {
    headers: {
        Authorization: `Bearer ${token}`
    }
});

export const getBubblesForPage = (pageId, token) => apiClient.get(`/pages/${pageId}/bulles`, getAuthHeaders(token));
export const deleteBubble = (id, token) => apiClient.delete(`/bulles/${id}`, getAuthHeaders(token));
export const reorderBubbles = (orderedBubbles, token) => apiClient.put('/bulles/reorder', { orderedBubbles }, getAuthHeaders(token));
export const submitPageForReview = (pageId, token) => apiClient.put(`/pages/${pageId}/submit-review`, {}, getAuthHeaders(token));
export const getPagesForReview = (token) => apiClient.get('/moderation/pages', getAuthHeaders(token));
export const approvePage = (pageId, token) => apiClient.put(`/moderation/pages/${pageId}/approve`, {}, getAuthHeaders(token));
export const rejectPage = (pageId, token) => apiClient.put(`/moderation/pages/${pageId}/reject`, {}, getAuthHeaders(token));