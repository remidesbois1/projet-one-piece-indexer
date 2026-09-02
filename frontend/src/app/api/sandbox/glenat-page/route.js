import sharp from 'sharp';

export const runtime = 'nodejs';
export const revalidate = 86400;

const GLENAT_BASE_URL = 'https://www.glenat.com/sites/default/files/liseuse/9782723488525/files/assets/common/page-html5-substrates';
const STANDARD_WIDTH = 1500;
const AVAILABLE_PAGES = new Set([18, 22, 24, 48]);

/**
 * The Glénat reader does not expose CORS headers. Keeping the source URL on
 * the server lets the sandbox use the image in a canvas while retaining a
 * small, explicit allow-list of demo pages.
 */
export async function GET(request) {
    const pageNumber = Number(new URL(request.url).searchParams.get('page'));

    if (!Number.isInteger(pageNumber) || !AVAILABLE_PAGES.has(pageNumber)) {
        return Response.json(
            { error: 'Page de démonstration indisponible.' },
            { status: 404 },
        );
    }

    const fileName = `page${String(pageNumber).padStart(4, '0')}_4.jpg`;
    const sourceUrl = `${GLENAT_BASE_URL}/${fileName}`;

    try {
        const upstream = await fetch(sourceUrl, {
            next: { revalidate },
        });

        if (!upstream.ok) {
            return Response.json(
                { error: `La page Glénat est indisponible (HTTP ${upstream.status}).` },
                { status: 502 },
            );
        }

        const sourceBuffer = Buffer.from(await upstream.arrayBuffer());
        const imageBuffer = await sharp(sourceBuffer, { failOn: 'none' })
            .resize({
                width: STANDARD_WIDTH,
                fit: 'inside',
                withoutEnlargement: false,
            })
            .jpeg({ quality: 90, progressive: true, chromaSubsampling: '4:4:4' })
            .toBuffer();

        return new Response(imageBuffer, {
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
                'X-Source': 'Glénat',
                'X-Standard-Width': String(STANDARD_WIDTH),
            },
        });
    } catch (error) {
        console.error('[sandbox/glenat-page] unable to proxy image', error);
        return Response.json(
            { error: 'Impossible de charger cette page Glénat.' },
            { status: 502 },
        );
    }
}
