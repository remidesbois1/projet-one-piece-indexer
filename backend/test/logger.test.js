const assert = require('node:assert/strict');
const test = require('node:test');

const { createLogger, sanitizeLogValue } = require('../src/utils/logger');

test('structured logger recursively redacts credentials, personal data and query text', () => {
  const nested = {
    authorization: 'Bearer top-secret',
    payload: {
      email: 'reader@example.com',
      raw_query: 'a private search',
      query_length: 16,
      query_fingerprint: 'a'.repeat(64),
    },
  };
  nested.circular = nested;

  const sanitized = sanitizeLogValue(nested);
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.payload.email, '[REDACTED]');
  assert.equal(sanitized.payload.raw_query, '[REDACTED]');
  assert.equal(sanitized.payload.query_length, 16);
  assert.equal(sanitized.payload.query_fingerprint, 'a'.repeat(64));
  assert.equal(sanitized.circular, '[CIRCULAR]');
});

test('structured logger removes bearer tokens, URL secrets and emails from error strings', () => {
  const output = [];
  const sink = {
    log: (line) => output.push(line),
    warn: (line) => output.push(line),
    error: (line) => output.push(line),
  };
  const logger = createLogger({ sink });
  logger.error('upstream_failure', {
    detail: 'Bearer abc.def.ghi failed at https://example.test/path?key=secret for me@example.com',
    error: Object.assign(new Error('private text'), { code: 'UPSTREAM_FAILED' }),
  });

  assert.equal(output.length, 1);
  const record = JSON.parse(output[0]);
  assert.equal(record.error.code, 'UPSTREAM_FAILED');
  assert.doesNotMatch(output[0], /abc\.def|secret|me@example\.com|private text/);
});
