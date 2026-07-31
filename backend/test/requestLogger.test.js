const assert = require('node:assert/strict');
const test = require('node:test');

const { requestLogger } = require('../src/middleware/requestLogger');

test('request logging excludes query strings and credentials', () => {
  const messages = [];
  const originalLog = console.log;
  console.log = (message) => messages.push(message);

  try {
    let nextCalled = false;
    requestLogger(
      {
        method: 'GET',
        path: '/api/pages/42/image',
        url: '/api/pages/42/image?token=secret-value',
      },
      {},
      () => { nextCalled = true; }
    );

    assert.equal(nextCalled, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /GET \/api\/pages\/42\/image$/);
    assert.doesNotMatch(messages[0], /secret-value|\?token=/);
  } finally {
    console.log = originalLog;
  }
});
