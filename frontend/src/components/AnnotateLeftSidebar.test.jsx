import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AnnotateLeftSidebar, { formatPageStatus } from './AnnotateLeftSidebar';

describe('AnnotateLeftSidebar', () => {
    it('renders the public reader when private workflow metadata is absent', () => {
        render(
            <AnnotateLeftSidebar
                mangaSlug="one-piece"
                page={{ id: 42, numero_page: 3 }}
                chapterPages={[]}
                navContext={{ prev: null, next: null }}
                isGuest
                role="Guest"
            />
        );

        expect(screen.getByText('lecture publique')).toBeInTheDocument();
    });

    it('keeps formatting authenticated workflow statuses', () => {
        expect(formatPageStatus('pending_review')).toBe('pending review');
    });
});
