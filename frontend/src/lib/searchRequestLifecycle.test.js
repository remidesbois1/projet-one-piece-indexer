import { describe, expect, it } from 'vitest';
import { createSearchRequestLifecycle } from './searchRequestLifecycle';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('search request lifecycle', () => {
    it('keeps the newer B result when the older A request resolves last', async () => {
        const lifecycle = createSearchRequestLifecycle();
        const firstResponse = deferred();
        const secondResponse = deferred();
        const state = { loading: false, results: [] };
        const requests = [];

        const run = async (response) => {
            const request = lifecycle.begin();
            requests.push(request);
            lifecycle.commit(request.requestId, () => {
                state.loading = true;
            });

            try {
                const results = await response.promise;
                lifecycle.commit(request.requestId, () => {
                    state.results = results;
                });
            } finally {
                lifecycle.commit(request.requestId, () => {
                    state.loading = false;
                });
                lifecycle.finish(request.requestId);
            }
        };

        const firstRun = run(firstResponse);
        const secondRun = run(secondResponse);

        expect(requests[0].signal.aborted).toBe(true);
        expect(requests[1].signal.aborted).toBe(false);

        secondResponse.resolve(['B']);
        await secondRun;
        expect(state).toEqual({ loading: false, results: ['B'] });

        firstResponse.resolve(['A']);
        await firstRun;
        expect(state).toEqual({ loading: false, results: ['B'] });
    });

    it('invalidates both the transport and every guarded setter', () => {
        const lifecycle = createSearchRequestLifecycle();
        const request = lifecycle.begin();
        let committed = false;

        lifecycle.invalidate();

        expect(request.signal.aborted).toBe(true);
        expect(lifecycle.commit(request.requestId, () => {
            committed = true;
        })).toBe(false);
        expect(committed).toBe(false);
    });
});
