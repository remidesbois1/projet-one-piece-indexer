const supabase = require('../config/supabaseClient');

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ error: 'Accès non autorisé : token manquant.' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new Error('Token invalide ou expiré.');
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Accès non autorisé : ' + error.message });
  }
};

module.exports = authMiddleware;