import { supabase } from "@/lib/supabaseClient";
import LandingPageClient from "@/components/LandingPageClient";

export default async function LandingPage() {
    let mangas = [];
    try {
        const { data } = await supabase.from('mangas').select('*').eq('enabled', true).order('titre');
        if (data) mangas = data;
    } catch (e) {
        console.error("Erreur lors de la récupération des mangas sur le serveur:", e);
    }

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{
                    __html: JSON.stringify({
                        "@context": "https://schema.org",
                        "@type": "SoftwareApplication",
                        "name": "Projet Poneglyph",
                        "description": "Retrouvez la page que vous cherchez. Une citation ? Un combat ? Décrivez ce que vous cherchez pour tomber pile sur la bonne page de manga.",
                        "applicationCategory": "MultimediaApplication",
                        "offers": {
                            "@type": "Offer",
                            "price": "0",
                            "priceCurrency": "EUR"
                        }
                    })
                }}
            />
            <LandingPageClient mangas={mangas} />
        </div>
    );
}
