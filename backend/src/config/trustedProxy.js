const net = require('node:net');

const MAX_TRUSTED_PROXY_RANGES = 64;

function parseTrustedProxyCidrs(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const ranges = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (ranges.length === 0) return false;
  if (ranges.length > MAX_TRUSTED_PROXY_RANGES) {
    throw new Error('TRUSTED_PROXY_CIDRS contains too many ranges.');
  }

  for (const range of ranges) {
    const parts = range.split('/');
    if (parts.length > 2) throw new Error(`Invalid trusted proxy range: ${range}`);
    const family = net.isIP(parts[0]);
    if (!family) throw new Error(`Invalid trusted proxy address: ${range}`);
    if (parts.length === 1) continue;

    if (!/^\d+$/.test(parts[1])) throw new Error(`Invalid trusted proxy prefix: ${range}`);
    const prefix = Number(parts[1]);
    const maximum = family === 4 ? 32 : 128;
    if (prefix < 1 || prefix > maximum) {
      throw new Error(`Unsafe trusted proxy prefix: ${range}`);
    }
  }
  return ranges;
}

module.exports = { parseTrustedProxyCidrs };
