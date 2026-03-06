import { jest } from '@jest/globals';

const mockUpsertQuota = jest.fn();

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn(),
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    __esModule: true,
    handleGeminiAntigravityOAuth: jest.fn(),
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: jest.fn(() => null),
}));

jest.mock('../src/db/quota-store.js', () => ({
    __esModule: true,
    upsertQuota: (...args) => mockUpsertQuota(...args),
}));

import { PluginManager } from '../src/core/plugin-manager.js';
import { AntigravityHook } from '../src/middleware/antigravity/hook-base.js';
import pipeline, { ANTIGRAVITY_PROVIDER } from '../src/middleware/antigravity/index.js';
import { AntigravityApiService, toGeminiApiResponse } from '../src/providers/gemini/antigravity-core.js';

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
        ...overrides,
    };
}

class PriorityHook extends AntigravityHook {
    constructor(name, priority, calls) {
        super();
        this._name = name;
        this._priority = priority;
        this.calls = calls;
    }

    get name() { return this._name; }
    get type() { return 'pre'; }
    get priority() { return this._priority; }

    async execute() {
        this.calls.push(this.name);
        return null;
    }
}

describe('Antigravity Phase 2 pipeline', () => {
    beforeEach(() => {
        resetPipeline();
    });

    afterEach(() => {
        resetPipeline();
        jest.restoreAllMocks();
    });

    test('plugin manager initializes the Antigravity pipeline during startup', async () => {
        const manager = new PluginManager();
        manager.loadConfig = jest.fn().mockResolvedValue(undefined);
        manager.pluginsConfig = { plugins: {} };

        await manager.initAll({});

        expect(manager._antigravityPipeline).toBe(pipeline);
        expect(pipeline._initialized).toBe(true);
        expect(pipeline.preHooks.map(hook => hook.name)).toContain('SessionIdHook');
    });

    test('pre-hooks execute in ascending priority order', async () => {
        const calls = [];

        pipeline.register(new PriorityHook('late', 50, calls));
        pipeline.register(new PriorityHook('early', 10, calls));

        await pipeline.runPreHooks({
            provider: ANTIGRAVITY_PROVIDER,
            requestBody: { request: { contents: [] } },
        });

        expect(calls).toEqual(['early', 'late']);
    });

    test('same conversation produces the same sessionId across requests', async () => {
        await pipeline.initialize();

        const requestBody = {
            request: {
                contents: [
                    { role: 'user', parts: [{ text: 'repeatable prompt' }] },
                ],
            },
        };

        const first = await pipeline.runPreHooks({
            provider: ANTIGRAVITY_PROVIDER,
            requestBody,
        });
        const second = await pipeline.runPreHooks({
            provider: ANTIGRAVITY_PROVIDER,
            requestBody,
        });

        expect(first.sessionId).toBe(second.sessionId);
        expect(first.sessionId).toMatch(/^-\d+$/);
    });

    test('session-id hook is skipped for non-Antigravity providers', async () => {
        await pipeline.initialize();

        const result = await pipeline.runPreHooks({
            provider: 'openai-custom',
            requestBody: {
                request: {
                    contents: [
                        { role: 'user', parts: [{ text: 'ignored prompt' }] },
                    ],
                },
            },
        });

        expect(result.sessionId).toBeUndefined();
    });
});

