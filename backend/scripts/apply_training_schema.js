const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');
const MIGRATION_PATH = path.join(BACKEND_ROOT, 'sql', '2026-07-01_add_training_jobs.sql');
const REQUIRED_TABLES = ['training_jobs', 'model_versions'];

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

function hasFlag(name) {
  return process.argv.includes(name);
}

function deriveProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF.trim();
  if (!process.env.SUPABASE_URL) return null;
  try {
    return new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  } catch {
    return null;
  }
}

function requireSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to verify the training schema.');
  }
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

async function tableIsVisible(supabase, table) {
  const { error } = await supabase.from(table).select('id', { head: true, count: 'exact' });
  if (error) {
    return { table, ok: false, code: error.code, message: error.message };
  }
  return { table, ok: true };
}

async function verifySchema() {
  const supabase = requireSupabaseClient();
  const results = [];
  for (const table of REQUIRED_TABLES) {
    results.push(await tableIsVisible(supabase, table));
  }
  return results;
}

function printVerification(results) {
  for (const result of results) {
    if (result.ok) {
      console.log(`${result.table}: ok`);
    } else {
      console.log(`${result.table}: missing (${result.code || 'unknown'} ${result.message || ''})`);
    }
  }
}

async function applyMigration() {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = deriveProjectRef();
  if (!accessToken) {
    throw new Error(
      'SUPABASE_ACCESS_TOKEN is required to apply SQL through the Supabase Management API. ' +
      `Set it and rerun, or paste ${path.relative(PROJECT_ROOT, MIGRATION_PATH)} into the Supabase SQL editor.`
    );
  }
  if (!projectRef) {
    throw new Error('Could not derive SUPABASE_PROJECT_REF from SUPABASE_PROJECT_REF or SUPABASE_URL.');
  }

  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase Management API returned ${response.status}: ${body}`);
  }

  console.log(`Applied ${path.relative(PROJECT_ROOT, MIGRATION_PATH)} to project ${projectRef}.`);
}

async function main() {
  const checkOnly = hasFlag('--check');
  if (!checkOnly) {
    await applyMigration();
  }

  const results = await verifySchema();
  printVerification(results);
  const ok = results.every(result => result.ok);
  if (!ok) {
    throw new Error('Training schema verification failed.');
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
