import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    getChapterImport: vi.fn(),
    getTomes: vi.fn(),
    uploadChapter: vi.fn(),
}));

vi.mock('@/lib/api', () => apiMocks);
vi.mock('@/context/MangaContext', () => ({
    useManga: () => ({ mangaSlug: 'one-piece' }),
}));
vi.mock('@/context/AuthContext', () => ({
    useAuth: () => ({ user: { id: 'admin-1' } }),
}));
vi.mock('@/components/ui/select', () => ({
    Select: ({ value, onValueChange, disabled }) => (
        <select
            aria-label="Tome"
            value={value}
            disabled={disabled}
            onChange={(event) => onValueChange(event.target.value)}
        >
            <option value="">-- Sélectionner --</option>
            <option value="1">Tome 1</option>
        </select>
    ),
    SelectContent: ({ children }) => children,
    SelectItem: ({ children }) => children,
    SelectTrigger: ({ children }) => children,
    SelectValue: () => null,
}));
vi.mock('@/components/ui/progress', () => ({
    Progress: ({ value, ...props }) => (
        <div role="progressbar" aria-valuenow={value} {...props} />
    ),
}));

import AddChapterForm from './AddChapterForm';

const STORAGE_KEY = 'chapter-import:admin-1:one-piece';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const FIRST_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const originalRandomUUID = globalThis.crypto.randomUUID;
const randomUUID = vi.fn();

Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: randomUUID,
});

function chapterJob(status, overrides = {}) {
    return {
        id: JOB_ID,
        status,
        tome_id: 1,
        chapter_number: 42,
        chapter_title: 'Le test',
        chapter_id: status === 'completed' ? 99 : null,
        progress: {
            processed: status === 'completed' ? 2 : 0,
            total: 2,
            percent: status === 'completed' ? 100 : 0,
        },
        error: null,
        ...overrides,
    };
}

function makeArchive() {
    return new File(['archive-data'], 'chapter-42.cbz', {
        type: 'application/vnd.comicbook+zip',
        lastModified: 123456,
    });
}

function pendingRecord({ jobId = null, status = 'upload_failed', job = null } = {}) {
    const file = makeArchive();
    const fileMetadata = {
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type,
    };
    const fields = { tome_id: 1, numero: 42, titre: 'Le test' };
    return {
        version: 1,
        idempotencyKey: FIRST_KEY,
        fingerprint: JSON.stringify({
            ...fields,
            file: {
                name: fileMetadata.name,
                size: fileMetadata.size,
                lastModified: fileMetadata.lastModified,
            },
        }),
        fields,
        file: fileMetadata,
        jobId,
        status,
        job,
        updatedAt: Date.now(),
    };
}

async function renderAndFillForm() {
    const result = render(<AddChapterForm />);
    await waitFor(() => expect(apiMocks.getTomes).toHaveBeenCalledWith('one-piece'));
    fireEvent.change(screen.getByLabelText('Tome'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Numéro'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Le test' } });
    fireEvent.change(screen.getByLabelText(/Fichier source/), { target: { files: [makeArchive()] } });
    return result;
}

function submitForm() {
    fireEvent.submit(screen.getByRole('button', {
        name: /Ajouter le Chapitre|Réessayer l'envoi|Nouvel essai/i,
    }).closest('form'));
}

beforeEach(() => {
    window.localStorage.clear();
    randomUUID.mockReset();
    randomUUID.mockReturnValueOnce(FIRST_KEY).mockReturnValueOnce(SECOND_KEY);
    apiMocks.getChapterImport.mockReset();
    apiMocks.getTomes.mockReset().mockResolvedValue({
        data: [{ id: 1, numero: 1, titre: 'East Blue' }],
    });
    apiMocks.uploadChapter.mockReset();
});

afterAll(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: originalRandomUUID,
    });
});

