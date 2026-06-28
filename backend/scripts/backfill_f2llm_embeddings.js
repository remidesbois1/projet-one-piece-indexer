const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { supabaseAdmin } = require('../src/config/supabaseClient');
const { generateF2llmEmbedding } = require('../src/utils/f2llmClient');
const { buildPageEmbeddingText } = require('../src/utils/pageEmbeddingText');

const BATCH_SIZE = parseInt(process.env.F2LLM_BACKFILL_BATCH_SIZE || '8', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBatch(manga, force, afterId = 0) {
  let query = supabaseAdmin
    .from('pages')
    .select(`
      id,
      description,
      embedding_f2llm,
      bulles ( texte_propose, statut ),
      chapitres!inner( tomes!inner( mangas!inner(slug) ) )
    `)
    .not('description', 'is', null)
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(BATCH_SIZE);

  if (!force) {
    query = query.is('embedding_f2llm', null);
  }

  if (manga) {
    query = query.eq('chapitres.tomes.mangas.slug', manga);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function backfill() {
  const manga = process.argv.find((arg) => arg.startsWith('--manga='))?.split('=')[1] || null;
  const force = process.argv.includes('--force') || process.argv.includes('--overwrite');
  const delayMs = parseInt(process.env.F2LLM_BACKFILL_DELAY_MS || '0', 10);
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  console.log(`Starting F2LLM backfill${force ? ' with overwrite' : ''}${manga ? ` for ${manga}` : ''}...`);

  let afterId = 0;
  while (true) {
    const pages = await fetchBatch(manga, force, afterId);
    if (!pages.length) break;

    for (const page of pages) {
      afterId = Math.max(afterId, page.id || 0);
      try {
        const text = buildPageEmbeddingText(page);
        if (!text) {
          skipped++;
          continue;
        }

        const embedding = await generateF2llmEmbedding(text, 'document');
        const { error } = await supabaseAdmin
          .from('pages')
          .update({ embedding_f2llm: embedding })
          .eq('id', page.id);

        if (error) throw error;
        processed++;
        console.log(`F2LLM embedded page ${page.id} (${processed} processed).`);
      } catch (error) {
        errors++;
        console.error(`F2LLM backfill failed for page ${page.id}:`, error.message);
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  }

  console.log(`F2LLM backfill complete. processed=${processed} skipped=${skipped} errors=${errors}`);
}

backfill().catch((error) => {
  console.error('F2LLM backfill crashed:', error);
  process.exit(1);
});
