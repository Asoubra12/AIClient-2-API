import { getProxyLease } from '../db/proxy-lease-store.js';
import { createIpoasisService } from './ipoasis-service.js';
import { MODEL_PROVIDER } from '../utils/common.js';

export function normalizeIpoasisProtocol(config, providerConfig) {
    const value = providerConfig?.IPOASIS_PROTOCOL || config?.IPOASIS_PROXY_PROTOCOL || 'http';
    return `${value}`.trim().toLowerCase();
}

export function resolveIpoasisCountry(config, providerConfig) {
    return providerConfig?.IPOASIS_COUNTRY || config?.IPOASIS_PROXY_COUNTRY || null;
}

export function applyRuntimeAntigravityProxy(providerConfig, lease) {
    providerConfig.PROXY_URL = lease.proxyUrl || lease.proxy_url || null;
    providerConfig.RUNTIME_PROXY_URL_SOURCE = 'ipoasis';
    providerConfig.RUNTIME_PROXY_LEASE_STATE = lease.leaseState || lease.lease_state || 'ready';
}

export async function materializeAntigravityProxyLease(config, providerConfig, options = {}) {
    const { forceGenerate = false } = options;

    if (!forceGenerate) {
        const persistedLease = getProxyLease(providerConfig.uuid);
        if (persistedLease?.proxy_url) {
            applyRuntimeAntigravityProxy(providerConfig, persistedLease);
            return persistedLease;
        }
    }

    const ipoasisService = createIpoasisService({
        apiKey: config.IPOASIS_API_KEY,
    });
    const generatedLease = await ipoasisService.generateStickyProxy({
        providerUuid: providerConfig.uuid,
        providerType: MODEL_PROVIDER.ANTIGRAVITY,
        subuserId: providerConfig.IPOASIS_SUBUSER_ID,
        protocol: normalizeIpoasisProtocol(config, providerConfig),
        country: resolveIpoasisCountry(config, providerConfig),
        city: providerConfig.IPOASIS_CITY || config.IPOASIS_PROXY_CITY,
        state: providerConfig.IPOASIS_STATE || config.IPOASIS_PROXY_STATE,
    });
    applyRuntimeAntigravityProxy(providerConfig, generatedLease);
    return generatedLease;
}

export async function materializeAntigravityProxyLeases(config) {
    const antigravityPool = config.providerPools?.[MODEL_PROVIDER.ANTIGRAVITY];
    if (!Array.isArray(antigravityPool) || antigravityPool.length === 0) {
        return;
    }

    for (const providerConfig of antigravityPool) {
        if (providerConfig.isDisabled) {
            continue;
        }

        if (providerConfig.PROXY_URL && providerConfig.RUNTIME_PROXY_URL_SOURCE !== 'ipoasis') {
            continue;
        }

        await materializeAntigravityProxyLease(config, providerConfig);
    }
}
