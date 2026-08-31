const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '../sql/2026-08-19_add_llm_prompts.sql'), 'utf8');
const json = require('@poneglyph/shared/llm-prompts.json');

const rows = [...sql.matchAll(/\(\s*'([a-z0-9_]+)',\s*'((?:[^']|'')*)',\s*'([a-z]+)',\s*'((?:[^']|'')*)',\s*\$prompt\$([\s\S]*?)\$prompt\$\s*\)/g)];
if (rows.length === 0) {
  console.error('REGEX FAILED - structure differente');
  process.exit(1);
}
let ok = true;
for (const m of rows) {
  const key = m[1];
  const content = m[5];
  const expected = json.find((p) => p.key === key);
  if (!expected) {
    console.error('EXTRA SQL KEY:', key);
    ok = false;
    continue;
  }
  if (expected.content !== content) {
    ok = false;
    console.error('MISMATCH:', key, 'JSON len:', expected.content.length, 'SQL len:', content.length);
    for (let i = 0; i < Math.max(expected.content.length, content.length); i++) {
      if (expected.content[i] !== content[i]) {
        console.error('  first diff at', i, JSON.stringify(expected.content.slice(Math.max(0, i - 20), i + 20)), 'vs', JSON.stringify(content.slice(Math.max(0, i - 20), i + 20)));
        break;
      }
    }
  } else {
    console.log('OK:', key, `(${content.length} chars)`);
  }
}
for (const p of json) {
  if (!rows.some((m) => m[1] === p.key)) {
    console.error('MISSING IN SQL:', p.key);
    ok = false;
  }
}
console.log(ok ? 'SEED == JSON' : 'DIFFERENCES DETECTEES');
process.exit(ok ? 0 : 1);
