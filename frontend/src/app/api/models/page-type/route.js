const MODEL_REVISION = 'a4440acf39800eaef1294c2663897093b5751e98';
const MODEL_URL = `https://huggingface.co/Remidesbois/Poneglyph_slicer/resolve/${MODEL_REVISION}/page_type_classifier.onnx`;

export const runtime = 'nodejs';

/**
 * Hugging Face's Xet download redirect is not CORS-readable from the isolated
 * browser worker. Stream the remote model through the Next origin instead;
 * this remains a remote Hugging Face model and is never bundled as a static
 * frontend asset.
 */
export async function GET() {
    const upstream = await fetch(MODEL_URL, {
        next: { revalidate: 3600 },
    });
    if (!upstream.ok || !upstream.body) {
        return Response.json(
            { error: `Le modèle Hugging Face est indisponible (HTTP ${upstream.status}).` },
            { status: 502 },
        );
    }

    const headers = new Headers({
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    });
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);
    return new Response(upstream.body, { headers });
}