describe('AddChapterForm resumable imports', () => {
    it('keeps the form while queued/processing and only resets after completion', async () => {
        apiMocks.uploadChapter.mockResolvedValue({
            status: 202,
            data: { job: chapterJob('queued'), poll_after_ms: 1500 },
        });
        apiMocks.getChapterImport
            .mockResolvedValueOnce({
                data: {
                    job: chapterJob('processing', {
                        progress: { processed: 1, total: 2, percent: 50 },
                    }),
                    poll_after_ms: 1500,
                },
            })
            .mockResolvedValueOnce({
                data: { job: chapterJob('completed'), poll_after_ms: 1500 },
            });

        await renderAndFillForm();
        submitForm();

        await waitFor(() => expect(apiMocks.getChapterImport).toHaveBeenCalledTimes(1));
        expect(screen.getByLabelText('Numéro')).toHaveValue(42);
        expect(await screen.findByText('Traitement des pages 1/2')).toBeInTheDocument();

        act(() => window.dispatchEvent(new Event('focus')));

        expect(await screen.findByText('Chapitre 42 importé avec succès.')).toBeInTheDocument();
        expect(screen.getByLabelText('Numéro')).toHaveValue(null);
        expect(screen.getByLabelText('Titre')).toHaveValue('');
        expect(screen.getByLabelText('Tome')).toHaveValue('');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('shows transport progress and reuses the same key after an uncertain network failure', async () => {
        let rejectFirstUpload;
        apiMocks.uploadChapter.mockImplementationOnce((_formData, options) => new Promise((_resolve, reject) => {
            rejectFirstUpload = reject;
            options.onUploadProgress({ loaded: 5, total: 10 });
        }));

        const { unmount } = await renderAndFillForm();
        submitForm();

        expect(await screen.findByText("Envoi de l'archive 50 %")).toBeInTheDocument();
        const firstOptions = apiMocks.uploadChapter.mock.calls[0][1];
        expect(firstOptions.idempotencyKey).toBe(FIRST_KEY);
        expect(firstOptions.signal).toBeInstanceOf(AbortSignal);

        await act(async () => rejectFirstUpload(new Error('Network Error')));
        expect(await screen.findByRole('alert')).toHaveTextContent('sans créer de doublon');

        apiMocks.uploadChapter.mockImplementationOnce(() => new Promise(() => {}));
        submitForm();
        await waitFor(() => expect(apiMocks.uploadChapter).toHaveBeenCalledTimes(2));
        expect(apiMocks.uploadChapter.mock.calls[1][1].idempotencyKey).toBe(FIRST_KEY);

        unmount();
        expect(apiMocks.uploadChapter.mock.calls[1][1].signal.aborted).toBe(true);
    });

    it('resumes a stored server job without re-uploading and aborts its status request on unmount', async () => {
        const storedJob = chapterJob('processing', {
            progress: { processed: 1, total: 2, percent: 50 },
        });
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingRecord({
            jobId: JOB_ID,
            status: 'processing',
            job: storedJob,
        })));

        let statusSignal;
        apiMocks.getChapterImport.mockImplementation((_jobId, options) => {
            statusSignal = options.signal;
            return new Promise(() => {});
        });

        const { unmount } = render(<AddChapterForm />);
        await waitFor(() => expect(apiMocks.getChapterImport).toHaveBeenCalledWith(
            JOB_ID,
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        ));

        expect(apiMocks.uploadChapter).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Numéro')).toHaveValue(42);
        expect(screen.getByLabelText('Titre')).toHaveValue('Le test');
        expect(statusSignal.aborted).toBe(false);

        unmount();
        expect(statusSignal.aborted).toBe(true);
    });

    it('asks for the lost File after refresh and keeps the stored key for the same archive', async () => {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingRecord()));
        apiMocks.uploadChapter.mockImplementation(() => new Promise(() => {}));

        const { unmount } = render(<AddChapterForm />);
        expect(await screen.findByText(/Resélectionnez la même archive/i)).toBeInTheDocument();
        expect(screen.getByText(/Archive à resélectionner : chapter-42.cbz/i)).toBeInTheDocument();
        expect(apiMocks.getChapterImport).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText(/Fichier source/), { target: { files: [makeArchive()] } });
        submitForm();

        await waitFor(() => expect(apiMocks.uploadChapter).toHaveBeenCalledOnce());
        expect(apiMocks.uploadChapter.mock.calls[0][1].idempotencyKey).toBe(FIRST_KEY);
        unmount();
    });

    it('preserves fields after a terminal failure but creates a fresh key for a new attempt', async () => {
        apiMocks.uploadChapter.mockResolvedValueOnce({
            status: 202,
            data: {
                job: chapterJob('failed', {
                    error: { code: 'INVALID_IMAGE', message: 'Une page est invalide.' },
                }),
                poll_after_ms: 1500,
            },
        });

        const { unmount } = await renderAndFillForm();
        submitForm();

        expect(await screen.findByRole('alert')).toHaveTextContent('Une page est invalide.');
        expect(screen.getByLabelText('Numéro')).toHaveValue(42);
        expect(screen.getByLabelText('Titre')).toHaveValue('Le test');
        expect(screen.getByRole('button', { name: /Nouvel essai/i })).toBeEnabled();

        apiMocks.uploadChapter.mockImplementationOnce(() => new Promise(() => {}));
        submitForm();
        await waitFor(() => expect(apiMocks.uploadChapter).toHaveBeenCalledTimes(2));
        expect(apiMocks.uploadChapter.mock.calls[0][1].idempotencyKey).toBe(FIRST_KEY);
        expect(apiMocks.uploadChapter.mock.calls[1][1].idempotencyKey).toBe(SECOND_KEY);
        unmount();
    });
});
