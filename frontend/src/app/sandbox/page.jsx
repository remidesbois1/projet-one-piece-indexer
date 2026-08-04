import SandboxClient from './SandboxClient';
import { TauriLocalOcrProvider } from '@/context/TauriLocalOcrContext';

export const metadata = {
    title: 'Sandbox d’annotation - Projet Poneglyph',
    description: 'Testez l\'annotation locale alimentée par WebGPU.',
};

export default function SandboxPage() {
    return (
        <TauriLocalOcrProvider>
            <SandboxClient />
        </TauriLocalOcrProvider>
    );
}
