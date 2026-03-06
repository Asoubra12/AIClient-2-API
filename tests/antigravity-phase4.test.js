import { jest } from '@jest/globals';

const mockGetQuota = jest.fn();
const mockDecrementLocalEstimate = jest.fn();
const mockIncrementLocalEstimate = jest.fn();
const mockTriggerColdStartRefresh = jest.fn();
const mockEnsureStarted = jest.fn();
const mockGetServiceAdapter = jest.fn();
const mockGetProviderPoolManager = jest.fn(() => null);

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn(),
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    __esModule: true,
    handleGeminiAntigravityOAuth: jest.fn(),
}));

jest.mock('../src/db/quota-store.js', () => ({
    __esModule: true,
    getQuota: (...args) => mockGetQuota(...args),
    decrementLocalEstimate: (...args) => mockDecrementLocalEstimate(...args),
    incrementLocalEstimate: (...args) => mockIncrementLocalEstimate(...args),
    upsertQuota: jest.fn(),
}));

jest.mock('../src/providers/adapter.js', () => ({
    __esModule: true,
    getServiceAdapter: (...args) => mockGetServiceAdapter(...args),
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: (...args) => mockGetProviderPoolManager(...args),
}));

import pipeline from '../src/middleware/antigravity/index.js';
import { QuotaSelectHook, reconcileQuotaReservation } from '../src/middleware/antigravity/quota-select.js';
import { QuotaScheduler, quotaScheduler } from '../src/middleware/antigravity/quota-scheduler.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

function resetPipeline() {
    pipeline.preHooks = [];
    pipeline.postHooks = [];
    pipeline._initialized = false;
}

function createServiceConfig(overrides = {}) {
    return {
        HOST: '127.0.0.1',
        PROJECT_ID: null,
        REQUEST_MAX_RETRIES: 0,
        REQUEST_BASE_DELAY: 1,
        providerPools: {},
        ...overrides,
    };
}

function createAntigravityProvider(overrides = {}) {
    return {
        uuid: 'acct-a',
        IPOASIS_SUBUSER_ID: 1865,
        PROXY_URL: 'http://proxy-a:8080',
        RUNTIME_PROXY_URL_SOURCE: 'ipoasis',
        ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-a@example.com',
        isDisabled: false,
        isHealthy: true,
        needsRefresh: false,
        ...overrides,
    };
}

