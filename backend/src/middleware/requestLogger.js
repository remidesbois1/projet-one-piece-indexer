const crypto = require('node:crypto');
const { logger } = require('../utils/logger');

function safeRequestPath(req) {
  const routePath = req.route?.path;
  const baseUrl = req.baseUrl || '';
  const path = routePath ? `${baseUrl}${routePath}` : String(req.path || '/');
  return path
    .split('?')[0]
    .replace(/\/[A-Za-z0-9_-]{65,}(?=\/|$)/g, '/:redacted');
}

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  req.id = typeof req.id === 'string' && req.id ? req.id : crypto.randomUUID();
  res?.setHeader?.('X-Request-ID', req.id);

  let logged = false;
  const writeCompletion = () => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('http_request_completed', {
      request_id: req.id,
      method: String(req.method || 'UNKNOWN').toUpperCase(),
      path: safeRequestPath(req),
      status: Number(res?.statusCode) || 0,
      duration_ms: Number(durationMs.toFixed(2)),
    });
  };

  if (typeof res?.once === 'function') {
    res.once('finish', writeCompletion);
    res.once('close', writeCompletion);
  } else {
    writeCompletion();
  }
  next();
}

module.exports = { requestLogger, safeRequestPath };
