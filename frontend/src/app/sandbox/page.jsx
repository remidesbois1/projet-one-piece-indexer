import { WorkerProvider } from '@/context/WorkerContext';
import { DetectionProvider } from '@/context/DetectionContext';
import SandboxClient from './SandboxClient';

export const metadata = {
    title: 'Annotation Sandbox - One Piece Indexer',
    description: 'Testez l\'annotation locale alimentée par WebGPU.',
};

export default function SandboxPage() {
    return (
        <WorkerProvider>
            <DetectionProvider>
                <SandboxClient />
            </DetectionProvider>
        </WorkerProvider>
    );
}
