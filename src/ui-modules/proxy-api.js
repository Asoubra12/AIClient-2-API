import axios from 'axios';
import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';
import { getEffectiveProxyUrl, getProxySummary, parseProxyUrl } from '../utils/proxy-utils.js';

const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json';
const ALLOWED_TEST_HOSTS = new Set([
    'api.ipify.org',
    'httpbin.org',
]);

function selectProviderConfig(providerPoolManager, providerType, uuid) {
    const pools = providerPoolManager?.providerPools || null;
    const list = pools && typeof pools === 'object' ? pools[providerType] : null;
    if (!Array.isArray(list)) return null;
    return list.find((p) => p?.uuid === uuid) || null;
}

function normalizeNonEmptyString(value) {
    const s = value === undefined || value === null ? '' : String(value).trim();
    return s ? s : null;
}

function resolveTestUrl(candidate) {
    const raw = normalizeNonEmptyString(candidate) || DEFAULT_TEST_URL;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Invalid test URL');
    }
    if (url.protocol !== 'https:') {
        throw new Error('Test URL must use https');
    }
    if (!ALLOWED_TEST_HOSTS.has(url.hostname)) {
        throw new Error(`Test URL host not allowed: ${url.hostname}`);
    }
    return url.toString();
}

async function fetchIp(testUrl, axiosConfig) {
    const started = Date.now();
    const response = await axios.get(testUrl, axiosConfig);
    const elapsedMs = Date.now() - started;
    const data = response?.data || {};
    const observedIp =
        typeof data === 'string'
            ? data.trim()
            : (typeof data?.ip === 'string' ? data.ip.trim() : null);

    return {
        ok: true,
        statusCode: response?.status || 200,
        observedIp: observedIp || null,
        elapsedMs,
    };
}

export async function handleProxySelfTest(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const providerType = normalizeNonEmptyString(body?.providerType);
        const uuid = normalizeNonEmptyString(body?.uuid);
        const proxyUrlOverride = body?.proxyUrl; // raw URL; never echo back
        const timeoutMs = Number.isFinite(Number(body?.timeoutMs))
            ? Math.max(1000, Math.min(30000, Number(body.timeoutMs)))
            : 10000;

        const testUrl = resolveTestUrl(body?.testUrl);

        let nodeConfig = null;
        if (providerType && uuid) {
            nodeConfig = selectProviderConfig(providerPoolManager, providerType, uuid);
            if (!nodeConfig) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: { message: 'Provider node not found' } }));
                return true;
            }
        }

        const mergedConfig = {
            ...(currentConfig || {}),
            ...(nodeConfig || {}),
        };

        // Apply an explicit proxy override if provided in request body.
        // This is treated as a node-level override.
        if (proxyUrlOverride !== undefined) {
            mergedConfig.NODE_PROXY_URL_PRESENT = true;
            mergedConfig.NODE_PROXY_URL = String(proxyUrlOverride || '').trim();
        } else if (nodeConfig && Object.prototype.hasOwnProperty.call(nodeConfig, 'PROXY_URL')) {
            // Match ProviderPoolManager semantics: PROXY_URL present means node override
            mergedConfig.NODE_PROXY_URL_PRESENT = true;
            mergedConfig.NODE_PROXY_URL = String(nodeConfig.PROXY_URL || '').trim();
        }

        const proxySummary = providerType ? getProxySummary(mergedConfig, providerType) : null;
        const effectiveProxy = providerType ? getEffectiveProxyUrl(mergedConfig, providerType) : { proxyUrl: null };
        const parsedProxy = effectiveProxy?.proxyUrl ? parseProxyUrl(effectiveProxy.proxyUrl) : null;

        const baseAxiosConfig = {
            timeout: timeoutMs,
            proxy: false, // never use Axios env proxy; we explicitly control agents
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'AIClient-2-API/ProxySelfTest'
            }
        };

        const proxiedAxiosConfig = parsedProxy
            ? {
                ...baseAxiosConfig,
                httpAgent: parsedProxy.httpAgent,
                httpsAgent: parsedProxy.httpsAgent
            }
            : baseAxiosConfig;

        const result = await fetchIp(testUrl, proxiedAxiosConfig);
        const directResult = (parsedProxy
            ? await (async () => {
                try {
                    return await fetchIp(testUrl, baseAxiosConfig);
                } catch (e) {
                    return {
                        ok: false,
                        statusCode: e?.response?.status ?? null,
                        observedIp: null,
                        elapsedMs: null,
                        error: e?.message ? String(e.message).slice(0, 240) : 'direct request failed'
                    };
                }
            })()
            : null
        );

        logger.info('[Proxy SelfTest] ok', {
            providerType: providerType || null,
            uuid: uuid || null,
            testUrl,
            proxy: proxySummary || null,
            observedIp: result?.observedIp || null
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            providerType: providerType || null,
            uuid: uuid || null,
            testUrl,
            proxy: proxySummary || null,
            result,
            directResult
        }));
        return true;
    } catch (error) {
        logger.warn('[Proxy SelfTest] failed:', error?.message || String(error));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: false,
            error: {
                message: error?.message || String(error)
            }
        }));
        return true;
    }
}

