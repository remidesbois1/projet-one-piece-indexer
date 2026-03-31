import AnnotateClient from './AnnotateClient';
import { WorkerProvider } from '@/context/WorkerContext';
import { DetectionProvider } from '@/context/DetectionContext';

export async function generateMetadata({ params }) {
    const { mangaSlug, pageId } = await params;
    const mangaName = mangaSlug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

    return {
        title: `Annotation - ${mangaName} | Projet Poneglyph`,
        description: `Indexation de la page ${pageId} de ${mangaName}. Contribuez au Projet Poneglyph en transcrivant les dialogues et en décrivant les scènes.`,
    };
}

export default function Page() {
    return (
        <WorkerProvider>
            <DetectionProvider>
                <AnnotateClient />
            </DetectionProvider>
        </WorkerProvider>
    );
}
