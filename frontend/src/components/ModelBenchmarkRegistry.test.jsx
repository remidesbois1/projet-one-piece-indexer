import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ModelBenchmarkRegistry from './ModelBenchmarkRegistry';

describe('ModelBenchmarkRegistry', () => {
    it('shows pinned benchmark provenance in the admin dashboard', () => {
        render(<ModelBenchmarkRegistry />);

        expect(screen.getByRole('heading', { name: 'Benchmarks publiés' })).toBeInTheDocument();
        expect(screen.getByText('LightOnOCR Poneglyph')).toBeInTheDocument();
        expect(screen.getByText('CER 0,424 %')).toBeInTheDocument();
        expect(screen.getByText('Modal NVIDIA H100')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Ouvrir la preuve de LightOnOCR Poneglyph' })).toHaveAttribute('href', expect.stringContaining('3d5181ce138e7d92132a741f1e54c3a9e602e129'));
    });
});
