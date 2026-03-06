import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { jest } from '@jest/globals';

const mockGetFingerprint = jest.fn();
const mockSaveFingerprint = jest.fn();
const mockUuid = jest.fn();

jest.mock('../src/db/fingerprint-store.js', () => ({
    __esModule: true,
    getFingerprint: (...args) => mockGetFingerprint(...args),
    saveFingerprint: (...args) => mockSaveFingerprint(...args),
}));

jest.mock('uuid', () => ({
    __esModule: true,
    v4: (...args) => mockUuid(...args),
}));

import pipeline from '../src/middleware/antigravity/index.js';
import { FingerprintManager } from '../src/middleware/antigravity/fingerprint.js';
import { MetricsHook } from '../src/middleware/antigravity/metrics-post.js';
import { TrajectoryHook } from '../src/middleware/antigravity/trajectory-post.js';

function resetPipeline() {
    pipeline.preHooks = [];
    pipeline.postHooks = [];
    pipeline._initialized = false;
}

function flushMicrotasks() {
    return Promise.resolve().then(() => Promise.resolve());
}

describe('Antigravity Phase 5 fingerprinting', () => {
    beforeEach(() => {
        resetPipeline();
        mockGetFingerprint.mockReset();
        mockSaveFingerprint.mockReset();
        mockUuid.mockReset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        resetPipeline();
    });

    test('pipeline initializes MetricsHook and TrajectoryHook post-hooks', async () => {
        await pipeline.initialize();

        expect(pipeline.postHooks.map(hook => hook.name)).toEqual([
            'MetricsHook',
            'TrajectoryHook',
        ]);
    });

    test('FingerprintManager generates and persists a stable Windows fingerprint on first use', () => {
        mockGetFingerprint.mockReturnValueOnce(null).mockReturnValueOnce({
            deviceFingerprint: 'existing-fingerprint',
            extensionName: 'antigravity',
        });
        mockUuid.mockReturnValue('device-fingerprint-uuid');

        const manager = new FingerprintManager({
            createUuid: () => mockUuid(),
            random: () => 0.1,
            ideVersion: '1.19.6',
        });

        const first = manager.getOrCreateFingerprint('alice@example.com');
        const second = manager.getOrCreateFingerprint('alice@example.com');

        expect(first).toEqual({
            deviceFingerprint: 'device-fingerprint-uuid',
            extensionName: 'antigravity',
            extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
            hardware: 'amd64',
            ideName: 'antigravity',
            ideVersion: '1.19.6',
            locale: 'en',
            os: 'windows',
            regionCode: 'US',
            userTierId: 'free-tier',
        });
        expect(second).toEqual({
            deviceFingerprint: 'existing-fingerprint',
            extensionName: 'antigravity',
        });
        expect(mockSaveFingerprint).toHaveBeenCalledWith('alice@example.com', first);
    });
});

describe('Antigravity Phase 6 metrics post-hook', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-06T00:00:00.000Z'));
        mockGetFingerprint.mockReset();
        mockSaveFingerprint.mockReset();
        mockUuid.mockReset();
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('MetricsHook schedules non-blocking metrics telemetry with platform-aligned payload fields', async () => {
        const callApi = jest.fn().mockResolvedValue({});
        const telemetryLogStore = {
            scheduleCleanup: jest.fn(),
            ensureRequestLog: jest.fn(),
            markMetricsSent: jest.fn(),
        };
        const hook = new MetricsHook({
            fingerprintManager: {
                getOrCreateFingerprint: jest.fn().mockReturnValue({
                    deviceFingerprint: 'fp-123',
                    os: 'windows',
                    hardware: 'amd64',
                    ideVersion: '1.19.6',
                }),
            },
            delayMs: () => 10,
            createUuid: () => 'metrics-request-uuid',
            createTraceId: () => '0123456789abcdef',
            now: () => new Date('2026-03-06T00:00:00.000Z'),
            telemetryLogStore,
        });

        const context = {
            service: {
                antigravityApiService: {
                    projectId: 'project-123',
                    callApi,
                },
            },
            provider: 'gemini-antigravity',
            accountEmail: 'acct@example.com',
            model: 'gemini-claude-opus-4-6-thinking',
            requestBody: {
                requestType: 'agent',
                _middlewareSessionId: '-123',
            },
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            firstTokenLatencyMs: 1234,
            latencyMs: 2345,
        };

        await hook.execute(context);

        await jest.advanceTimersByTimeAsync(9);
        expect(callApi).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(telemetryLogStore.scheduleCleanup).toHaveBeenCalledTimes(1);
        expect(telemetryLogStore.ensureRequestLog).toHaveBeenCalledWith(
            expect.objectContaining({
                accountEmail: 'acct@example.com',
                requestId: 'agent/1772754457436/trajectory-uuid/4',
                model: 'gemini-claude-opus-4-6-thinking',
            })
        );
        expect(telemetryLogStore.markMetricsSent).toHaveBeenCalledWith(
            expect.objectContaining({
                accountEmail: 'acct@example.com',
                requestId: 'agent/1772754457436/trajectory-uuid/4',
                model: 'gemini-claude-opus-4-6-thinking',
            })
        );
        expect(callApi).toHaveBeenCalledWith(
            'recordCodeAssistMetrics',
            expect.objectContaining({
                project: 'project-123',
                requestId: 'metrics-request-uuid',
                metadata: expect.objectContaining({
                    ideType: 'ANTIGRAVITY',
                    ideVersion: '1.19.6',
                    platform: 'WINDOWS_AMD64',
                }),
                metrics: [
                    expect.objectContaining({
                        conversationOffered: expect.objectContaining({
                            traceId: '0123456789abcdef',
                            isAgentic: true,
                            initiationMethod: 'AGENT',
                            trajectoryId: 'trajectory-uuid',
                            streamingLatency: {
                                firstMessageLatency: '1.234000000s',
                                totalLatency: '2.345000000s',
                            },
                        }),
                    }),
                ],
            })
        );
    });
});

