const supabase = require('../config/supabaseClient');

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ error: 'Accès non autorisé : token manquant.' });
  }

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) throw new Error('Token invalide ou expiré.');

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
      
    if (profileError || !profile) throw new Error('Profil utilisateur introuvable.');

    req.user = { ...user, role: profile.role };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Accès non autorisé : ' + error.message });
  }
};

const roleCheck = (allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (userRole && allowedRoles.includes(userRole)) {
      next();
    } else {
      res.status(403).json({ error: 'Accès refusé : permissions insuffisantes.' });
    }
  };
};

module.exports = { authMiddleware, roleCheck };