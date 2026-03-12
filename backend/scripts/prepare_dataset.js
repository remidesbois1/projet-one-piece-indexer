const { supabaseAdmin } = require('../src/config/supabaseClient');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function prepareDataset() {
  const imagesDir = path.join(__dirname, '..', 'dataset', 'pages');
  const annotationsPath = path.join(__dirname, '..', 'dataset', 'annotations.json');

  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  console.log("Fetching pages and bubbles from database...");

  const { data: pages, error: pagesError } = await supabaseAdmin
    .from('pages')
    .select(`
      id,
      url_image,
      bulles (
        x, y, w, h, "order"
      )
    `)
    .not('bulles', 'is', null);

  if (pagesError) {
    console.error("Error fetching data:", pagesError);
    return;
  }

  const annotations = [];
  let downloadedCount = 0;

  for (const page of pages) {
    if (!page.bulles || page.bulles.length < 2) continue;

    const imageName = `page_${page.id}.jpg`;
    const imagePath = path.join(imagesDir, imageName);

    // Sort bubbles by order
    const sortedBubbles = page.bulles.sort((a, b) => a.order - b.order).map(b => ({
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h
    }));

    annotations.push({
      image: imageName,
      bubbles: sortedBubbles
    });

    if (!fs.existsSync(imagePath)) {
      try {
        console.log(`Downloading ${imageName}...`);
        const response = await axios({
          url: page.url_image,
          responseType: 'stream'
        });
        const writer = fs.createWriteStream(imagePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        downloadedCount++;
      } catch (err) {
        console.error(`Failed to download ${imageName}:`, err.message);
      }
    }
  }

  fs.writeFileSync(annotationsPath, JSON.stringify(annotations, null, 2));
  console.log(`Done! Exported ${annotations.length} pages and downloaded ${downloadedCount} new images.`);
  console.log(`Dataset ready in: ${path.join(__dirname, '..', 'dataset')}`);
}

prepareDataset();