describe('Antigravity Phase 3 init chain', () => {
    afterEach(() => {
        mockUpsertQuota.mockReset();
        jest.restoreAllMocks();
    });

    test('initialize uses a per-account mutex so concurrent calls share one in-flight init', async () => {
        const service = new AntigravityApiService(createServiceConfig());
        const loadGate = {};
        loadGate.promise = new Promise(resolve => {
            loadGate.resolve = resolve;
        });
        const discoverGate = {};
        discoverGate.promise = new Promise(resolve => {
            discoverGate.resolve = resolve;
        });

        service.loadCredentials = jest.fn().mockImplementation(() => loadGate.promise);
        service.discoverProjectAndModels = jest.fn().mockImplementation(() => discoverGate.promise);

        const firstInitialize = service.initialize();
        const secondInitialize = service.initialize();

        expect(service.loadCredentials).toHaveBeenCalledTimes(1);
        expect(service.discoverProjectAndModels).not.toHaveBeenCalled();

        loadGate.resolve();
        await Promise.resolve();

        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(1);

        discoverGate.resolve('project-123');
        await Promise.all([firstInitialize, secondInitialize]);

        expect(service.projectId).toBe('project-123');
        expect(service.isInitialized).toBe(true);
    });

    test('toGeminiApiResponse preserves upstream request correlation fields', () => {
        const response = toGeminiApiResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            traceId: '0123456789abcdef',
            usageMetadata: {
                candidatesTokenCount: 7,
            },
        });

        expect(response).toEqual(expect.objectContaining({
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            traceId: '0123456789abcdef',
            usageMetadata: {
                candidatesTokenCount: 7,
            },
        }));
    });

    test('discoverProjectAndModels runs the real bootstrap chain before model/admin fan-out', async () => {
        const service = new AntigravityApiService(createServiceConfig());
        service.baseURLs = ['https://antigravity.test'];

        const requestSequence = [];
        service.authClient.request = jest.fn(async (requestOptions) => {
            requestSequence.push({
                url: requestOptions.url,
                method: requestOptions.method,
                body: requestOptions.body,
            });

            if (requestOptions.url.endsWith('/v1internal/cascadeNuxes')) {
                return { data: {} };
            }

            if (requestOptions.url.endsWith('/v1internal:fetchUserInfo')) {
                return { data: {} };
            }

            if (requestOptions.url.endsWith('/v1internal:loadCodeAssist')) {
                const parsedBody = JSON.parse(requestOptions.body);

                if (!parsedBody.cloudaicompanionProject) {
                    return {
                        data: {
                            cloudaicompanionProject: 'project-123',
                        },
                    };
                }

                return {
                    data: {
                        cloudaicompanionProject: 'project-123',
                    },
                };
            }

            throw new Error(`Unexpected request: ${requestOptions.url}`);
        });
        service.fetchAvailableModels = jest.fn(async () => {
            requestSequence.push({ name: 'fetchAvailableModels' });
        });
        service.fetchAdminControls = jest.fn(async () => {
            requestSequence.push({ name: 'fetchAdminControls' });
        });

        const projectId = await service.discoverProjectAndModels();

        expect(projectId).toBe('project-123');
        expect(requestSequence).toEqual([
            {
                url: 'https://antigravity.test/v1internal/cascadeNuxes',
                method: 'GET',
                body: undefined,
            },
            {
                url: 'https://antigravity.test/v1internal:fetchUserInfo',
                method: 'POST',
                body: JSON.stringify({}),
            },
            {
                url: 'https://antigravity.test/v1internal:loadCodeAssist',
                method: 'POST',
                body: JSON.stringify({
                    metadata: {
                        ideType: 'ANTIGRAVITY',
                    },
                }),
            },
            {
                url: 'https://antigravity.test/v1internal:loadCodeAssist',
                method: 'POST',
                body: JSON.stringify({
                    cloudaicompanionProject: 'project-123',
                    metadata: {
                        ideType: 'ANTIGRAVITY',
                    },
                }),
            },
            { name: 'fetchAvailableModels' },
            { name: 'fetchAdminControls' },
        ]);
        expect(service.fetchAvailableModels).toHaveBeenCalledTimes(1);
        expect(service.fetchAdminControls).toHaveBeenCalledTimes(1);
    });

    test('fetchAvailableModels sends the discovered project in the request body', async () => {
        const service = new AntigravityApiService(createServiceConfig({ PROJECT_ID: 'project-123' }));
        service.baseURLs = ['https://antigravity.test'];
        service.projectId = 'project-123';
        service.authClient.request = jest.fn().mockResolvedValue({
            data: {
                models: {
                    'gemini-3-pro-high': {},
                },
            },
        });

        await service.fetchAvailableModels();

        expect(service.authClient.request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://antigravity.test/v1internal:fetchAvailableModels',
            method: 'POST',
            body: JSON.stringify({ project: 'project-123' }),
        }));
    });

    test('initialization persists fetched quota data into SQLite for the account', async () => {
        const service = new AntigravityApiService(createServiceConfig());
        service.baseURLs = ['https://antigravity.test'];
        service.authClient.request = jest.fn(async (requestOptions) => {
            if (requestOptions.url.endsWith('/v1internal/cascadeNuxes')) {
                return { data: {} };
            }

            if (requestOptions.url.endsWith('/v1internal:fetchUserInfo')) {
                return {
                    data: {
                        email: 'acct@example.com',
                    },
                };
            }

            if (requestOptions.url.endsWith('/v1internal:loadCodeAssist')) {
                return {
                    data: {
                        cloudaicompanionProject: 'project-123',
                    },
                };
            }

            if (requestOptions.url.endsWith('/v1internal:fetchAvailableModels')) {
                return {
                    data: {
                        models: {
                            'claude-opus-4-6-thinking': {
                                quotaInfo: {
                                    remainingFraction: 0.42,
                                    resetTime: '2026-03-07T00:00:00.000Z',
                                },
                            },
                        },
                    },
                };
            }

            if (requestOptions.url.endsWith('/v1internal:fetchAdminControls')) {
                return { data: {} };
            }

            throw new Error(`Unexpected request: ${requestOptions.url}`);
        });

        await service.initialize();

        expect(mockUpsertQuota).toHaveBeenCalledWith(
            'acct@example.com',
            'gemini-claude-opus-4-6-thinking',
            0.42,
            '2026-03-07T00:00:00.000Z'
        );
    });
});
