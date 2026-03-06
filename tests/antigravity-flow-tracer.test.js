import fs from 'fs';
import { jest } from '@jest/globals';

const mockGetServiceAdapter = jest.fn();
const mockGenerateStickyProxy = jest.fn();
const mockLeaseRows = new Map();

jest.mock('../src/providers/adapter.js', () => ({
    __esModule: true,
    getServiceAdapter: (...args) => mockGetServiceAdapter(...args),
    getRegisteredProviders: jest.fn(() => ['openai-custom', 'gemini-antigravity']),
}));

jest.mock('../src/services/ipoasis-service.js', () => ({
    __esModule: true,
    createIpoasisService: jest.fn(() => ({
        generateStickyProxy: (...args) => mockGenerateStickyProxy(...args),
    })),
}));

jest.mock('../src/db/proxy-lease-store.js', () => ({
    __esModule: true,
    getProxyLease: providerUuid => mockLeaseRows.get(providerUuid) || null,
    saveProxyLease: lease => {
        mockLeaseRows.set(lease.providerUuid, {
            provider_uuid: lease.providerUuid,
            subuser_id: lease.subuserId,
            proxy_url: lease.proxyUrl,
            protocol: lease.protocol,
            session_type: lease.sessionType,
            lease_state: lease.leaseState || 'ready',
            last_error: lease.lastError ?? null,
        });
    },
    markProxyLeaseError: (providerUuid, message) => {
        const current = mockLeaseRows.get(providerUuid) || {
            provider_uuid: providerUuid,
            lease_state: 'error',
        };
        mockLeaseRows.set(providerUuid, {
            ...current,
            last_error: message,
            lease_state: 'error',
        });
    },
}));

import {
    getApiServiceWithFallback,
    getProviderPoolManager,
    getProviderStatus,
    initApiService,
} from '../src/services/service-manager.js';

describe('FLOWTRACER service-manager regressions', () => {
    afterEach(() => {
        mockGetServiceAdapter.mockReset();
        mockGenerateStickyProxy.mockReset();
        mockLeaseRows.clear();
    });

    test('releases an acquired pool slot when adapter construction fails after selection', async () => {
        const config = {
            MODEL_PROVIDER: 'openai-custom',
            providerPools: {
                'openai-custom': [
                    {
                        uuid: 'acct-a',
                        OPENAI_BASE_URL: 'https://api-a.example.com',
                        isHealthy: true,
                        isDisabled: false,
                        needsRefresh: false,
                        usageCount: 0,
                        lastUsed: '2026-03-01T00:00:00.000Z',
                        concurrencyLimit: 1,
                        queueLimit: 0,
                    },
                ],
            },
        };

        mockGetServiceAdapter.mockImplementation(() => ({}));
        await initApiService(config, false);

        const poolManager = getProviderPoolManager();
        poolManager._debouncedSave = jest.fn();
        expect(poolManager.providerStatus['openai-custom'][0].state.activeCount).toBe(0);

        mockGetServiceAdapter.mockImplementation(() => {
            throw new Error('adapter init failed');
        });

        await expect(
            getApiServiceWithFallback(config, 'gpt-4o-mini', { acquireSlot: true })
        ).rejects.toThrow('adapter init failed');

        expect(poolManager.providerStatus['openai-custom'][0].state.activeCount).toBe(0);
    });

    test('provider health reports non-selectable nodes as unhealthy when they are stuck in needsRefresh', async () => {
        const config = {
            MODEL_PROVIDER: 'gemini-antigravity',
            IPOASIS_API_KEY: 'ipoasis-key',
            IPOASIS_PROXY_COUNTRY: 'US',
            providerPools: {
            'gemini-antigravity': [
                {
                    customName: 'acct-a',
                    IPOASIS_SUBUSER_ID: 1865,
                    isHealthy: true,
                    isDisabled: false,
                    needsRefresh: true,
                    lastErrorTime: null,
                    lastErrorMessage: null,
                    ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'configs/acct-a.json',
                },
            ],
            },
        };

        mockGenerateStickyProxy.mockImplementation(async ({ providerUuid, subuserId }) => ({
            providerUuid,
            subuserId,
            protocol: 'http',
            sessionType: 'sticky',
            proxyUrl: `http://user-${providerUuid}:pass-${providerUuid}@gate.ipoasis.com:8668`,
            leaseState: 'ready',
            lastError: null,
        }));
        mockGetServiceAdapter.mockImplementation(() => ({}));
        await initApiService(config, false);

        const status = await getProviderStatus(config);

        expect(status.providerPoolsSlim).toEqual([
            expect.objectContaining({
                customName: 'acct-a',
                rawIsHealthy: true,
                isHealthy: false,
                isSelectable: false,
                availabilityState: 'needs_refresh',
            }),
        ]);
        expect(status.unhealthyCount).toBe(1);
        expect(status.unhealthyRatio).toBe(1);
    });
});