describe('Antigravity Phase 6 trajectory post-hook', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-06T00:00:00.000Z'));
        mockGetFingerprint.mockReset();
        mockSaveFingerprint.mockReset();
        mockUuid.mockReset();
    });

    afterEach(async () => {
        await jest.runOnlyPendingTimersAsync();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('TrajectoryHook schedules redacted telemetry payloads with captured structural constants', async () => {
        const callApi = jest.fn().mockResolvedValue({});
        const telemetryLogStore = {
            scheduleCleanup: jest.fn(),
            ensureRequestLog: jest.fn(),
            markTrajectorySent: jest.fn(),
        };
        const hook = new TrajectoryHook({
            fingerprintManager: {
                getOrCreateFingerprint: jest.fn().mockReturnValue({
                    deviceFingerprint: 'fp-123',
                    extensionName: 'antigravity',
                    extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
                    hardware: 'amd64',
                    ideName: 'antigravity',
                    ideVersion: '1.19.6',
                    locale: 'en',
                    os: 'windows',
                    regionCode: 'US',
                    userTierId: 'free-tier',
                }),
            },
            delayMs: () => 50,
            createUuid: () => 'generated-uuid',
            now: () => new Date('2026-03-06T00:00:00.000Z'),
            telemetryLogStore,
        });

        await hook.execute({
            service: {
                antigravityApiService: {
                    projectId: 'project-123',
                    callApi,
                },
            },
            accountEmail: 'acct@example.com',
            model: 'gemini-claude-opus-4-6-thinking',
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            requestBody: {
                _middlewareSessionId: '-3750763034362895579',
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: 'Use sk-secret-key on http://127.0.0.1/internal and email me at user@example.com' }],
                    },
                ],
            },
            responseTokenCount: 56,
            thinkingTokenCount: 144,
            firstTokenLatencyMs: 1800,
            streamingDuration: 2600,
        });

        await jest.advanceTimersByTimeAsync(49);
        expect(callApi).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        const payload = callApi.mock.calls[0][1];
        const requestPrompt = payload.trajectory.generatorMetadata[0].chatModel.messagePrompts.find(prompt => prompt.safeForCodeTelemetry);
        expect(telemetryLogStore.scheduleCleanup).toHaveBeenCalledTimes(1);
        expect(telemetryLogStore.ensureRequestLog).toHaveBeenCalledWith(
            expect.objectContaining({
                accountEmail: 'acct@example.com',
                requestId: 'agent/1772754457436/trajectory-uuid/4',
                model: 'gemini-claude-opus-4-6-thinking',
            })
        );
        expect(telemetryLogStore.markTrajectorySent).toHaveBeenCalledWith(
            expect.objectContaining({
                accountEmail: 'acct@example.com',
                requestId: 'agent/1772754457436/trajectory-uuid/4',
                model: 'gemini-claude-opus-4-6-thinking',
            })
        );
        expect(callApi).toHaveBeenCalledWith('recordTrajectoryAnalytics', expect.any(Object));
        expect(payload).toEqual(expect.objectContaining({
            metadata: expect.objectContaining({
                deviceFingerprint: 'fp-123',
                extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
            }),
            trajectory: expect.objectContaining({
                trajectoryId: 'trajectory-uuid',
                trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
                source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
            }),
        }));
        expect(payload.trajectory.generatorMetadata[0].chatModel.model).toBe('MODEL_PLACEHOLDER_M26');
        expect(payload.trajectory.generatorMetadata[0].chatModel.responseModel).toBe('gemini-claude-opus-4-6-thinking');
        expect(requestPrompt.prompt).toMatch(/\[REDACTED: \d+ tokens\]/);
        expect(payload.trajectory.steps[0].userInput.userResponse).toMatch(/^\[REDACTED: \d+ tokens\]$/);
    });

    test('TrajectoryHook uses the captured A.10 scaffolding instead of stubbed prompt sections, tools, and planner config', async () => {
        const callApi = jest.fn().mockResolvedValue({});
        const hook = new TrajectoryHook({
            fingerprintManager: {
                getOrCreateFingerprint: jest.fn().mockReturnValue({
                    deviceFingerprint: 'fp-123',
                    extensionName: 'antigravity',
                    extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
                    hardware: 'amd64',
                    ideName: 'antigravity',
                    ideVersion: '1.19.6',
                    locale: 'en',
                    os: 'windows',
                    regionCode: 'US',
                    userTierId: 'free-tier',
                }),
            },
            delayMs: () => 0,
            createUuid: () => 'generated-uuid',
            now: () => new Date('2026-03-06T00:00:00.000Z'),
        });

        await hook.execute({
            service: {
                antigravityApiService: {
                    projectId: 'project-123',
                    callApi,
                },
            },
            accountEmail: 'acct@example.com',
            model: 'claude-opus-4-6-thinking',
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            traceId: '0123456789abcdef',
            requestBody: {
                requestType: 'agent',
                _middlewareSessionId: '-3750763034362895579',
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: 'hhi' }],
                    },
                ],
            },
            responseTokenCount: 56,
            firstTokenLatencyMs: 2647.8384,
            streamingDuration: 1200.7892,
        });

        await jest.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        const payload = callApi.mock.calls[0][1];
        const chatModel = payload.trajectory.generatorMetadata[0].chatModel;

        expect(chatModel.chatStartMetadata).toEqual(expect.objectContaining({
            cacheBreakpoints: expect.any(Array),
            checkpointIndex: -1,
            contextWindowMetadata: expect.objectContaining({
                estimatedTokensUsed: expect.any(Number),
            }),
            createdAt: expect.stringMatching(/^2026-03-06T/),
            latestStableMessageIndex: expect.any(Number),
            systemPromptCache: expect.objectContaining({
                options: {
                    type: 'CACHE_CONTROL_TYPE_EPHEMERAL',
                },
            }),
            timeSinceLastInvocation: '0s',
        }));
        expect(chatModel.lastCacheIndex).toBe(1);
        expect(chatModel.messageMetadata).toEqual(
            expect.arrayContaining([
                {},
                expect.objectContaining({ messageIndex: 1 }),
            ])
        );
        expect(chatModel.promptSections[0]).toEqual(expect.objectContaining({
            title: 'identity',
            content: expect.stringContaining('<identity>'),
            metadata: expect.objectContaining({
                sourceType: 'PROMPT_SECTION_SOURCE_TYPE_TEMPLATE',
                templateKey: 'identity',
            }),
        }));
        expect(chatModel.tools[0]).toEqual(expect.objectContaining({
            name: 'browser_subagent',
            description: expect.any(String),
            jsonSchemaString: expect.any(String),
        }));
        expect(payload.trajectory.generatorMetadata[0].plannerConfig).toEqual(expect.objectContaining({
            agenticModeConfig: expect.any(Object),
            conversational: expect.objectContaining({
                plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT',
            }),
            toolConfig: expect.objectContaining({
                antigravityBrowser: expect.any(Object),
                runCommand: expect.any(Object),
            }),
            truncationThresholdTokens: 160000,
        }));
        expect(payload.trajectory.steps.map(step => step.type)).toEqual(expect.arrayContaining([
            'CORTEX_STEP_TYPE_USER_INPUT',
            'CORTEX_STEP_TYPE_CONVERSATION_HISTORY',
            'CORTEX_STEP_TYPE_KNOWLEDGE_ARTIFACTS',
            'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE',
            'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            'CORTEX_STEP_TYPE_CHECKPOINT',
        ]));
        expect(chatModel.usage.cacheReadTokens).not.toBe('0');
    });

    test('TrajectoryHook rewrites captured dynamic history and clears captured thinking/signatures', async () => {
        const callApi = jest.fn().mockResolvedValue({});
        const hook = new TrajectoryHook({
            fingerprintManager: {
                getOrCreateFingerprint: jest.fn().mockReturnValue({
                    deviceFingerprint: 'fp-123',
                    extensionName: 'antigravity',
                    extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
                    hardware: 'amd64',
                    ideName: 'antigravity',
                    ideVersion: '1.19.6',
                    locale: 'en',
                    os: 'windows',
                    regionCode: 'US',
                    userTierId: 'free-tier',
                }),
            },
            delayMs: () => 0,
            createUuid: () => 'generated-uuid',
            now: () => new Date('2026-03-06T00:00:00.000Z'),
        });

        await hook.execute({
            service: {
                antigravityApiService: {
                    projectId: 'project-123',
                    callApi,
                },
            },
            accountEmail: 'acct@example.com',
            model: 'claude-opus-4-6-thinking',
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            traceId: '0123456789abcdef',
            requestBody: {
                requestType: 'agent',
                _middlewareSessionId: '-3750763034362895579',
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: 'hello world' }],
                    },
                ],
            },
            responseText: 'Finished the task.',
            responseTokenCount: 56,
            firstTokenLatencyMs: 1200,
            streamingDuration: 2400,
        });

        await jest.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        const payload = callApi.mock.calls[0][1];
        const payloadJson = JSON.stringify(payload);
        const chatModel = payload.trajectory.generatorMetadata[0].chatModel;
        const conversationStep = payload.trajectory.steps.find(step => step.type === 'CORTEX_STEP_TYPE_CONVERSATION_HISTORY');
        const plannerStep = payload.trajectory.steps.find(step => step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');

        expect(payloadJson).not.toContain('Downloads Folder Checker Plan');
        expect(payloadJson).not.toContain('Adding Example Lines');
        expect(payloadJson).not.toContain('The user just said "hhi"');
        expect(chatModel.messagePrompts[5].prompt).toContain('<conversation_summaries>');
        expect(chatModel.messagePrompts[5].prompt).toContain('</conversation_summaries>');
        expect(chatModel.messagePrompts[5].prompt).not.toContain('Conversation 2045c981-62d0-487a-94ab-206e33d8613b');
        expect(conversationStep.conversationHistory.content).toBe(
            chatModel.messagePrompts[5].prompt.replace(/^Step Id: 1\n/, '')
        );
        expect(chatModel.messagePrompts[6].thinking).toBe('');
        expect(chatModel.messagePrompts[6].thinkingSignature).toBe('');
        expect(plannerStep.plannerResponse.thinking).toBe('');
        expect(plannerStep.plannerResponse.thinkingSignature).toBe('');
    });

    test('TrajectoryHook masks secrets in full telemetry mode and skips sends above the concurrency limit', async () => {
        let resolveFirstRequest;
        const firstRequest = new Promise(resolve => {
            resolveFirstRequest = resolve;
        });
        const callApi = jest.fn()
            .mockImplementationOnce(() => firstRequest)
            .mockResolvedValueOnce({});

        const hook = new TrajectoryHook({
            fingerprintManager: {
                getOrCreateFingerprint: jest.fn().mockReturnValue({
                    deviceFingerprint: 'fp-123',
                    extensionName: 'antigravity',
                    extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
                    hardware: 'amd64',
                    ideName: 'antigravity',
                    ideVersion: '1.19.6',
                    locale: 'en',
                    os: 'windows',
                    regionCode: 'US',
                    userTierId: 'free-tier',
                }),
            },
            delayMs: () => 0,
            createUuid: () => 'generated-uuid',
            maxPendingTelemetry: 1,
        });

        const context = {
            service: {
                antigravityApiService: {
                    projectId: 'project-123',
                    callApi,
                },
            },
            accountEmail: 'acct@example.com',
            model: 'gemini-claude-opus-4-6-thinking',
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            serviceConfig: {
                telemetryMode: 'full',
            },
            requestBody: {
                _middlewareSessionId: '-123',
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: 'Contact user@example.com with sk-secret and ghp_secret via http://127.0.0.1/private' }],
                    },
                ],
            },
            responseTokenCount: 56,
            thinkingTokenCount: 144,
            firstTokenLatencyMs: 1800,
            streamingDuration: 2600,
        };

        await hook.execute(context);
        await hook.execute(context);

        await jest.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        expect(callApi).toHaveBeenCalledTimes(1);

        const payload = callApi.mock.calls[0][1];
        const requestPrompt = payload.trajectory.generatorMetadata[0].chatModel.messagePrompts.find(prompt => prompt.safeForCodeTelemetry);
        expect(requestPrompt.prompt).toContain('[EMAIL]');
        expect(requestPrompt.prompt).toContain('[API_KEY]');
        expect(requestPrompt.prompt).toContain('[PRIVATE_URL]');

        resolveFirstRequest({});
        await flushMicrotasks();
    });

    test('telemetryMode off disables both metrics and trajectory telemetry', async () => {
        const callApi = jest.fn().mockResolvedValue({});
        const fingerprintManager = {
            getOrCreateFingerprint: jest.fn().mockReturnValue({
                deviceFingerprint: 'fp-123',
                extensionName: 'antigravity',
                extensionPath: 'c:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\resources\\app\\extensions\\antigravity',
                hardware: 'amd64',
                ideName: 'antigravity',
                ideVersion: '1.19.6',
                locale: 'en',
                os: 'windows',
                regionCode: 'US',
                userTierId: 'free-tier',
            }),
        };
        const metricsHook = new MetricsHook({
            fingerprintManager,
            delayMs: () => 0,
            createUuid: () => 'generated-uuid',
            createTraceId: () => '0123456789abcdef',
        });
        const trajectoryHook = new TrajectoryHook({
            fingerprintManager,
            delayMs: () => 0,
            createUuid: () => 'generated-uuid',
        });

        const context = {
            service: {
                antigravityApiService: {
                    projectId: 'project-123',
                    callApi,
                },
            },
            accountEmail: 'acct@example.com',
            model: 'gemini-claude-opus-4-6-thinking',
            requestId: 'agent/1772754457436/trajectory-uuid/4',
            serviceConfig: {
                telemetryMode: 'off',
            },
            requestBody: {
                _middlewareSessionId: '-123',
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: 'hello' }],
                    },
                ],
            },
        };

        await metricsHook.execute(context);
        await trajectoryHook.execute(context);

        await jest.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        expect(callApi).not.toHaveBeenCalled();
    });
});

