const { supabaseAdmin } = require('../src/config/supabaseClient');
const { generateVoyageEmbedding } = require('../src/utils/voyageClient');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BATCH_SIZE = 10;
const DELAY_MS = 100;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfill() {
    console.log('Starting backfill of Voyage embeddings...');

    let offset = 0;
    let totalProcessed = 0;
    let totalErrors = 0;

    let failedIds = [];

    while (true) {
        let query = supabaseAdmin
            .from('pages')
            .select('id, description')
            .is('embedding_voyage', null)
            .not('description', 'is', null);

        if (failedIds.length > 0) {
            query = query.not('id', 'in', `(${failedIds.join(',')})`);
        }

        const { data: pages, error } = await query.range(0, BATCH_SIZE - 1);

        if (error) {
            console.error('Error fetching pages:', error);
            break;
        }

        if (!pages || pages.length === 0) {
            console.log('No more pages to process.');
            break;
        }

        console.log(`Processing batch of ${pages.length} pages...`);

        for (const page of pages) {
            try {
                let textToEmbed = "";
                let desc = page.description;

                try {
                    if (typeof desc === 'string') {
                        if (desc.trim().startsWith('{')) {
                            const jsonDesc = JSON.parse(desc);
                            textToEmbed = `${jsonDesc.content || ""} ${(jsonDesc.metadata?.characters || []).join(" ")} ${jsonDesc.metadata?.arc || ""}`;
                        } else {
                            textToEmbed = desc;
                        }
                    } else if (typeof desc === 'object') {
                        textToEmbed = `${desc.content || ""} ${(desc.metadata?.characters || []).join(" ")} ${desc.metadata?.arc || ""}`;
                    } else {
                        textToEmbed = String(desc);
                    }
                } catch (e) {
                    textToEmbed = String(desc);
                }

                if (!textToEmbed || textToEmbed.trim().length === 0) {
                    console.log(`Skipping page ${page.id}: Empty description text.`);
                    continue;
                }

                const embedding = await generateVoyageEmbedding(textToEmbed, "document");

                const { error: updateError } = await supabaseAdmin
                    .from('pages')
                    .update({ embedding_voyage: embedding })
                    .eq('id', page.id);

                if (updateError) {
                    console.error(`Error updating page ${page.id}:`, updateError);
                    totalErrors++;
                } else {
                    totalProcessed++;
                }

                await sleep(DELAY_MS);

            } catch (err) {
                console.error(`Error processing page ${page.id}:`, err.message);
                totalErrors++;
                if (failedIds.length < 1000) {
                    failedIds.push(page.id);
                }
            }
        }
    }

    console.log(`Backfill complete.`);
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`Total errors: ${totalErrors}`);
}

backfill().catch(err => console.error('Script crashing:', err));
