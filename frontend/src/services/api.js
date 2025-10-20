import axios from 'axios';
import { supabase } from '../supabaseClient';

const apiClient = axios.create({
  baseURL: 'http://localhost:3001/api',
});

apiClient.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`;
  }
  return config;
});

export const getTomes = () => apiClient.get('/tomes');
export const getChapitres = (id_tome) => apiClient.get(`/chapitres?id_tome=${id_tome}`);
export const getPages = (id_chapitre) => apiClient.get(`/pages?id_chapitre=${id_chapitre}`);
export const getPageById = (id) => apiClient.get(`/pages/${id}`);
export const createBubble = (bubbleData) => apiClient.post('/bulles', bubbleData);

export default apiClient;