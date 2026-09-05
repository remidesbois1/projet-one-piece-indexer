import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SubmitPageDialog from './SubmitPageDialog';

describe('page review confirmation', () => {
    it('opens without submitting and lets the user continue annotating', () => {
        const onConfirm = vi.fn(), onClose = vi.fn();
        render(<SubmitPageDialog pageNumber={18} onConfirm={onConfirm} onClose={onClose} />);
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Envoyer en validation ?');
        expect(screen.getByText('PAGE 18')).toBeVisible();
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Continuer l’annotation' }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('submits once and waits for success before closing', async () => {
        let finish;
        const onConfirm = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const onClose = vi.fn();
        render(<SubmitPageDialog onConfirm={onConfirm} onClose={onClose} />);
        const send = screen.getByRole('button', { name: 'Envoyer', exact: true });
        fireEvent.click(send);
        fireEvent.click(send);
        expect(onConfirm).toHaveBeenCalledOnce();
        expect(screen.getByRole('button', { name: 'Envoi en cours…' })).toBeDisabled();
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => finish());
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('keeps the dialog open with the server error and allows a retry', async () => {
        const onConfirm = vi.fn().mockRejectedValue({ response: { data: { error: 'Cette page est déjà en revue.' } } });
        const onClose = vi.fn();
        render(<SubmitPageDialog onConfirm={onConfirm} onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Envoyer', exact: true }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cette page est déjà en revue.'));
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Envoyer', exact: true })).toBeEnabled();
    });
});
