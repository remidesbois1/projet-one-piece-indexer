import { NextResponse } from 'next/server';

export async function POST(req) {
    try {
        const modalUrl = process.env.MODAL_OCR_URL || "https://remidesbois--ocr-poneglyph.modal.run";
        const modalApiKey = process.env.MODAL_OCR_API_KEY;

        if (!modalApiKey) {
            return NextResponse.json({ error: "Configuration serveur manquante" }, { status: 500 });
        }

        // On récupère le body (le blob de l'image)
        const blob = await req.blob();

        // On transfère l'appel à Modal avec la clé secrète (invisible pour le client)
        const response = await fetch(modalUrl, {
            method: 'POST',
            headers: {
                'X-API-Key': modalApiKey
            },
            body: blob
        });

        if (!response.ok) {
            const errorText = await response.text();
            return NextResponse.json({ error: "Erreur Modal: " + errorText }, { status: response.status });
        }

        const data = await response.json();
        return NextResponse.json(data);

    } catch (error) {
        console.error("OCR Proxy Error:", error);
        return NextResponse.json({ error: "Erreur interne du proxy" }, { status: 500 });
    }
}
