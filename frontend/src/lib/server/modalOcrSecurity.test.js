// @vitest-environment node

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    assertOcrProxyEnabled,
    authenticateOcrRequest,
    consumePersistentOcrQuota,
} from './modalOcrSecurity';

function authRequest(authorization = 'Bearer valid-token') {
    return new Request('https://app.example.test/api/ocr', {
        headers: authorization ? { Authorization: authorization } : {},
    });
}

describe('authenticateOcrRequest', () => {
    let authClient;

    beforeEach(() => {
        authClient = { auth: { getUser: vi.fn() } };
    });

    it('requires a well-formed Bearer token before calling Supabase', async () => {
        await expect(authenticateOcrRequest(authRequest(null), { authClient }))
            .rejects.toMatchObject({ code: 'OCR_AUTH_REQUIRED', status: 401 });
        await expect(authenticateOcrRequest(authRequest('Basic abc'), { authClient }))
            .rejects.toMatchObject({ code: 'OCR_AUTH_INVALID', status: 401 });
        expect(authClient.auth.getUser).not.toHaveBeenCalled();
    });

    it('allows a missing token only when the route explicitly enables anonymous access', async () => {
        await expect(authenticateOcrRequest(authRequest(null), {
            authClient,
            allowAnonymous: true,
        })).resolves.toEqual({ user: null, userId: null, isAnonymous: true });
        expect(authClient.auth.getUser).not.toHaveBeenCalled();
    });

    it('validates the token with Supabase and returns only a verified user', async () => {
        const verifiedUser = { id: '4fa0d98d-87ca-477c-8df3-7fbeeb253fd7' };
        authClient.auth.getUser.mockResolvedValue({
            data: { user: verifiedUser },
            error: null,
        });

        await expect(authenticateOcrRequest(authRequest(), {
            authClient,
            allowAnonymous: true,
        })).resolves.toEqual({
            user: verifiedUser,
            userId: verifiedUser.id,
            isAnonymous: false,
        });
        expect(authClient.auth.getUser).toHaveBeenCalledWith('valid-token');
    });

    it('rejects invalid sessions without exposing provider details', async () => {
        authClient.auth.getUser.mockResolvedValue({
            data: { user: null },
            error: { status: 401, message: 'provider secret detail' },
        });

        await expect(authenticateOcrRequest(authRequest(), {
            authClient,
            allowAnonymous: true,
        }))
            .rejects.toMatchObject({ code: 'OCR_AUTH_INVALID', status: 401 });
    });

    it('fails closed when authentication infrastructure is unavailable', async () => {
        authClient.auth.getUser.mockResolvedValue({
            data: { user: null },
            error: { status: 503, message: 'upstream unavailable' },
        });
        await expect(authenticateOcrRequest(authRequest(), { authClient }))
            .rejects.toMatchObject({ code: 'OCR_AUTH_UNAVAILABLE', status: 503 });

        authClient.auth.getUser.mockRejectedValue(new Error('fetch failed with internal URL'));
        await expect(authenticateOcrRequest(authRequest(), { authClient }))
            .rejects.toMatchObject({ code: 'OCR_AUTH_UNAVAILABLE', status: 503 });
    });
});

