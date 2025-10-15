const express = require('express');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3001;

const tomeRoutes = require('./routes/tomeRoutes');

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({ 
    message: "API de l'indexeur One Piece fonctionnelle.",
    timestamp: new Date().toISOString() 
  });
});

app.use('/api/tomes', tomeRoutes);

app.listen(PORT, () => {
  console.log(`Serveur démarré et à l'écoute sur le port ${PORT}`);
});