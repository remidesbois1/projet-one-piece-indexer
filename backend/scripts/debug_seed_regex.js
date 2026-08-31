const fs = require('fs');
const path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '../sql/2026-08-19_add_llm_prompts.sql'), 'utf8');
const firstRow = sql.slice(sql.indexOf('VALUES'), sql.indexOf('strict_json_suffix'));

const steps = [
  [/VALUES\n\(/, 'VALUES + open paren'],
  [/VALUES\n\(\s*'([a-z0-9_]+)',/, 'key'],
  [/VALUES\n\(\s*'([a-z0-9_]+)',\s*\n\s*'/, 'label open quote'],
  [/VALUES\n\(\s*'([a-z0-9_]+)',\s*\n\s*'((?:[^']|'')*)',/, 'label full'],
  [/VALUES\n\(\s*'([a-z0-9_]+)',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*'([a-z]+)',/, 'category'],
  [/VALUES\n\(\s*'([a-z0-9_]+)',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*'([a-z]+)',\s*\n\s*'((?:[^']|'')*)',/, 'description'],
  [/VALUES\n\(\s*'([a-z0-9_]+)',\s*\n\s*'((?:[^']|'')*)',\s*\n\s*'([a-z]+)',\s*\n\s*'((?:[^']|'')*)',\s*\n\$prompt\$/, 'content open tag'],
];
for (const [re, label] of steps) {
  const m = firstRow.match(re);
  console.log(m ? `PASS: ${label}` : `FAIL: ${label}`);
  if (!m) break;
}

// Inspecter l'octet exact autour de la fin de description de la row 1
const tagIdx = sql.indexOf('$prompt$');
console.log('\naround first $prompt$ tag:');
console.log(JSON.stringify(sql.slice(tagIdx - 80, tagIdx + 20)));