describe('Antigravity Phase 4 quota selection', () => {
    beforeEach(() => {
        resetPipeline();
        mockGetQuota.mockReset();
        mockDecrementLocalEstimate.mockReset();
        mockIncrementLocalEstimate.mockReset();
        mockTriggerColdStartRefresh.mockReset();
        mockEnsureStarted.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        resetPipeline();
    });

    test('pipeline initializes QuotaSelectHook ahead of SessionIdHook', async () => {
        await pipeline.initialize();

        expect(pipeline.preHooks.map(hook => hook.name)).toEqual([
            'QuotaSelectHook',
            'ChainSetupHook',
            'SessionIdHook',
        ]);
    });

    test('ChainSetupHook initializes the pre-selected Antigravity account before request execution', async () => {
        const initialize = jest.fn().mockResolvedValue(undefined);
        mockGetServiceAdapter.mockReturnValue({
            antigravityApiService: {
                initialize,
            },
        });

        await pipeline.initialize();

        const hook = pipeline.preHooks.find(candidate => candidate.name === 'ChainSetupHook');
        expect(hook).toBeDefined();

        await hook.execute({
            provider: 'gemini-antigravity',
            preSelectedUuid: 'acct-b',
            options: {
                preSelectedUuid: 'acct-b',
            },
            config: {
                HOST: '127.0.0.1',
                providerPools: {
                    'gemini-antigravity': [
                        createAntigravityProvider(),
                        createAntigravityProvider({
                            uuid: 'acct-b',
                            PROXY_URL: 'http://proxy-b:8080',
                            ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-b@example.com',
                        }),
                    ],
                },
            },
        });

        expect(mockGetServiceAdapter).toHaveBeenCalledWith(expect.objectContaining({
            MODEL_PROVIDER: 'gemini-antigravity',
            uuid: 'acct-b',
            ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-b@example.com',
        }));
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    test('QuotaSelectHook pre-selects the account with the highest cached quota and decrements the local estimate', async () => {
        const hook = new QuotaSelectHook({
            scheduler: {
                triggerColdStartRefresh: mockTriggerColdStartRefresh,
                ensureStarted: mockEnsureStarted,
            },
            decrementAmount: 0.05,
        });

        mockGetQuota.mockImplementation((accountKey, modelName) => {
            if (modelName !== 'gemini-claude-opus-4-6-thinking') {
                return null;
            }

            if (accountKey === 'acct-a@example.com') {
                return { local_estimate: 0.40 };
            }

            if (accountKey === 'acct-b@example.com') {
                return { local_estimate: 0.85 };
            }

            return null;
        });

        const result = await hook.execute({
            provider: 'gemini-antigravity',
            model: 'gemini-claude-opus-4-6-thinking',
            config: {
                providerPools: {
                    'gemini-antigravity': [
                        createAntigravityProvider(),
                        createAntigravityProvider({
                            uuid: 'acct-b',
                            PROXY_URL: 'http://proxy-b:8080',
                            ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-b@example.com',
                        }),
                    ],
                },
            },
            options: {},
        });

        expect(result).toEqual({
            preSelectedUuid: 'acct-b',
            quotaReservation: {
                uuid: 'acct-b',
                accountKey: 'acct-b@example.com',
                model: 'gemini-claude-opus-4-6-thinking',
                amount: 0.05,
            },
            options: {
                preSelectedUuid: 'acct-b',
            },
        });
        expect(mockDecrementLocalEstimate).toHaveBeenCalledWith(
            'acct-b@example.com',
            'gemini-claude-opus-4-6-thinking',
            0.05
        );
        expect(mockEnsureStarted).toHaveBeenCalled();
        expect(mockTriggerColdStartRefresh).not.toHaveBeenCalled();
    });

    test('QuotaSelectHook falls back to normal selection and triggers async cold-start refresh when no quota cache exists', async () => {
        const hook = new QuotaSelectHook({
            scheduler: {
                triggerColdStartRefresh: mockTriggerColdStartRefresh,
                ensureStarted: mockEnsureStarted,
            },
        });
        mockGetQuota.mockReturnValue(null);

        const result = await hook.execute({
            provider: 'gemini-antigravity',
            model: 'gemini-claude-opus-4-6-thinking',
            config: {
                providerPools: {
                    'gemini-antigravity': [
                        createAntigravityProvider(),
                        createAntigravityProvider({
                            uuid: 'acct-b',
                            PROXY_URL: 'http://proxy-b:8080',
                            ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-b@example.com',
                        }),
                    ],
                },
            },
            options: {},
        });

        expect(result).toBeNull();
        expect(mockDecrementLocalEstimate).not.toHaveBeenCalled();
        expect(mockTriggerColdStartRefresh).toHaveBeenCalledWith(
            expect.objectContaining({
                providerPools: expect.any(Object),
            }),
            'gemini-antigravity'
        );
    });

    test('reconcileQuotaReservation restores the hinted account and debits the actual selected account when selection changes', () => {
        reconcileQuotaReservation(
            {
                uuid: 'acct-b',
                accountKey: 'acct-b@example.com',
                model: 'gemini-claude-opus-4-6-thinking',
                amount: 0.05,
            },
            {
                provider: 'gemini-antigravity',
                uuid: 'acct-a',
                accountKey: 'acct-a@example.com',
            }
        );

        expect(mockIncrementLocalEstimate).toHaveBeenCalledWith(
            'acct-b@example.com',
            'gemini-claude-opus-4-6-thinking',
            0.05
        );
        expect(mockDecrementLocalEstimate).toHaveBeenCalledWith(
            'acct-a@example.com',
            'gemini-claude-opus-4-6-thinking',
            0.05
        );
    });
});

describe('Antigravity Phase 4 quota scheduler', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-06T00:00:00.000Z'));
        mockGetServiceAdapter.mockReset();
        mockGetProviderPoolManager.mockReset();
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('QuotaScheduler refreshes accounts in 5-account batches with 1-second gaps', async () => {
        const scheduler = new QuotaScheduler();
        const usageCalls = [];

        mockGetServiceAdapter.mockImplementation((config) => ({
            antigravityApiService: {
                accountEmail: `${config.uuid}@example.com`,
                getUsageLimits: jest.fn(async () => {
                    usageCalls.push({
                        uuid: config.uuid,
                        at: Date.now(),
                    });
                    return {};
                }),
            },
        }));

        const refreshPromise = scheduler.refreshProviderPool({
            providerPools: {
                'gemini-antigravity': Array.from({ length: 6 }, (_unused, index) => ({
                    ...createAntigravityProvider({
                        uuid: `acct-${index + 1}`,
                        PROXY_URL: `http://proxy-${index + 1}:8080`,
                        ANTIGRAVITY_ACCOUNT_EMAIL: `acct-${index + 1}@example.com`,
                    }),
                })),
            },
        }, 'gemini-antigravity');

        await jest.advanceTimersByTimeAsync(0);
        expect(usageCalls).toHaveLength(5);

        await jest.advanceTimersByTimeAsync(999);
        expect(usageCalls).toHaveLength(5);

        await jest.advanceTimersByTimeAsync(1);
        await refreshPromise;

        expect(usageCalls).toHaveLength(6);
        expect(usageCalls[5]).toEqual({
            uuid: 'acct-6',
            at: Date.parse('2026-03-06T00:00:01.000Z'),
        });
    });

    test('QuotaScheduler uses the near-reset interval when any account is within two hours of reset', () => {
        const scheduler = new QuotaScheduler();

        const intervalMs = scheduler.getRefreshIntervalMs([
            {
                reset_time: '2026-03-06T01:30:00.000Z',
            },
        ]);

        expect(intervalMs).toBe(5 * 60 * 1000);
    });

    test('QuotaScheduler marks a node for refresh when quota retrieval fails', async () => {
        const scheduler = new QuotaScheduler();
        const config = {
            providerPools: {
                'gemini-antigravity': [
                    createAntigravityProvider(),
                ],
            },
        };

        mockGetServiceAdapter.mockReturnValue({
            antigravityApiService: {
                getUsageLimits: jest.fn().mockRejectedValue(new Error('quota refresh failed')),
            },
        });

        await scheduler.refreshProviderPool(config, 'gemini-antigravity');

        expect(config.providerPools['gemini-antigravity'][0]).toMatchObject({
            needsRefresh: true,
            lastErrorMessage: expect.stringContaining('quota refresh failed'),
        });
    });

    test('checkAndRefreshExpiringNodes only enqueues nodes whose adapter reports near-expiry credentials', async () => {
        const manager = new ProviderPoolManager({
            'gemini-antigravity': [
                createAntigravityProvider({
                    ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'package.json',
                }),
                createAntigravityProvider({
                    uuid: 'acct-b',
                    PROXY_URL: 'http://proxy-b:8080',
                    ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-b@example.com',
                    ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: 'package.json',
                }),
            ],
        }, { globalConfig: {} });
        manager._debouncedSave = jest.fn();

        mockGetServiceAdapter
            .mockReturnValueOnce({
                isExpiryDateNear: jest.fn(() => false),
            })
            .mockReturnValueOnce({
                isExpiryDateNear: jest.fn(() => true),
            });

        const enqueueSpy = jest.spyOn(manager, '_enqueueRefresh').mockImplementation(() => {});

        await manager.checkAndRefreshExpiringNodes();

        expect(enqueueSpy).toHaveBeenCalledTimes(1);
        expect(enqueueSpy).toHaveBeenCalledWith(
            'gemini-antigravity',
            expect.objectContaining({
                uuid: 'acct-b',
            })
        );
    });
});

describe('Antigravity Phase 4 reactive refresh', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Antigravity 429 responses trigger immediate quota refresh scheduling', async () => {
        const service = new AntigravityApiService(createServiceConfig({
            providerPools: {
                'gemini-antigravity': [createAntigravityProvider()],
            },
        }));
        service.baseURLs = ['https://antigravity.test'];

        const refreshSpy = jest.spyOn(quotaScheduler, 'triggerImmediateRefresh').mockResolvedValue(undefined);
        service.authClient.request = jest.fn().mockRejectedValue({
            response: { status: 429 },
            message: 'rate limit',
        });

        await expect(service.callApi('fetchAvailableModels', { project: 'project-123' })).rejects.toMatchObject({
            response: { status: 429 },
        });

        expect(refreshSpy).toHaveBeenCalledWith(service.config, 'gemini-antigravity');
    });

    test('getUsageLimits rejects when every upstream quota endpoint fails', async () => {
        const service = new AntigravityApiService(createServiceConfig());
        service.isInitialized = true;
        service.projectId = 'project-123';
        service.baseURLs = ['https://antigravity-a.test', 'https://antigravity-b.test'];
        service.authClient.request = jest.fn().mockRejectedValue(new Error('upstream down'));

        await expect(service.getUsageLimits()).rejects.toThrow('upstream down');
    });
});
