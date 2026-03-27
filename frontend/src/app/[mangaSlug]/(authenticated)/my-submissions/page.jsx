import SubmissionsClient from './SubmissionsClient';

export async function generateMetadata({ params }) {
    const { mangaSlug } = await params;
    const mangaName = mangaSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    return {
        title: `Mes Soumissions - ${mangaName}`,
        description: `Consultez l'historique de vos contributions pour ${mangaName}.`,
    };
}

export default function Page() {
    return <SubmissionsClient />;
}
