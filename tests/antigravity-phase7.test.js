import { jest } from '@jest/globals';

const mockDestroyAgent = jest.fn();
const mockGenerateStickyProxy = jest.fn();
const mockLeaseRows = new Map();

jest.mock('../src/providers/adapter.js', () => ({
    __esModule: true,
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
    destroyAgent: (...args) => mockDestroyAgent(...args),
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

import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

function createManager(overrides = {}, globalConfig = {}) {
    const manager = new ProviderPoolManager({
        'gemini-antigravity': [
            {
                uuid: 'acct-a',
                PROXY_URL: 'http://proxy-a:8080',
                RUNTIME_PROXY_URL_SOURCE: 'ipoasis',
                IPOASIS_SUBUSER_ID: 1865,
                isHealthy: true,
                isDisabled: false,
                needsRefresh: false,
                usageCount: 0,
                lastUsed: '2026-03-01T00:00:00.000Z',
                ...overrides.acctA,
            },
            {
                uuid: 'acct-b',
                PROXY_URL: 'http://proxy-b:8080',
                RUNTIME_PROXY_URL_SOURCE: 'ipoasis',
                IPOASIS_SUBUSER_ID: 1865,
                isHealthy: true,
                isDisabled: false,
                needsRefresh: false,
                usageCount: 0,
                lastUsed: '2026-03-02T00:00:00.000Z',
                ...overrides.acctB,
            },
        ],
        ...(overrides.pools || {}),
    }, {
        globalConfig: {
            HOST: 'api.example.test',
            ...globalConfig,
        },
    });
    manager._debouncedSave = jest.fn();
    return manager;
}

describe('Antigravity Phase 7 TLS isolation', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-06T00:00:00.000Z'));
        mockDestroyAgent.mockReset();
        mockGenerateStickyProxy.mockReset();
        mockLeaseRows.clear();
        mockGenerateStickyProxy.mockImplementation(async ({ providerUuid, subuserId }) => ({
            providerUuid,
            subuserId,
            protocol: 'http',
            sessionType: 'sticky',
            proxyUrl: `http://user-${providerUuid}:pass-${providerUuid}@gate.ipoasis.com:8668`,
            leaseState: 'ready',
            lastError: null,
        }));
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
    });

    test('initialization throws when an enabled Antigravity account is missing IPOASIS_SUBUSER_ID', () => {
        expect(() => createManager({
            acctA: {
                IPOASIS_SUBUSER_ID: null,
            },
        })).toThrow(/IPOASIS_SUBUSER_ID/i);
    });

    test('initialization throws when an enabled Antigravity account still uses a manual PROXY_URL', () => {
        expect(() => createManager({
            acctA: {
                RUNTIME_PROXY_URL_SOURCE: null,
            },
        })).toThrow(/manual .*PROXY_URL/i);
    });

    test('disabled Antigravity accounts do not block startup when they are missing IPOASIS runtime config', async () => {
        const manager = createManager({
            acctA: {
                PROXY_URL: null,
                IPOASIS_SUBUSER_ID: null,
                RUNTIME_PROXY_URL_SOURCE: null,
                isDisabled: true,
                lastUsed: '2026-03-01T00:00:00.000Z',
            },
            acctB: {
                PROXY_URL: 'http://proxy-b:8080',
                RUNTIME_PROXY_URL_SOURCE: 'ipoasis',
                lastUsed: '2026-03-02T00:00:00.000Z',
            },
        });

        const selected = await manager.selectProvider('gemini-antigravity');

        expect(selected.uuid).toBe('acct-b');
    });

    test('selectProvider delays rapid switches between Antigravity accounts on the same host', async () => {
        const manager = createManager({
            acctA: { PROXY_URL: 'http://proxy-a:8080' },
            acctB: { PROXY_URL: 'http://proxy-b:8080' },
        }, {
            TLS_MIN_SWITCH_GAP_MS: 1000,
            TLS_MAX_NEW_SESSIONS_PER_MIN: 99,
        });

        await manager.selectProvider('gemini-antigravity', null, { preSelectedUuid: 'acct-a' });

        const switchPromise = manager.selectProvider('gemini-antigravity', null, { preSelectedUuid: 'acct-b' });
        let resolved = false;
        switchPromise.then(() => {
            resolved = true;
        });

        await jest.advanceTimersByTimeAsync(999);
        expect(resolved).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await expect(switchPromise).resolves.toMatchObject({ uuid: 'acct-b' });
    });

    test('selectProvider delays new Antigravity sessions when the per-minute cap is exceeded', async () => {
        const manager = createManager({
            acctA: { PROXY_URL: 'http://proxy-a:8080' },
            acctB: { PROXY_URL: 'http://proxy-b:8080' },
        }, {
            TLS_MIN_SWITCH_GAP_MS: 0,
            TLS_MAX_NEW_SESSIONS_PER_MIN: 1,
        });

        await manager.selectProvider('gemini-antigravity', null, { preSelectedUuid: 'acct-a' });

        const cappedPromise = manager.selectProvider('gemini-antigravity', null, { preSelectedUuid: 'acct-b' });
        let resolved = false;
        cappedPromise.then(() => {
            resolved = true;
        });

        await jest.advanceTimersByTimeAsync(59999);
        expect(resolved).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await expect(cappedPromise).resolves.toMatchObject({ uuid: 'acct-b' });
    });

    test('markProviderUnhealthyImmediately destroys the cached Antigravity agent and quarantine transitions do the same', () => {
        const manager = createManager({
            acctA: { PROXY_URL: 'http://proxy-a:8080' },
            acctB: { PROXY_URL: 'http://proxy-b:8080' },
        });

        manager.markProviderUnhealthyImmediately(
            'gemini-antigravity',
            { uuid: 'acct-a' },
            '401 unauthorized'
        );
        manager.transitionProviderLifecycleState(
            'gemini-antigravity',
            { uuid: 'acct-b' },
            'quarantined'
        );

        expect(mockDestroyAgent).toHaveBeenCalledTimes(2);
        expect(mockDestroyAgent).toHaveBeenNthCalledWith(1, 'acct-a');
        expect(mockDestroyAgent).toHaveBeenNthCalledWith(2, 'acct-b');
    });

    test('resetProviderRefreshStatus regenerates a missing runtime proxy before re-admitting a refreshed unhealthy account', async () => {
        const manager = createManager({
            acctA: {
                PROXY_URL: 'http://proxy-a:8080',
                isHealthy: false,
                needsRefresh: true,
                refreshCount: 3,
                errorCount: 10,
                lastErrorTime: '2026-03-05T23:59:00.000Z',
                lastErrorMessage: 'refresh failed',
            },
        });

        const provider = manager.providerStatus['gemini-antigravity'].find(entry => entry.uuid === 'acct-a');
        provider.config.PROXY_URL = null;
        provider.config.RUNTIME_PROXY_URL_SOURCE = null;
        mockLeaseRows.set('acct-a', {
            provider_uuid: 'acct-a',
            lease_state: 'error',
            last_error: 'proxy auth failed',
        });

        await manager.resetProviderRefreshStatus('gemini-antigravity', 'acct-a');

        const refreshed = manager.providerStatus['gemini-antigravity'].find(provider => provider.uuid === 'acct-a').config;
        expect(mockGenerateStickyProxy).toHaveBeenCalledWith(expect.objectContaining({
            providerUuid: 'acct-a',
            subuserId: 1865,
        }));
        expect(refreshed.isHealthy).toBe(true);
        expect(refreshed.needsRefresh).toBe(false);
        expect(refreshed.refreshCount).toBe(0);
        expect(refreshed.errorCount).toBe(0);
        expect(refreshed.lastErrorTime).toBeNull();
        expect(refreshed.lastErrorMessage).toBeNull();
        expect(refreshed.PROXY_URL).toBe('http://user-acct-a:pass-acct-a@gate.ipoasis.com:8668');
        expect(refreshed.RUNTIME_PROXY_URL_SOURCE).toBe('ipoasis');
    });
});
