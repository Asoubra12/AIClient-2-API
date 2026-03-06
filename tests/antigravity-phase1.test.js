import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

const mockPluginManager = {
    executeProviderPreHooks: jest.fn(),
    executeHook: jest.fn(),
    executeProviderPostHooks: jest.fn(),
};

const mockGetApiServiceWithFallback = jest.fn();
const mockDecrementLocalEstimate = jest.fn();
const mockIncrementLocalEstimate = jest.fn();
const mockConvertData = jest.fn((payload, _mode, fromProvider, toProvider) => ({
    ...payload,
    _convertedFrom: fromProvider,
    _convertedTo: toProvider,
    contents: payload.contents ?? [{ role: 'user', parts: [{ text: 'converted' }] }],
}));

jest.mock('../src/providers/adapter.js', () => ({
    __esModule: true,
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
}));

jest.mock('../src/core/plugin-manager.js', () => ({
    __esModule: true,
    getPluginManager: jest.fn(() => mockPluginManager),
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getApiServiceWithFallback: jest.fn((...args) => mockGetApiServiceWithFallback(...args)),
}));

jest.mock('../src/convert/convert.js', () => ({
    __esModule: true,
    convertData: (...args) => mockConvertData(...args),
}));

jest.mock('../src/db/quota-store.js', () => ({
    __esModule: true,
    decrementLocalEstimate: (...args) => mockDecrementLocalEstimate(...args),
    incrementLocalEstimate: (...args) => mockIncrementLocalEstimate(...args),
}));

import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { ENDPOINT_TYPE, handleContentGenerationRequest } from '../src/utils/common.js';

function createRequest(url, body) {
    const req = new EventEmitter();
    req.url = url;
    req.headers = { host: 'localhost' };

    process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });

    return req;
}

function createResponse() {
    return {
        writableEnded: false,
        writeHead: jest.fn(),
        write: jest.fn(),
        end: jest.fn(function end(payload) {
            this.writableEnded = true;
            this.payload = payload;
        }),
        on: jest.fn(),
        off: jest.fn(),
    };
}

function createConfig(overrides = {}) {
    return {
        MODEL_PROVIDER: 'gemini-antigravity',
        PROMPT_LOG_MODE: 'none',
        CREDENTIAL_SWITCH_MAX_RETRIES: 1,
        ...overrides,
    };
}

function createProviderPoolManager() {
    return {
        markProviderHealthy: jest.fn(),
        releaseSlot: jest.fn(),
    };
}

