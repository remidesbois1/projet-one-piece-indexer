import DashboardClient from './DashboardClient';

export async function generateMetadata({ params }) {
    const { mangaSlug } = await params;
    const mangaName = mangaSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    return {
        title: `Archives ${mangaName}`,
        description: `Explorez les archives de ${mangaName}. Retrouvez tous les tomes, chapitres et pages indexés. Recherchez des scènes, des dialogues ou des personnages spécifiques.`,
        openGraph: {
            title: `Archives ${mangaName}`,
            description: `Accédez à la bibliothèque complète de ${mangaName} sur le Projet Poneglyph.`,
            type: 'website',
        }
    };
}

export default function Page() {
    return <DashboardClient />;
}
