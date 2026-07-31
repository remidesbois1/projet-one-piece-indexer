const { supabase } = require('../config/supabaseClient');

function getBearerToken(req) {
  const authorization = req.headers.authorization;
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

const optionalAuthMiddleware = async (req, res, next) => {
  const token = getBearerToken(req);
  if (!token) return next();

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Accès non autorisé : token invalide ou expiré.' });
    }
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'Accès non autorisé : token invalide ou expiré.' });
  }
};

const authMiddleware = async (req, res, next) => {
  const token = getBearerToken(req);

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

module.exports = { authMiddleware, getBearerToken, optionalAuthMiddleware, roleCheck };
