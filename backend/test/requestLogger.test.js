const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { requestLogger } = require('../src/middleware/requestLogger');

test('request logging is structured and excludes query strings and credentials', () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => messages.push(message);

  try {
    let nextCalled = false;
    const response = new EventEmitter();
    response.statusCode = 204;
    response.headers = {};
    response.setHeader = (name, value) => { response.headers[name] = value; };
    requestLogger(
      {
        method: 'GET',
        path: '/api/pages/42/image',
        url: '/api/pages/42/image?token=secret-value',
        originalUrl: '/api/pages/42/image?token=secret-value',
        headers: { authorization: 'Bearer secret-value' },
      },
      response,
      () => { nextCalled = true; }
    );
    response.emit('finish');

    assert.equal(nextCalled, true);
    assert.equal(messages.length, 1);
    const record = JSON.parse(messages[0]);
    assert.equal(record.event, 'http_request_completed');
    assert.equal(record.method, 'GET');
    assert.equal(record.path, '/api/pages/42/image');
    assert.equal(record.status, 204);
    assert.match(response.headers['X-Request-ID'], /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(messages[0], /secret-value|\?token=/);
  } finally {
    console.log = originalLog;
  }
});
