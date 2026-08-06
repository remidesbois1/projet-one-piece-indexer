require('node:dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { parseTrustedProxyCidrs } = require('./config/trustedProxy');

const app = express();

// Trust proxy is required if running behind a reverse proxy (like Nginx, Heroku, Vercel, Supabase)
// to correctly identify the client IP for rate limiting and blocking.
app.set('trust proxy', process.env.TRUSTED_PROXY_CIDRS ? parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS) : 1);

const allowedOrigins = [
  'https://onepiece-index.com',
  'https://www.onepiece-index.com',
  'https://poneglyph.fr',
  'https://www.poneglyph.fr',
];

if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:5173', 'http://localhost:3000');
}

if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','));
}

app.use(cors({ origin: allowedOrigins, credentials: true }));

const rateLimit = require('express-rate-limit');
const { supabase } = require('./config/supabaseClient');

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

const statsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Trop de tentatives, réessayez dans 1 minute." },
  standardHeaders: true,
  legacyHeaders: false,
});

const PORT = process.env.PORT || 3001;

const tomeRoutes = require('./routes/tomeRoutes');
const chapitreRoutes = require('./routes/chapitreRoutes');
const pageRoutes = require('./routes/pageRoutes');
const bulleRoutes = require('./routes/bulleRoutes');
const searchRoutes = require('./routes/searchRoutes');
const adminRoutes = require('./routes/adminRoutes');
const moderationRoutes = require('./routes/moderationRoutes');
const analysisRoutes = require('./routes/analysisRoutes');
const userRoutes = require('./routes/userRoutes');
const statRoutes = require('./routes/statsRoutes')
const mangaRoutes = require('./routes/mangaRoutes');
const coverRoutes = require('./routes/coverRoutes');
const publicRoutes = require('./routes/v1/publicRoutes');
const publicV2Routes = require('./routes/v2/publicRoutes');
const { requestLogger } = require('./middleware/requestLogger');
const { startChapterImportWorker } = require('./jobs/chapterImportWorker');
const { publicApiSpec } = require('./openapi/publicApi');



app.use(express.json({ limit: '1mb' }));

app.use(requestLogger);

app.get('/', (req, res) => {
  res.status(200).json({
    message: "API Projet Poneglyph fonctionnelle.",
    timestamp: new Date().toISOString()
  });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    res.json({ session: data.session });
  } catch {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

app.use('/api/tomes', tomeRoutes);
app.use('/api/chapitres', chapitreRoutes);
app.use('/api/pages', pageRoutes);
app.use('/api/bulles', bulleRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/analyse', analysisRoutes);
app.use('/api/user', userRoutes);
app.use('/api/stats', statsLimiter, statRoutes);
app.use('/api/mangas', mangaRoutes);
app.use('/api/covers', coverRoutes);

// Public API v1
app.get('/openapi.json', publicLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(publicApiSpec);
});
app.use('/v1', publicLimiter, publicRoutes);
app.use('/v2', publicLimiter, publicV2Routes);

const server = app.listen(PORT, () => {
  console.log(`Serveur démarré, port : ${PORT}`);
});

let chapterImportWorker = null;
if (process.env.CHAPTER_IMPORT_WORKER_ENABLED !== 'false') {
  try {
    chapterImportWorker = startChapterImportWorker();
  } catch (error) {
    console.error('[ChapterImportWorker] Unable to start:', error);
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} received, stopping background work.`);
  chapterImportWorker?.stop();
  server.close((error) => {
    if (error) console.error('[Server] Shutdown failed:', error);
    process.exitCode = error ? 1 : 0;
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
