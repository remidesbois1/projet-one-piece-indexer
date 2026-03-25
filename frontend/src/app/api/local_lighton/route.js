import { NextResponse } from 'next/server';

export async function POST(req) {
    try {
        const modalUrl = process.env.MODAL_LIGHTON_URL || "https://remisemenzin--ocr-lighton.modal.run";
        const modalApiKey = process.env.MODAL_OCR_API_KEY;

        if (!modalApiKey) {
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
            return NextResponse.json({ error: "Erreur Modal Lighton: " + errorText }, { status: response.status });
        }

        const data = await response.json();
        return NextResponse.json(data);

    } catch (error) {
        console.error("Lighton OCR Proxy Error:", error);
        return NextResponse.json({ error: "Erreur interne du proxy Modal Lighton." }, { status: 500 });
    }
}
