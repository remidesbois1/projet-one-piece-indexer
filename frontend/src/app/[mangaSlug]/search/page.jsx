import SearchClient from './SearchClient';

export async function generateMetadata({ params }) {
    const { mangaSlug } = await params;
    const mangaName = mangaSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    return {
        title: `Recherche ${mangaName}`,
        description: `Recherchez des scènes, des dialogues ou des personnages dans les archives de ${mangaName}. Utilisez la recherche sémantique pour trouver des moments précis par leur concept.`,
        openGraph: {
            title: `Recherche ${mangaName}`,
            description: `Moteur de recherche intelligent pour ${mangaName}.`,
            type: 'website',
        }
    };
}

export default function Page() {
    return <SearchClient />;
}
