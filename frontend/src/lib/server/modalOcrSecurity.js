import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_LIMITS = Object.freeze({
    userMinute: 60,
    userDay: 1000,
    ipMinute: 120,
    deviceMinute: 60,
    globalDay: 10000,
    anonymousMinute: 5,
    anonymousDay: 15,
    anonymousIpMinute: 5,
    anonymousDeviceMinute: 5,
    anonymousGlobalMinute: 5,
    anonymousGlobalDay: 100,
});

let cachedClients = null;

export class OcrProxyError extends Error {
    constructor(code, status, message, options = {}) {
        super(message);
        this.name = 'OcrProxyError';
        this.code = code;
        this.status = status;
        this.retryAfter = options.retryAfter;
    }
}

function readPositiveInteger(env, name, fallback) {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue === '') return fallback;

    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new OcrProxyError('OCR_CONFIGURATION_ERROR', 503, 'Service OCR indisponible.');
    }
    return value;
}

function createServerClients(env) {
    const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        throw new OcrProxyError('OCR_SECURITY_UNAVAILABLE', 503, 'Service OCR indisponible.');
    }

    const options = {
        auth: {
            autoRefreshToken: false,
            detectSessionInUrl: false,
            persistSession: false,
        },
    };

    return {
        authClient: createClient(supabaseUrl, anonKey, options),
        quotaClient: createClient(supabaseUrl, serviceRoleKey, options),
    };
}

function getServerClients(env) {
    if (env !== process.env) return createServerClients(env);

    const signature = [
        env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL,
        env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        env.SUPABASE_SERVICE_ROLE_KEY,
    ].join('\u0000');

    if (!cachedClients || cachedClients.signature !== signature) {
        cachedClients = { signature, ...createServerClients(env) };
    }
    return cachedClients;
}

function isInfrastructureAuthError(error) {
    const status = Number(error?.status);
    return error?.name === 'AuthRetryableFetchError'
        || status === 0
        || status >= 500
        || /fetch failed|failed to fetch|network|timeout/i.test(error?.message || '');
}

function extractBearerToken(request, allowAnonymous) {
    const authorization = request.headers.get('authorization') || '';
    if (!authorization) {
        if (allowAnonymous) return null;
        throw new OcrProxyError('OCR_AUTH_REQUIRED', 401, 'Authentification requise.');
    }

    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    if (!match || match[1].length > 8192) {
        throw new OcrProxyError('OCR_AUTH_INVALID', 401, 'Session invalide ou expirée.');
    }
    return match[1];
}

export async function authenticateOcrRequest(request, options = {}) {
    const env = options.env || process.env;
    const allowAnonymous = options.allowAnonymous === true;
    const token = extractBearerToken(request, allowAnonymous);
    if (!token) {
        return { user: null, userId: null, isAnonymous: true };
    }
    const authClient = options.authClient || getServerClients(env).authClient;

    let result;
    try {
        result = await authClient.auth.getUser(token);
    } catch {
        throw new OcrProxyError('OCR_AUTH_UNAVAILABLE', 503, 'Service OCR indisponible.');
    }

    if (result?.error || !result?.data?.user?.id) {
        if (isInfrastructureAuthError(result?.error)) {
            throw new OcrProxyError('OCR_AUTH_UNAVAILABLE', 503, 'Service OCR indisponible.');
        }
        throw new OcrProxyError('OCR_AUTH_INVALID', 401, 'Session invalide ou expirée.');
    }

    return {
        user: result.data.user,
        userId: result.data.user.id,
        isAnonymous: false,
    };
}

function normalizeForwardedValue(value, fallback) {
    const normalized = String(value || '')
        .split(',')[0]
        .trim()
        .toLowerCase()
        .slice(0, 256);
    return normalized || fallback;
}

function getQuotaSubjects(request) {
    const ip = normalizeForwardedValue(
        request.headers.get('cf-connecting-ip')
            || request.headers.get('x-vercel-forwarded-for')
            || request.headers.get('x-real-ip')
            || request.headers.get('x-forwarded-for'),
        'unknown-ip'
    );
    const device = normalizeForwardedValue(
        request.headers.get('x-ocr-device-id'),
        'missing-device'
    );
    return { ip, device };
}

function hashSubject(secret, namespace, value) {
    return createHmac('sha256', secret)
        .update(`${namespace}:${value}`, 'utf8')
        .digest('hex');
}

