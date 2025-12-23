import { AutoProcessor, Florence2ForConditionalGeneration, RawImage, env } from '@huggingface/transformers';

// Configuration
env.allowLocalModels = false;
env.useBrowserCache = true;

let model = null;
let processor = null;
let dictionaryPromise = null;

const MODEL_ID = 'onnx-community/Florence-2-base-ft'; 

function removeAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

self.addEventListener('message', async (event) => {
    const { type, imageBlob } = event.data;

    if (type === 'init') {
        try {
            dictionaryPromise = fetch('/corrections_huge.json')
                .then(r => r.ok ? r.json() : {})
                .catch(() => ({}));

            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    self.postMessage({ status: 'download_progress', file: data.file, progress: data.progress });
                }
            };

            model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
                dtype: 'fp32',
                device: 'webgpu',
                progress_callback: progressCallback
            });
            
            processor = await AutoProcessor.from_pretrained(MODEL_ID, {
                progress_callback: progressCallback
            });
            
            self.postMessage({ status: 'ready' });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: errorMsg });
        }
    }

    if (type === 'run' && imageBlob) {
        if (!model || !processor) {
            self.postMessage({ status: 'error', error: 'Modèle non chargé.' });
            return;
        }

        try {
            const debugURL = URL.createObjectURL(imageBlob);
            self.postMessage({ status: 'debug_image', url: debugURL });

            // 1. OCR avec Régions (Force les espaces)
            const image = await RawImage.fromBlob(imageBlob);
            const task = '<OCR_WITH_REGION>'; 
            const inputs = await processor(image, task);

            const generatedIds = await model.generate({
                ...inputs,
                max_new_tokens: 256,
                num_beams: 3,      
                do_sample: false,  
            });

            const generatedText = processor.tokenizer.batch_decode(generatedIds, {
                skip_special_tokens: false,
            })[0];
            let cleanText = generatedText.replace(/<[^>]+>/g, ' '); 
            
            cleanText = cleanText.replace(/\s+/g, ' ').trim();
            
            cleanText = cleanText.toLowerCase();

            const dictionary = await dictionaryPromise;

            cleanText = cleanText.replace(/([a-zA-Zà-ÿ])([?!:;])/g, '$1 $2'); 
            cleanText = cleanText.replace(/([?!:;])([a-zA-Zà-ÿ])/g, '$1 $2');
            
            if (dictionary) {
                cleanText = cleanText.replace(/[a-zà-ÿ]+/g, (word) => {
                    const normalizedKey = removeAccents(word);
                    // Si on trouve une correction (ex: "etait" -> "était"), on remplace.
                    // Sinon on garde le mot tel quel (en minuscule).
                    return dictionary[normalizedKey] || word;
                });
            }

            
            cleanText = cleanText.replace(/(^\s*|[.!?…]\s+)([a-zà-ÿ])/g, (match) => match.toUpperCase());

            const ONE_PIECE_KEYWORDS = [
                "One Piece", "Grand Line", "New World", "Nouveau Monde", "All Blue", 
                "Laugh Tale", "Raftel", "Red Line", "Calm Belt", "Log Pose", "Vivre Card",
                "Berry", "Berries", "Haki", "Mugiwara", "Yonko", "Empereur", "Amiral", 
                "Corsaire", "Shichibukai", "Tenryubito", "Joy Boy", "Roi des Pirates",
                "Luffy", "Zoro", "Nami", "Usopp", "Sanji", "Chopper", "Robin", "Franky", 
                "Brook", "Jinbe", "Vivi", "Yamato", "Momonosuke", "Ace", "Sabo", "Shanks", 
                "Roger", "Whitebeard", "Barbe Blanche", "Blackbeard", "Barbe Noire", "Kaido", 
                "Big Mom", "Linlin", "Law", "Kid", "Buggy", "Mihawk", "Hancock", "Doflamingo", 
                "Crocodile", "Akainu", "Kizaru", "Aokiji", "Fujitora", "Ryokugyu", "Garp", 
                "Sengoku", "Dragon", "Imu", "Vegapunk", "Gum Gum", "Gomu Gomu"
            ];
            
            ONE_PIECE_KEYWORDS.forEach(kw => {
                 const regex = new RegExp(`\\b${kw}\\b`, 'gi');
                 cleanText = cleanText.replace(regex, kw);
            });

            self.postMessage({ status: 'complete', text: cleanText });

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            self.postMessage({ status: 'error', error: errorMsg });
        }
    }
});