describe('consumePersistentOcrQuota', () => {
    const secret = 'quota-secret-at-least-thirty-two-characters';
    const userId = '4fa0d98d-87ca-477c-8df3-7fbeeb253fd7';
    const request = new Request('https://app.example.test/api/ocr', {
        headers: {
            'X-Forwarded-For': '203.0.113.42, 10.0.0.1',
            'X-OCR-Device-Id': 'Browser-Device_123456',
        },
    });
    let quotaClient;
    let env;

    beforeEach(() => {
        quotaClient = { rpc: vi.fn() };
        env = {
            MODAL_OCR_QUOTA_HMAC_SECRET: secret,
            MODAL_OCR_USER_MINUTE_UNITS: '7',
            MODAL_OCR_USER_DAILY_UNITS: '80',
            MODAL_OCR_IP_MINUTE_UNITS: '11',
            MODAL_OCR_DEVICE_MINUTE_UNITS: '9',
            MODAL_OCR_GLOBAL_DAILY_UNITS: '900',
        };
    });

    it('atomically delegates hashed quota subjects and configured limits to the database', async () => {
        quotaClient.rpc.mockResolvedValue({
            data: [{ allowed: true, retry_after_seconds: 0, limited_scope: null }],
            error: null,
        });

        await expect(consumePersistentOcrQuota(
            { request, userId, isAnonymous: false, cost: 2 },
            { env, quotaClient }
        )).resolves.toMatchObject({ allowed: true });

        expect(quotaClient.rpc).toHaveBeenCalledOnce();
        const [functionName, parameters] = quotaClient.rpc.mock.calls[0];
        expect(functionName).toBe('consume_modal_ocr_quota');
        expect(parameters).toEqual({
            p_user_id: userId,
            p_anonymous_hash: null,
            p_ip_hash: createHmac('sha256', secret)
                .update('ip:203.0.113.42', 'utf8')
                .digest('hex'),
            p_device_hash: createHmac('sha256', secret)
                .update('device:browser-device_123456', 'utf8')
                .digest('hex'),
            p_cost: 2,
            p_user_minute_limit: 7,
            p_user_day_limit: 80,
            p_anonymous_minute_limit: 5,
            p_anonymous_day_limit: 15,
            p_ip_minute_limit: 11,
            p_device_minute_limit: 9,
            p_global_day_limit: 900,
            p_anonymous_global_minute_limit: 5,
            p_anonymous_global_day_limit: 100,
        });
        expect(JSON.stringify(parameters)).not.toContain('203.0.113.42');
        expect(JSON.stringify(parameters)).not.toContain('browser-device');
    });

    it('uses non-reversible anonymous subjects and server-owned low limits', async () => {
        quotaClient.rpc.mockResolvedValue({
            data: [{ allowed: true, retry_after_seconds: 0, limited_scope: null }],
            error: null,
        });
        const anonymousRequest = new Request('https://app.example.test/api/poneglyph_one_shot', {
            headers: {
                'CF-Connecting-IP': '198.51.100.7',
                'X-Forwarded-For': '192.0.2.99',
                'X-OCR-Device-Id': 'Anonymous-Device_123456',
                'X-OCR-Quota-Cost': '0',
                'X-OCR-Anonymous-Daily-Units': '999999',
            },
        });

        await consumePersistentOcrQuota(
            { request: anonymousRequest, userId: null, isAnonymous: true, cost: 5 },
            { env, quotaClient }
        );

        const parameters = quotaClient.rpc.mock.calls[0][1];
        expect(parameters).toMatchObject({
            p_user_id: null,
            p_anonymous_hash: createHmac('sha256', secret)
                .update('anonymous:198.51.100.7\u0000anonymous-device_123456', 'utf8')
                .digest('hex'),
            p_ip_hash: createHmac('sha256', secret)
                .update('ip:198.51.100.7', 'utf8')
                .digest('hex'),
            p_device_hash: createHmac('sha256', secret)
                .update('device:anonymous-device_123456', 'utf8')
                .digest('hex'),
            p_cost: 5,
            p_anonymous_minute_limit: 5,
            p_anonymous_day_limit: 15,
            p_ip_minute_limit: 5,
            p_device_minute_limit: 5,
            p_anonymous_global_minute_limit: 5,
            p_anonymous_global_day_limit: 100,
        });
        expect(JSON.stringify(parameters)).not.toContain('198.51.100.7');
        expect(JSON.stringify(parameters)).not.toContain('anonymous-device');
        expect(JSON.stringify(parameters)).not.toContain('999999');
    });

    it('keeps a stable IP counter when an anonymous caller rotates its device header', async () => {
        quotaClient.rpc.mockResolvedValue({
            data: [{ allowed: true, retry_after_seconds: 0, limited_scope: null }],
            error: null,
        });
        const makeRequest = (deviceId) => new Request(
            'https://app.example.test/api/poneglyph_one_shot',
            {
                headers: {
                    'X-Real-IP': '198.51.100.8',
                    'X-Forwarded-For': '192.0.2.44',
                    'X-OCR-Device-Id': deviceId,
                },
            }
        );

        await consumePersistentOcrQuota(
            {
                request: makeRequest('rotated-device-0001'),
                userId: null,
                isAnonymous: true,
                cost: 5,
            },
            { env, quotaClient }
        );
        await consumePersistentOcrQuota(
            {
                request: makeRequest('rotated-device-0002'),
                userId: null,
                isAnonymous: true,
                cost: 5,
            },
            { env, quotaClient }
        );

        const first = quotaClient.rpc.mock.calls[0][1];
        const second = quotaClient.rpc.mock.calls[1][1];
        expect(first.p_ip_hash).toBe(second.p_ip_hash);
        expect(first.p_device_hash).not.toBe(second.p_device_hash);
        expect(first.p_anonymous_hash).not.toBe(second.p_anonymous_hash);
    });

    it('returns a retryable quota error when the persistent limit is reached', async () => {
        quotaClient.rpc.mockResolvedValue({
            data: [{ allowed: false, retry_after_seconds: 37, limited_scope: 'user_minute' }],
            error: null,
        });

        await expect(consumePersistentOcrQuota(
            { request, userId, isAnonymous: false, cost: 1 },
            { env, quotaClient }
        )).rejects.toMatchObject({
            code: 'OCR_QUOTA_EXCEEDED',
            status: 429,
            retryAfter: 37,
        });
    });

    it.each([
        { data: null, error: { message: 'RPC missing' } },
        { data: [], error: null },
        { data: [{ allowed: 'yes' }], error: null },
    ])('fails closed for an unavailable or malformed quota decision', async (rpcResult) => {
        quotaClient.rpc.mockResolvedValue(rpcResult);

        await expect(consumePersistentOcrQuota(
            { request, userId, isAnonymous: false, cost: 1 },
            { env, quotaClient }
        )).rejects.toMatchObject({ code: 'OCR_QUOTA_UNAVAILABLE', status: 503 });
    });

    it('fails closed for missing secrets and invalid limit configuration', async () => {
        await expect(consumePersistentOcrQuota(
            { request, userId, isAnonymous: false, cost: 1 },
            { env: {}, quotaClient }
        )).rejects.toMatchObject({ code: 'OCR_QUOTA_UNAVAILABLE', status: 503 });

        await expect(consumePersistentOcrQuota(
            { request, userId, isAnonymous: false, cost: 1 },
            { env: { ...env, MODAL_OCR_USER_MINUTE_UNITS: '0' }, quotaClient }
        )).rejects.toMatchObject({ code: 'OCR_CONFIGURATION_ERROR', status: 503 });

        await expect(consumePersistentOcrQuota(
            { request, userId: null, isAnonymous: true, cost: 5 },
            { env: { ...env, MODAL_OCR_ANONYMOUS_DAILY_UNITS: '0' }, quotaClient }
        )).rejects.toMatchObject({ code: 'OCR_CONFIGURATION_ERROR', status: 503 });

        await expect(consumePersistentOcrQuota(
            { request, userId, isAnonymous: true, cost: 5 },
            { env, quotaClient }
        )).rejects.toMatchObject({ code: 'OCR_CONFIGURATION_ERROR', status: 503 });
        expect(quotaClient.rpc).not.toHaveBeenCalled();
    });
});

describe('assertOcrProxyEnabled', () => {
    it('is opt-in and fails closed for every value except true', () => {
        expect(() => assertOcrProxyEnabled({})).toThrow(expect.objectContaining({ code: 'OCR_DISABLED' }));
        expect(() => assertOcrProxyEnabled({ MODAL_OCR_ENABLED: 'TRUE' }))
            .toThrow(expect.objectContaining({ code: 'OCR_DISABLED' }));
        expect(() => assertOcrProxyEnabled({ MODAL_OCR_ENABLED: 'true' })).not.toThrow();
    });
});
