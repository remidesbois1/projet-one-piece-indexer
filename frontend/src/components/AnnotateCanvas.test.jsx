import React, { useRef, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AnnotateCanvas from './AnnotateCanvas';

const OLD_DIMENSIONS = {
    width: 300,
    height: 300,
    naturalWidth: 600,
    naturalHeight: 600,
};

function CanvasHarness({ imageUrl }) {
    const [imageDimensions, setImageDimensions] = useState(OLD_DIMENSIONS);
    const imageRef = useRef(null);
    const containerRef = useRef(null);
    return (
        <AnnotateCanvas
            canEdit={false}
            imageDimensions={imageDimensions}
            setImageDimensions={setImageDimensions}
            containerRef={containerRef}
            imageRef={imageRef}
            handleMouseDown={vi.fn()}
            handleMouseMove={vi.fn()}
            handleMouseUp={vi.fn()}
            imageUrl={imageUrl}
            isSubmitting={false}
            rectangle={null}
            pendingAnnotation={null}
            isAutoDetecting={false}
            isShiftPressed={false}
            handleInteractionStart={vi.fn()}
            setIsModalOpen={vi.fn()}
            isDrawing={false}
            existingBubbles={[{ id: 1, x: 100, y: 200, w: 300, h: 400 }]}
            setHoveredBubble={vi.fn()}
            hoveredBubble={null}
            handleEditBubble={vi.fn()}
        />
    );
}

describe('AnnotateCanvas secure image sizing', () => {
    let observers;

    beforeEach(() => {
        observers = [];
        global.ResizeObserver = class {
            constructor(callback) {
                this.callback = callback;
                this.disconnect = vi.fn();
                observers.push(this);
            }

            observe(target) {
                this.target = target;
            }
        };
    });

    afterEach(() => {
        delete global.ResizeObserver;
    });

    it('re-measures bboxes after the authenticated blob enters the canvas', () => {
        const { rerender } = render(<CanvasHarness imageUrl="blob:secure-page-1" />);
        const image = screen.getByAltText('Manga Page');
        Object.defineProperties(image, {
            naturalWidth: { configurable: true, value: 1000 },
            naturalHeight: { configurable: true, value: 1500 },
            complete: { configurable: true, value: true },
        });
        image.getBoundingClientRect = () => ({ width: 500, height: 750 });

        act(() => observers[0].callback([{ target: image }]));

        const bubble = screen.getByText('#1').parentElement;
        expect(bubble.style.left).toBe('50px');
        expect(bubble.style.top).toBe('100px');
        expect(bubble.style.width).toBe('150px');
        expect(bubble.style.height).toBe('200px');

        rerender(<CanvasHarness imageUrl="blob:secure-page-2" />);
        expect(observers[0].disconnect).toHaveBeenCalledOnce();
        expect(observers).toHaveLength(2);
    });
});
