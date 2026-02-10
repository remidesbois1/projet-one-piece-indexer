const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Trust proxy is required if running behind a reverse proxy (like Nginx, Heroku, Vercel, Supabase)
// to correctly identify the client IP for rate limiting and blocking.
app.set('trust proxy', 1);

app.use(cors({
  origin: [
    'https://onepiece-index.com',
    'https://www.onepiece-index.com',
    'https://poneglyph.fr',
    'https://www.poneglyph.fr',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));

const rateLimit = require('express-rate-limit');

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
const glossaryRoutes = require('./routes/glossaryRoutes');
const mangaRoutes = require('./routes/mangaRoutes'); // [NEW]
const publicRoutes = require('./routes/v1/publicRoutes');



app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.status(200).json({
    message: "API de l'indexeur One Piece fonctionnelle.",
    timestamp: new Date().toISOString()
  });
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
app.use('/api/glossary', glossaryRoutes);
app.use('/api/mangas', mangaRoutes); // [NEW]

// Public API v1
app.use('/v1', publicLimiter, publicRoutes);

app.listen(PORT, () => {
  console.log(`Serveur démarré, port : ${PORT}`);
});