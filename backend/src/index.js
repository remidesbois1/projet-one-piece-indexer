const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3001;

const tomeRoutes = require('./routes/tomeRoutes');
const chapitreRoutes = require('./routes/chapitreRoutes');
const pageRoutes = require('./routes/pageRoutes');
const bulleRoutes = require('./routes/bulleRoutes');
const searchRoutes = require('./routes/searchRoutes');

app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`Serveur démarré et à l'écoute sur le port ${PORT}`);
});