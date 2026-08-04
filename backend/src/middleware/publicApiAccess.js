const { supabaseAdmin } = require('../config/supabaseClient');

const CACHE_TTL_MS = 60_000;
const FAILURE_RETRY_MS = 5_000;

function getClientIp(req) {
  const cloudflareHeader = Array.isArray(req.headers['cf-connecting-ip'])
    ? req.headers['cf-connecting-ip'][0]
    : req.headers['cf-connecting-ip'];
  const forwardedHeader = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'];
  let ip = cloudflareHeader
    || (forwardedHeader ? String(forwardedHeader).split(',')[0].trim() : null)
    || req.ip
    || req.connection?.remoteAddress;
  ip = ip === null || ip === undefined ? null : String(ip).trim();
  if (ip?.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  return ip || null;
}

function createPublicApiAccessMiddleware({
  client = supabaseAdmin,
  cacheTtlMs = CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  let bannedIps = new Set();
  let refreshAfter = 0;
  let refreshPromise = null;

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const { data, error } = await client.from('banned_ips').select('ip');
        if (error) throw error;
        bannedIps = new Set((data || []).map((row) => row.ip).filter(Boolean));
        refreshAfter = now() + cacheTtlMs;
      } catch (error) {
        refreshAfter = now() + FAILURE_RETRY_MS;
        console.error('[Public API] Unable to refresh access rules.');
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  return async function publicApiAccess(req, res, next) {
    const ip = getClientIp(req);
    if (now() >= refreshAfter) await refresh();
    if (ip && bannedIps.has(ip)) return res.status(403).json({ error: 'Access denied.' });
    req.clientIp = ip;
    return next();
  };
}

const publicApiAccessMiddleware = createPublicApiAccessMiddleware();

module.exports = {
  createPublicApiAccessMiddleware,
  getClientIp,
  publicApiAccessMiddleware,
};