describe('Antigravity SQLite schema alignment', () => {
    test('getDb migrates legacy telemetry_log tables to the plan schema with NOT NULL columns', async () => {
        const originalCwd = process.cwd();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-sqlite-'));
        const dbPath = path.join(tempDir, 'configs', 'antigravity.db');
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });

        const legacyDb = new Database(dbPath);
        legacyDb.exec(`
            CREATE TABLE telemetry_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              account_email TEXT,
              request_id TEXT,
              model TEXT,
              metrics_sent INTEGER NOT NULL DEFAULT 0,
              trajectory_sent INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
        legacyDb.prepare(`
            INSERT INTO telemetry_log (account_email, request_id, model, metrics_sent, trajectory_sent)
            VALUES (?, ?, ?, ?, ?)
        `).run(null, null, null, 1, 0);
        legacyDb.close();

        try {
            process.chdir(tempDir);

            jest.resetModules();
            const sqliteModule = await import('../src/db/sqlite.js');
            const database = sqliteModule.getDb();
            const telemetryColumns = database.prepare(`PRAGMA table_info(telemetry_log)`).all();
            const telemetryRow = database.prepare(`
                SELECT account_email, request_id, model, metrics_sent, trajectory_sent
                FROM telemetry_log
            `).get();

            expect(telemetryColumns.filter(column => ['account_email', 'request_id', 'model'].includes(column.name)))
                .toEqual(expect.arrayContaining([
                    expect.objectContaining({ name: 'account_email', notnull: 1 }),
                    expect.objectContaining({ name: 'request_id', notnull: 1 }),
                    expect.objectContaining({ name: 'model', notnull: 1 }),
                ]));
            expect(telemetryRow).toEqual({
                account_email: 'unknown-account',
                request_id: 'unknown-request',
                model: 'unknown-model',
                metrics_sent: 1,
                trajectory_sent: 0,
            });

            sqliteModule.closeDb();
        } finally {
            jest.resetModules();
            process.chdir(originalCwd);
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
