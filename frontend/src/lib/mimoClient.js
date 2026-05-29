import { cropImage } from "./utils";

const MIMO_API_URL = "https://api.xiaomimimo.com/v1/chat/completions";
const MIMO_MODEL = "mimo-v2.5";

async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (reader.result) {
                resolve(reader.result.toString().split(',')[1]);
            } else {
                reject(new Error("Failed to convert blob to base64"));
            }
        };
        reader.readAsDataURL(blob);
    });
}

const ONE_SHOT_PROMPT = `à partir de cette page, extrait tout le texte de chaque bulle dans le bon ordre de lecture japonais (en haut à droite -> en bas à gauche) Avec leurs position bbox. Dans un format json :
[
  {
    "content": "texte",
    "pos": [ymin, xmin, ymax, xmax]
  }
]
- Corrige aussi la casse : "TRES BIEN, ..." devient : "Très bien, ..."
Position normalisé à 1000 que tu va re-normaliser derrière selon la page.
Réponds UNIQUEMENT avec le JSON, aucun texte avant ou après.`;

export async function generateMimoOneShotBubbles(imageSource, apiKey) {
    if (!apiKey) throw new Error("Clé API MiMo manquante");

    let blob;
    try {
        const fullRect = {
            x: 0,
            y: 0,
            w: imageSource.naturalWidth,
            h: imageSource.naturalHeight
        };
        blob = await cropImage(imageSource, fullRect);
    } catch (e) {
        console.error("Image processing error:", e);
        throw new Error("Erreur lors du traitement de l'image.");
    }

    const base64Data = await blobToBase64(blob);

    const response = await fetch(MIMO_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MIMO_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Data}`
                            }
                        },
                        {
                            type: "text",
                            text: ONE_SHOT_PROMPT
                        }
                    ]
                }
            ],
            response_format: { type: "json_object" },
            thinking: { type: "disabled" },
            max_completion_tokens: 32768
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 429) {
            throw new Error("QUOTA_EXCEEDED");
        }
        throw new Error(err.error?.message || err.message || `Erreur API MiMo (${response.status})`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("Réponse vide de l'API MiMo.");
    }

    let parsed;
    try {
        const raw = JSON.parse(content);
        if (Array.isArray(raw)) {
            parsed = raw;
        } else if (raw.data && Array.isArray(raw.data)) {
            parsed = raw.data;
        } else if (raw.bubbles && Array.isArray(raw.bubbles)) {
            parsed = raw.bubbles;
        } else {
            const arrKey = Object.keys(raw).find(k => Array.isArray(raw[k]));
            parsed = arrKey ? raw[arrKey] : [raw];
        }
    } catch {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
        } else {
            throw new Error("Impossible de parser la réponse MiMo.");
        }
    }

    return { data: parsed };
}
