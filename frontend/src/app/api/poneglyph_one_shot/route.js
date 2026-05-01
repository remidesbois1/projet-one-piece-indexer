import { NextResponse } from 'next/server';

export async function POST(req) {
    try {
        const modalUrl = process.env.MODAL_PONEGLYPH_BBOX_URL;
        const modalApiKey = process.env.MODAL_OCR_API_KEY;

        if (!modalApiKey || !modalUrl) {
            return NextResponse.json({ error: "Configuration serveur manquante" }, { status: 500 });
        }

        const blob = await req.blob();

        const response = await fetch(modalUrl, {
            method: 'POST',
            headers: {
                'X-API-Key': modalApiKey
            },
            body: blob
        });

        if (!response.ok) {
            const errorText = await response.text();
            return NextResponse.json({ error: "Erreur Modal Poneglyph: " + errorText }, { status: response.status });
        }

        const data = await response.json();
        return NextResponse.json(data);

    } catch (error) {
        console.error("Poneglyph BBox Proxy Error:", error);
        return NextResponse.json({ error: "Erreur interne du proxy Modal Poneglyph." }, { status: 500 });
    }
}
