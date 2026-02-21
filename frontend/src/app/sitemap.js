import { supabase } from "@/lib/supabaseClient";

export default async function sitemap() {
    // Remplacer par l'URL de votre domaine en production si besoin
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://poneglyph.fr';

    // Route racine
    const entries = [
        {
            url: baseUrl,
            lastModified: new Date(),
            changeFrequency: 'weekly',
            priority: 1,
        },
    ];

    try {
        // Fetcher les mangas pour générer dynamiquement leurs URLs
        const { data: mangas } = await supabase
            .from('mangas')
            .select('slug')
            .eq('enabled', true);

        if (mangas) {
            mangas.forEach(manga => {
                entries.push({
                    url: `${baseUrl}/${manga.slug}/dashboard`,
                    lastModified: new Date(),
                    changeFrequency: 'daily',
                    priority: 0.8,
                });
                entries.push({
                    url: `${baseUrl}/${manga.slug}/search`,
                    lastModified: new Date(),
                    changeFrequency: 'weekly',
                    priority: 0.8,
                });
            });
        }
    } catch (error) {
        console.error("Erreur lors de la génération du sitemap:", error);
    }

    return entries;
}
