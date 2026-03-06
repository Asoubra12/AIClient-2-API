import { jest } from '@jest/globals';

const mockGetServiceAdapter = jest.fn();
const mockGenerateStickyProxy = jest.fn();
const mockLeaseRows = new Map();
const serviceInstances = {};

jest.mock('../src/providers/adapter.js', () => ({
    __esModule: true,
    getServiceAdapter: (...args) => mockGetServiceAdapter(...args),
    serviceInstances,
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

describe('Antigravity Phase 3 startup prewarm', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-06T00:00:00.000Z'));
        mockGetServiceAdapter.mockReset();
        mockGenerateStickyProxy.mockReset();
        mockLeaseRows.clear();
        Object.keys(serviceInstances).forEach(key => {
            delete serviceInstances[key];
        });

        mockGenerateStickyProxy.mockImplementation(async ({ providerUuid, subuserId, protocol, country, city, state }) => ({
            providerUuid,
            subuserId,
            protocol: protocol || 'http',
            country,
            city,
            state,
            sessionType: 'sticky',
            proxyUrl: `http://user-${providerUuid}:pass-${providerUuid}@gate.ipoasis.com:8668`,
            leaseState: 'ready',
            lastError: null,
        }));
    });

    afterEach(async () => {
        const manager = getProviderPoolManager();
        if (manager?.saveTimer) {
            clearTimeout(manager.saveTimer);
            manager.saveTimer = null;
        }
        if (manager?.pendingSaves?.clear) {
            manager.pendingSaves.clear();
        }
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
    });

    test('initApiService prewarms Antigravity accounts in 5-account batches with 1-second gaps', async () => {
        const initializeCalls = [];
        const adaptersByUuid = new Map();

        mockGetServiceAdapter.mockImplementation((config) => {
            if (!adaptersByUuid.has(config.uuid)) {
                adaptersByUuid.set(config.uuid, {
                    antigravityApiService: {
                        initialize: jest.fn(async () => {
                            initializeCalls.push({
                                uuid: config.uuid,
                                at: Date.now(),
                            });
                        }),
                    },
                });
            }

            return adaptersByUuid.get(config.uuid);
        });

        const antigravityNodes = Array.from({ length: 6 }, (_unused, index) => ({
            uuid: `acct-${index + 1}`,
            IPOASIS_SUBUSER_ID: 1865,
            isHealthy: true,
            isDisabled: false,
        }));

        const initPromise = initApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            DEFAULT_MODEL_PROVIDERS: ['gemini-antigravity'],
            IPOASIS_API_KEY: 'ipoasis-key',
            IPOASIS_PROXY_COUNTRY: 'US',
            providerPools: {
                'gemini-antigravity': antigravityNodes,
            },
        }, true);

        await jest.advanceTimersByTimeAsync(0);

        expect(initializeCalls).toHaveLength(5);
        expect(mockGenerateStickyProxy).toHaveBeenCalledTimes(6);
        expect(new Set(initializeCalls.slice(0, 5).map(call => call.at))).toEqual(
            new Set([Date.parse('2026-03-06T00:00:00.000Z')])
        );

        await jest.advanceTimersByTimeAsync(999);
        expect(initializeCalls).toHaveLength(5);

        await jest.advanceTimersByTimeAsync(1);
        await initPromise;

        expect(initializeCalls).toHaveLength(6);
        expect(initializeCalls[5]).toEqual({
            uuid: 'acct-6',
            at: Date.parse('2026-03-06T00:00:01.000Z'),
        });
    });

    test('failed startup prewarm marks the node as needing refresh before it can be selected', async () => {
        const antigravityNodes = [
            {
                uuid: 'acct-a',
                IPOASIS_SUBUSER_ID: 1865,
                isHealthy: true,
                isDisabled: false,
            },
        ];

        mockGetServiceAdapter.mockImplementation(() => ({
            antigravityApiService: {
                initialize: jest.fn().mockRejectedValue(new Error('bootstrap failed')),
            },
        }));

        await initApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            DEFAULT_MODEL_PROVIDERS: ['gemini-antigravity'],
            IPOASIS_API_KEY: 'ipoasis-key',
            IPOASIS_PROXY_COUNTRY: 'US',
            providerPools: {
                'gemini-antigravity': antigravityNodes,
            },
        }, true);

        expect(antigravityNodes[0]).toMatchObject({
            needsRefresh: true,
        });
    });

    test('getApiServiceWithFallback releases an acquired slot if adapter creation throws', async () => {
        const config = {
            MODEL_PROVIDER: 'gemini-antigravity',
            IPOASIS_API_KEY: 'ipoasis-key',
            IPOASIS_PROXY_COUNTRY: 'US',
            providerPools: {
                'gemini-antigravity': [
                    {
                        uuid: 'acct-a',
                        isHealthy: true,
                        isDisabled: false,
                        IPOASIS_SUBUSER_ID: 1865,
                    },
                ],
            },
        };

        mockGetServiceAdapter.mockReturnValueOnce({
            antigravityApiService: {
                initialize: jest.fn().mockResolvedValue(undefined),
            },
        });
        await initApiService(config, false);

        const manager = getProviderPoolManager();
        const providerState = manager.providerStatus['gemini-antigravity'][0].state;
        expect(providerState.activeCount).toBe(0);

        mockGetServiceAdapter.mockImplementation(() => {
            throw new Error('adapter creation failed');
        });

        await expect(
            getApiServiceWithFallback(config, 'gemini-2.5-pro', { acquireSlot: true })
        ).rejects.toThrow('adapter creation failed');

        expect(providerState.activeCount).toBe(0);
    });

    test('getProviderStatus counts needsRefresh accounts as unavailable for provider_health', async () => {
        const config = {
            MODEL_PROVIDER: 'gemini-antigravity',
            IPOASIS_API_KEY: 'ipoasis-key',
            IPOASIS_PROXY_COUNTRY: 'US',
            providerPools: {
                'gemini-antigravity': [
                    {
                        uuid: 'acct-a',
                        customName: 'acct-a',
                        IPOASIS_SUBUSER_ID: 1865,
                        ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'configs/acct-a.json',
                        isHealthy: true,
                        needsRefresh: true,
                        isDisabled: false,
                    },
                ],
            },
        };

        mockGetServiceAdapter.mockReturnValue({
            antigravityApiService: {
                initialize: jest.fn().mockResolvedValue(undefined),
            },
        });
        await initApiService(config, false);

        const status = await getProviderStatus(config, {
            provider: 'gemini-antigravity',
        });

        expect(status.unhealthyCount).toBe(1);
        expect(status.providerPoolsSlim[0]).toMatchObject({
            customName: 'acct-a',
            needsRefresh: true,
            isSelectable: false,
        });
    });

    test('initApiService hydrates a persisted lease before adapter initialization', async () => {
        mockLeaseRows.set('acct-a', {
            provider_uuid: 'acct-a',
            subuser_id: 1865,
            proxy_url: 'http://persisted-user:persisted-pass@gate.ipoasis.com:8668',
            protocol: 'http',
            session_type: 'sticky',
            lease_state: 'ready',
            last_error: null,
        });

        const seenProxyUrls = [];
        mockGetServiceAdapter.mockImplementation((config) => {
            seenProxyUrls.push(config.PROXY_URL);
            return {
                antigravityApiService: {
                    initialize: jest.fn().mockResolvedValue(undefined),
                },
            };
        });

        await initApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            DEFAULT_MODEL_PROVIDERS: ['gemini-antigravity'],
            IPOASIS_API_KEY: 'ipoasis-key',
            IPOASIS_PROXY_COUNTRY: 'US',
            providerPools: {
                'gemini-antigravity': [
                    {
                        uuid: 'acct-a',
                        IPOASIS_SUBUSER_ID: 1865,
                        isHealthy: true,
                        isDisabled: false,
                    },
                ],
            },
        }, false);

        expect(mockGenerateStickyProxy).not.toHaveBeenCalled();
        expect(seenProxyUrls).toContain('http://persisted-user:persisted-pass@gate.ipoasis.com:8668');
    });
});