export async function consumePersistentOcrQuota({ request, userId, isAnonymous, cost }, options = {}) {
    const env = options.env || process.env;
    const hmacSecret = env.MODAL_OCR_QUOTA_HMAC_SECRET;

    if (!hmacSecret || hmacSecret.length < 32) {
        throw new OcrProxyError('OCR_QUOTA_UNAVAILABLE', 503, 'Service OCR indisponible.');
    }
    if (
        typeof isAnonymous !== 'boolean'
        || (isAnonymous && userId)
        || (!isAnonymous && !userId)
        || !Number.isSafeInteger(cost)
        || cost <= 0
    ) {
        throw new OcrProxyError('OCR_CONFIGURATION_ERROR', 503, 'Service OCR indisponible.');
    }
    const quotaClient = options.quotaClient || getServerClients(env).quotaClient;

    const limits = {
        userMinute: readPositiveInteger(env, 'MODAL_OCR_USER_MINUTE_UNITS', DEFAULT_LIMITS.userMinute),
        userDay: readPositiveInteger(env, 'MODAL_OCR_USER_DAILY_UNITS', DEFAULT_LIMITS.userDay),
        ipMinute: readPositiveInteger(
            env,
            isAnonymous ? 'MODAL_OCR_ANONYMOUS_IP_MINUTE_UNITS' : 'MODAL_OCR_IP_MINUTE_UNITS',
            isAnonymous ? DEFAULT_LIMITS.anonymousIpMinute : DEFAULT_LIMITS.ipMinute
        ),
        deviceMinute: readPositiveInteger(
            env,
            isAnonymous ? 'MODAL_OCR_ANONYMOUS_DEVICE_MINUTE_UNITS' : 'MODAL_OCR_DEVICE_MINUTE_UNITS',
            isAnonymous ? DEFAULT_LIMITS.anonymousDeviceMinute : DEFAULT_LIMITS.deviceMinute
        ),
        globalDay: readPositiveInteger(env, 'MODAL_OCR_GLOBAL_DAILY_UNITS', DEFAULT_LIMITS.globalDay),
        anonymousMinute: readPositiveInteger(
            env,
            'MODAL_OCR_ANONYMOUS_MINUTE_UNITS',
            DEFAULT_LIMITS.anonymousMinute
        ),
        anonymousDay: readPositiveInteger(
            env,
            'MODAL_OCR_ANONYMOUS_DAILY_UNITS',
            DEFAULT_LIMITS.anonymousDay
        ),
        anonymousGlobalDay: readPositiveInteger(
            env,
            'MODAL_OCR_ANONYMOUS_GLOBAL_DAILY_UNITS',
            DEFAULT_LIMITS.anonymousGlobalDay
        ),
        anonymousGlobalMinute: readPositiveInteger(
            env,
            'MODAL_OCR_ANONYMOUS_GLOBAL_MINUTE_UNITS',
            DEFAULT_LIMITS.anonymousGlobalMinute
        ),
    };
    const { ip, device } = getQuotaSubjects(request);
    const ipHash = hashSubject(hmacSecret, 'ip', ip);
    const deviceHash = hashSubject(hmacSecret, 'device', device);
    const anonymousHash = isAnonymous
        ? hashSubject(hmacSecret, 'anonymous', `${ip}\u0000${device}`)
        : null;

    let result;
    try {
        result = await quotaClient.rpc('consume_modal_ocr_quota', {
            p_user_id: userId,
            p_anonymous_hash: anonymousHash,
            p_ip_hash: ipHash,
            p_device_hash: deviceHash,
            p_cost: cost,
            p_user_minute_limit: limits.userMinute,
            p_user_day_limit: limits.userDay,
            p_anonymous_minute_limit: limits.anonymousMinute,
            p_anonymous_day_limit: limits.anonymousDay,
            p_ip_minute_limit: limits.ipMinute,
            p_device_minute_limit: limits.deviceMinute,
            p_global_day_limit: limits.globalDay,
            p_anonymous_global_minute_limit: limits.anonymousGlobalMinute,
            p_anonymous_global_day_limit: limits.anonymousGlobalDay,
        });
    } catch {
        throw new OcrProxyError('OCR_QUOTA_UNAVAILABLE', 503, 'Service OCR indisponible.');
    }

    const decision = Array.isArray(result?.data) ? result.data[0] : null;
    if (result?.error || typeof decision?.allowed !== 'boolean') {
        throw new OcrProxyError('OCR_QUOTA_UNAVAILABLE', 503, 'Service OCR indisponible.');
    }
    if (!decision.allowed) {
        const retryAfter = Number.isSafeInteger(decision.retry_after_seconds)
            ? Math.max(1, decision.retry_after_seconds)
            : 60;
        throw new OcrProxyError('OCR_QUOTA_EXCEEDED', 429, 'Quota OCR atteint.', { retryAfter });
    }

    return decision;
}

export function assertOcrProxyEnabled(env = process.env) {
    if (env.MODAL_OCR_ENABLED !== 'true') {
        throw new OcrProxyError('OCR_DISABLED', 503, 'Service OCR indisponible.');
    }
}
