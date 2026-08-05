const REDACTED = '[REDACTED]';
const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 512;

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passphrase',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'email',
  'user_email',
  'query',
  'raw_query',
  'normalized_query',
  'doc_text',
  'image_url',
  'imageurl',
  'url',
  'originalurl',
  'headers',
  'config',
  'request',
  'response',
]);

function normalizeKey(key) {
  return String(key || '').replace(/[-\s]/g, '_').toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith('_password')
    || normalized.endsWith('_secret')
    || normalized.endsWith('_token')
    || normalized.endsWith('_api_key');
}

function redactString(value) {
  const truncated = value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`
    : value;
  return truncated
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:key|token|secret|password|code)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
}

function sanitizeLogValue(value, options = {}, state = null) {
  const depth = options.depth || 0;
  const key = options.key || '';
  const currentState = state || { seen: new WeakSet() };

  if (isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';

  if (value instanceof Error) {
    return {
      name: redactString(value.name || 'Error'),
      code: redactString(String(value.code || 'UNEXPECTED_ERROR')),
      status: Number.isInteger(value.status) ? value.status : undefined,
    };
  }

  if (typeof value === 'object') {
    if (currentState.seen.has(value)) return '[CIRCULAR]';
    currentState.seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeLogValue(
        entry,
        { depth: depth + 1 },
        currentState
      ));
    }

    const sanitized = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_KEYS)) {
      const safeValue = sanitizeLogValue(
        entryValue,
        { depth: depth + 1, key: entryKey },
        currentState
      );
      if (safeValue !== undefined) sanitized[entryKey] = safeValue;
    }
    return sanitized;
  }

  return redactString(String(value));
}

function createLogger({ sink = console } = {}) {
  function write(level, event, fields = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event: redactString(String(event || 'application_event')),
      ...sanitizeLogValue(fields),
    };
    const output = JSON.stringify(record);
    const writer = level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.log;
    writer.call(sink, output);
    return record;
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

const logger = createLogger();

module.exports = {
  REDACTED,
  createLogger,
  isSensitiveKey,
  logger,
  redactString,
  sanitizeLogValue,
};