function createAntigravityProvider(overrides = {}) {
    return {
        uuid: 'acct-a',
        IPOASIS_SUBUSER_ID: 1865,
        PROXY_URL: 'http://proxy-a:8080',
        RUNTIME_PROXY_URL_SOURCE: 'ipoasis',
        isHealthy: true,
        isDisabled: false,
        needsRefresh: false,
        usageCount: 0,
        lastUsed: '2026-03-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('Antigravity Phase 1 selection plumbing', () => {
    test('selectProvider honors options.preSelectedUuid when the hinted provider is healthy', async () => {
        const manager = new ProviderPoolManager({
            'gemini-antigravity': [
                createAntigravityProvider(),
                createAntigravityProvider({
                    uuid: 'acct-b',
                    PROXY_URL: 'http://proxy-b:8080',
                    lastUsed: '2026-03-02T00:00:00.000Z',
                }),
            ],
        }, { globalConfig: {} });
        manager._debouncedSave = jest.fn();

        const selected = await manager.selectProvider(
            'gemini-antigravity',
            'claude-opus-4-6-thinking',
            { preSelectedUuid: 'acct-b' }
        );

        expect(selected.uuid).toBe('acct-b');
    });

    test('acquireSlotWithFallback preserves options.preSelectedUuid through the slot-acquisition path', async () => {
        const manager = new ProviderPoolManager({
            'gemini-antigravity': [
                createAntigravityProvider(),
                createAntigravityProvider({
                    uuid: 'acct-b',
                    PROXY_URL: 'http://proxy-b:8080',
                    lastUsed: '2026-03-02T00:00:00.000Z',
                }),
            ],
        }, { globalConfig: {} });
        manager._debouncedSave = jest.fn();

        const selected = await manager.acquireSlotWithFallback(
            'gemini-antigravity',
            'claude-opus-4-6-thinking',
            { preSelectedUuid: 'acct-b' }
        );

        expect(selected.config.uuid).toBe('acct-b');
    });

    test('queued requests reselect a healthy provider if the original queued node turns unhealthy before wakeup', async () => {
        const manager = new ProviderPoolManager({
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
                    queueLimit: 1,
                },
                {
                    uuid: 'acct-b',
                    OPENAI_BASE_URL: 'https://api-b.example.com',
                    isHealthy: true,
                    isDisabled: false,
                    needsRefresh: false,
                    usageCount: 0,
                    lastUsed: '2026-03-02T00:00:00.000Z',
                    concurrencyLimit: 1,
                    queueLimit: 0,
                },
            ],
        }, { globalConfig: {} });
        manager._debouncedSave = jest.fn();

        const firstSlot = await manager.acquireSlot('openai-custom', 'gpt-4o-mini', {
            preSelectedUuid: 'acct-a',
        });
        expect(firstSlot.uuid).toBe('acct-a');

        const queuedSlotPromise = manager.acquireSlot('openai-custom', 'gpt-4o-mini', {
            preSelectedUuid: 'acct-a',
            queueTimeout: 100,
        });

        await Promise.resolve();
        manager.markProviderUnhealthyImmediately('openai-custom', { uuid: 'acct-a' }, 'boom');
        manager.releaseSlot('openai-custom', 'acct-a');

        await expect(queuedSlotPromise).resolves.toMatchObject({
            uuid: 'acct-b',
        });
    });
});

