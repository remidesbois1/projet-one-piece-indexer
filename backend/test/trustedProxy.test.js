const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const { parseTrustedProxyCidrs } = require('../src/config/trustedProxy');

test('trusted proxy configuration fails closed and accepts explicit IP ranges only', () => {
  assert.equal(parseTrustedProxyCidrs(undefined), false);
  assert.equal(parseTrustedProxyCidrs('   '), false);
  assert.deepEqual(
    parseTrustedProxyCidrs('203.0.113.10/32, 2001:db8:1234::/48'),
    ['203.0.113.10/32', '2001:db8:1234::/48']
  );
  assert.deepEqual(parseTrustedProxyCidrs('203.0.113.10'), ['203.0.113.10']);

  for (const unsafe of [
    '0.0.0.0/0',
    '::/0',
    'proxy.example.test',
    '203.0.113.10/not-a-prefix',
    '203.0.113.10/33',
    '2001:db8::/129',
  ]) {
    assert.throws(() => parseTrustedProxyCidrs(unsafe));
  }
});

async function readRequestIp(trustProxy) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      headers: { 'X-Forwarded-For': '198.51.100.25' },
    });
    return (await response.json()).ip;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('untrusted peers cannot spoof the client address through X-Forwarded-For', async () => {
  assert.equal(await readRequestIp(false), '127.0.0.1');
  assert.equal(await readRequestIp(['127.0.0.1/32']), '198.51.100.25');
});