describe('handleContentGenerationRequest Antigravity hooks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPluginManager.executeProviderPreHooks.mockResolvedValue({});
        mockPluginManager.executeHook.mockResolvedValue(undefined);
        mockPluginManager.executeProviderPostHooks.mockReturnValue(undefined);
        mockGetApiServiceWithFallback.mockReset();
        mockDecrementLocalEstimate.mockReset();
        mockIncrementLocalEstimate.mockReset();
        mockConvertData.mockClear();
    });

    test('runs provider pre-hooks before service selection and does not mutate shared config for preselection', async () => {
        const callOrder = [];
        let receivedOptions = null;
        const config = createConfig({
            providerPools: {
                'gemini-antigravity': [{ uuid: 'pool-placeholder' }],
            },
        });
        const providerPoolManager = createProviderPoolManager();
        const service = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: { parts: [{ text: 'ok' }] },
                    },
                ],
            }),
        };

        mockPluginManager.executeProviderPreHooks.mockImplementation(async () => {
            callOrder.push('pre');
            return {
                preSelectedUuid: 'acct-b',
                sessionId: 'session-1',
            };
        });

        mockGetApiServiceWithFallback.mockImplementation(async (_cfg, _model, options) => {
            callOrder.push('service');
            receivedOptions = options;
            return {
                service,
                serviceConfig: { customName: null },
                actualProviderType: 'gemini-antigravity',
                isFallback: false,
                uuid: 'acct-b',
                actualModel: null,
            };
        });

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:generateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            createResponse(),
            null,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            providerPoolManager,
            null
        );

        expect(callOrder.slice(0, 2)).toEqual(['pre', 'service']);
        expect(receivedOptions).toMatchObject({
            acquireSlot: true,
            preSelectedUuid: 'acct-b',
        });
        expect(config._preSelectedUuid).toBeUndefined();
    });

    test('passes response metadata into onContentGenerated hooks', async () => {
        const config = createConfig();
        const response = createResponse();
        const service = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: { parts: [{ text: 'ok' }] },
                    },
                ],
                usageMetadata: {
                    candidatesTokenCount: 7,
                    thoughtsTokenCount: 3,
                },
            }),
        };

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:generateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            response,
            service,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            null,
            null
        );

        expect(mockPluginManager.executeHook).toHaveBeenCalledWith(
            'onContentGenerated',
            expect.objectContaining({
                latencyMs: expect.any(Number),
                finishReason: 'STOP',
                responseTokenCount: 7,
                thinkingTokenCount: 3,
            })
        );
    });

    test('falls back to the request-scoped correlation id when upstream metadata does not provide one', async () => {
        const config = createConfig({
            _requestId: 'proxy-request-123',
        });
        const response = createResponse();
        const service = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: { parts: [{ text: 'ok' }] },
                    },
                ],
            }),
        };

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:generateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            response,
            service,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            null,
            null
        );

        expect(mockPluginManager.executeProviderPostHooks).toHaveBeenCalledWith(
            expect.objectContaining({
                requestId: 'proxy-request-123',
            })
        );
    });

    test('reconciles quota debit when the actual selected account differs from the pre-selected quota hint', async () => {
        const config = createConfig({
            providerPools: {
                'gemini-antigravity': [{ uuid: 'pool-placeholder' }],
            },
        });
        const providerPoolManager = createProviderPoolManager();
        const service = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: { parts: [{ text: 'ok' }] },
                    },
                ],
            }),
        };

        mockPluginManager.executeProviderPreHooks.mockResolvedValue({
            preSelectedUuid: 'acct-b',
            quotaReservation: {
                uuid: 'acct-b',
                accountKey: 'acct-b@example.com',
                model: 'claude-opus-4-6-thinking',
                amount: 0.05,
            },
        });

        mockGetApiServiceWithFallback.mockResolvedValue({
            service,
            serviceConfig: {
                customName: null,
                ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-a@example.com',
            },
            actualProviderType: 'gemini-antigravity',
            isFallback: false,
            uuid: 'acct-a',
            actualModel: null,
        });

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:generateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            createResponse(),
            null,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            providerPoolManager,
            null
        );

        expect(mockIncrementLocalEstimate).toHaveBeenCalledWith(
            'acct-b@example.com',
            'claude-opus-4-6-thinking',
            0.05
        );
        expect(mockDecrementLocalEstimate).toHaveBeenCalledWith(
            'acct-a@example.com',
            'claude-opus-4-6-thinking',
            0.05
        );
    });

    test('rebuilds the request body when a credential-switch retry falls back to a different provider protocol', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);

        const config = createConfig({
            MODEL_PROVIDER: 'openai-custom',
        });
        const providerPoolManager = createProviderPoolManager();
        const firstService = {
            generateContent: jest.fn().mockRejectedValue({
                message: 'switch providers',
                shouldSwitchCredential: true,
                skipErrorCount: true,
            }),
        };
        const secondService = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: { parts: [{ text: 'ok' }] },
                    },
                ],
            }),
        };

        mockGetApiServiceWithFallback
            .mockResolvedValueOnce({
                service: firstService,
                serviceConfig: { customName: null },
                actualProviderType: 'openai-custom',
                isFallback: false,
                uuid: 'acct-a',
                actualModel: null,
            })
            .mockResolvedValueOnce({
                service: secondService,
                serviceConfig: { customName: null },
                actualProviderType: 'gemini-antigravity',
                isFallback: true,
                uuid: 'acct-b',
                actualModel: 'gemini-2.5-pro',
            });

        await handleContentGenerationRequest(
            createRequest('/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'hello' }],
            }),
            createResponse(),
            null,
            ENDPOINT_TYPE.OPENAI_CHAT,
            config,
            'prompt.log',
            providerPoolManager,
            null
        );

        expect(secondService.generateContent).toHaveBeenCalledTimes(1);
        expect(secondService.generateContent.mock.calls[0][0]).toBe('gemini-2.5-pro');
        expect(secondService.generateContent.mock.calls[0][1]).not.toBe(
            firstService.generateContent.mock.calls[0][1]
        );
        expect(secondService.generateContent.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                model: 'gemini-2.5-pro',
            })
        );
    });

    test('reconciles quota reservation again when a retry switches to a different Antigravity credential', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);

        const config = createConfig({
            providerPools: {
                'gemini-antigravity': [{ uuid: 'pool-placeholder' }],
            },
        });
        const providerPoolManager = createProviderPoolManager();
        const firstService = {
            generateContent: jest.fn().mockRejectedValue({
                message: 'switch account',
                shouldSwitchCredential: true,
                skipErrorCount: true,
            }),
        };
        const secondService = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [
                    {
                        finishReason: 'STOP',
                        content: { parts: [{ text: 'ok' }] },
                    },
                ],
            }),
        };

        mockPluginManager.executeProviderPreHooks.mockResolvedValue({
            quotaReservation: {
                uuid: 'acct-a',
                accountKey: 'acct-a@example.com',
                model: 'claude-opus-4-6-thinking',
                amount: 0.05,
            },
        });

        mockGetApiServiceWithFallback
            .mockResolvedValueOnce({
                service: firstService,
                serviceConfig: {
                    customName: null,
                    ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-a@example.com',
                },
                actualProviderType: 'gemini-antigravity',
                isFallback: false,
                uuid: 'acct-a',
                actualModel: null,
            })
            .mockResolvedValueOnce({
                service: secondService,
                serviceConfig: {
                    customName: null,
                    ANTIGRAVITY_ACCOUNT_EMAIL: 'acct-b@example.com',
                },
                actualProviderType: 'gemini-antigravity',
                isFallback: false,
                uuid: 'acct-b',
                actualModel: null,
            });

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:generateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            createResponse(),
            null,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            providerPoolManager,
            null
        );

        expect(mockIncrementLocalEstimate).toHaveBeenCalledWith(
            'acct-a@example.com',
            'claude-opus-4-6-thinking',
            0.05
        );
        expect(mockDecrementLocalEstimate).toHaveBeenCalledWith(
            'acct-b@example.com',
            'claude-opus-4-6-thinking',
            0.05
        );
    });

    test('passes stream response metadata into onContentGenerated hooks', async () => {
        const config = createConfig();
        const response = createResponse();
        const service = {
            generateContentStream: jest.fn().mockImplementation(async function* generateContentStream() {
                yield {
                    candidates: [
                        {
                            content: { parts: [{ text: 'partial' }] },
                        },
                    ],
                };
                yield {
                    candidates: [
                        {
                            finishReason: 'STOP',
                        },
                    ],
                    usageMetadata: {
                        candidatesTokenCount: 5,
                        thoughtsTokenCount: 2,
                    },
                };
            }),
        };

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:streamGenerateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            response,
            service,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            null,
            null
        );

        expect(mockPluginManager.executeHook).toHaveBeenCalledWith(
            'onContentGenerated',
            expect.objectContaining({
                isStream: true,
                latencyMs: expect.any(Number),
                finishReason: 'STOP',
                responseTokenCount: 5,
                thinkingTokenCount: 2,
            })
        );
    });

    test('runs provider post-hooks for unary generation failures with failure metadata', async () => {
        const config = createConfig();
        const response = createResponse();
        const service = {
            generateContent: jest.fn().mockRejectedValue({
                message: 'unauthorized',
                response: {
                    status: 401,
                },
            }),
        };

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:generateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            response,
            service,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            null,
            null
        );

        expect(mockPluginManager.executeProviderPostHooks).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'gemini-antigravity',
                error: expect.objectContaining({
                    message: 'unauthorized',
                    response: expect.objectContaining({
                        status: 401,
                    }),
                }),
            })
        );
    });

    test('runs provider post-hooks for stream generation failures with failure metadata', async () => {
        const config = createConfig();
        const response = createResponse();
        const service = {
            generateContentStream: jest.fn().mockImplementation(async function* generateContentStream() {
                throw {
                    message: 'stream failed',
                    response: {
                        status: 429,
                    },
                };
            }),
        };

        await handleContentGenerationRequest(
            createRequest('/v1beta/models/claude-opus-4-6-thinking:streamGenerateContent', {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            }),
            response,
            service,
            ENDPOINT_TYPE.GEMINI_CONTENT,
            config,
            'prompt.log',
            null,
            null
        );

        expect(mockPluginManager.executeProviderPostHooks).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'gemini-antigravity',
                error: expect.objectContaining({
                    message: 'stream failed',
                    response: expect.objectContaining({
                        status: 429,
                    }),
                }),
            })
        );
    });
});
