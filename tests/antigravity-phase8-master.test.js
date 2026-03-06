import request from 'supertest';
import { jest } from '@jest/globals';

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    __esModule: true,
    broadcastEvent: jest.fn(),
}));

import { buildHealthPayload, createMasterServer } from '../src/core/master.js';
import { handleRestartService } from '../src/ui-modules/system-api.js';

describe('Phase 8 master health endpoint', () => {
    test('reports launch strategy and heartbeat stats on /master/health', async () => {
        const supervisor = {
            getStatus: jest.fn(() => ({
                master: {
                    pid: 42,
                    uptime: 12,
                    memoryUsage: { rss: 1024 },
                },
                worker: {
                    pid: 9001,
                    startTime: '2026-03-06T00:00:00.000Z',
                    restartCount: 1,
                    lastRestartTime: '2026-03-06T00:00:01.000Z',
                    isRestarting: false,
                    isRunning: true,
                    readyReported: true,
                    launchStrategy: 'fork',
                    heartbeat: {
                        lastPingAt: '2026-03-06T00:00:02.000Z',
                        lastPongAt: '2026-03-06T00:00:02.100Z',
                        missedBeats: 0,
                        requestCount: 7,
                        memory: { rss: 2048 },
                        cpu: { user: 5, system: 3 },
                    },
                    lastMessageAt: '2026-03-06T00:00:02.100Z',
                    lastExit: null,
                },
            })),
            restartWorker: jest.fn(),
            stopWorker: jest.fn(),
            startWorker: jest.fn(),
        };

        const server = createMasterServer({ supervisor });

        await request(server)
            .get('/master/health')
            .expect(200)
            .expect(({ body }) => {
                expect(body.status).toBe('healthy');
                expect(body.worker.launchStrategy).toBe('fork');
                expect(body.worker.heartbeat.requestCount).toBe(7);
                expect(body.worker.heartbeat.memory).toEqual({ rss: 2048 });
            });
    });

    test('reports degraded until the worker has actually reported ready', () => {
        const payload = buildHealthPayload({
            getStatus: () => ({
                master: {
                    pid: 42,
                    uptime: 12,
                    memoryUsage: { rss: 1024 },
                },
                worker: {
                    pid: 9001,
                    startTime: '2026-03-06T00:00:00.000Z',
                    restartCount: 1,
                    lastRestartTime: '2026-03-06T00:00:01.000Z',
                    isRestarting: false,
                    isRunning: true,
                    readyReported: false,
                    launchStrategy: 'fork',
                    heartbeat: {
                        lastPingAt: null,
                        lastPongAt: null,
                        missedBeats: 0,
                        requestCount: 0,
                        memory: null,
                        cpu: null,
                    },
                    lastMessageAt: null,
                    lastExit: null,
                },
            }),
        });

        expect(payload.status).toBe('degraded');
    });

    test('waits for worker readiness before acknowledging /master/restart success', async () => {
        let resolveReady;
        const readyPromise = new Promise(resolve => {
            resolveReady = resolve;
        });
        const supervisor = {
            getStatus: jest.fn(() => ({
                master: {
                    pid: 42,
                    uptime: 12,
                    memoryUsage: { rss: 1024 },
                },
                worker: {
                    pid: 9001,
                    startTime: '2026-03-06T00:00:00.000Z',
                    restartCount: 2,
                    lastRestartTime: '2026-03-06T00:00:02.000Z',
                    isRestarting: false,
                    isRunning: true,
                    readyReported: true,
                    launchStrategy: 'fork',
                    heartbeat: {
                        lastPingAt: null,
                        lastPongAt: null,
                        missedBeats: 0,
                        requestCount: 0,
                        memory: null,
                        cpu: null,
                    },
                    lastMessageAt: null,
                    lastExit: null,
                },
            })),
            restartWorker: jest.fn().mockResolvedValue(undefined),
            awaitWorkerReady: jest.fn(() => readyPromise),
            stopWorker: jest.fn(),
            startWorker: jest.fn(),
        };
        const server = createMasterServer({ supervisor });
        const handler = server.listeners('request')[0];
        const req = {
            method: 'POST',
            url: '/master/restart',
            headers: {
                host: 'localhost',
            },
        };
        const res = {
            setHeader: jest.fn(),
            writeHead: jest.fn(),
            end: jest.fn(),
        };

        let settled = false;
        const pendingRequest = Promise.resolve(handler(req, res)).then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(supervisor.restartWorker).toHaveBeenCalledTimes(1);
        expect(supervisor.awaitWorkerReady).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        resolveReady();
        await pendingRequest;

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
            success: true,
        });
    });

    test('returns 503 from /master/stop when the worker does not actually exit', async () => {
        const supervisor = {
            getStatus: jest.fn(() => ({
                master: {
                    pid: 42,
                    uptime: 12,
                    memoryUsage: { rss: 1024 },
                },
                worker: {
                    pid: 9001,
                    startTime: '2026-03-06T00:00:00.000Z',
                    restartCount: 2,
                    lastRestartTime: '2026-03-06T00:00:02.000Z',
                    isRestarting: false,
                    isRunning: true,
                    readyReported: false,
                    launchStrategy: 'fork',
                    heartbeat: {
                        lastPingAt: null,
                        lastPongAt: null,
                        missedBeats: 0,
                        requestCount: 0,
                        memory: null,
                        cpu: null,
                    },
                    lastMessageAt: null,
                    lastExit: null,
                },
            })),
            restartWorker: jest.fn(),
            awaitWorkerReady: jest.fn(),
            stopWorker: jest.fn().mockRejectedValue(new Error('Worker did not exit within 250ms')),
            startWorker: jest.fn(),
        };
        const server = createMasterServer({ supervisor });

        await request(server)
            .post('/master/stop')
            .expect(503)
            .expect(({ body }) => {
                expect(body).toMatchObject({
                    success: false,
                    message: 'Worker did not exit within 250ms',
                });
            });
    });
});

describe('Phase 8 UI restart endpoint', () => {
    const originalSend = process.send;
    const originalEnv = process.env.IS_WORKER_PROCESS;

    afterEach(() => {
        if (originalSend === undefined) {
            delete process.send;
        } else {
            Object.defineProperty(process, 'send', {
                value: originalSend,
                configurable: true,
                writable: true,
            });
        }

        if (originalEnv === undefined) {
            delete process.env.IS_WORKER_PROCESS;
        } else {
            process.env.IS_WORKER_PROCESS = originalEnv;
        }
    });

    test('returns 202 Accepted because worker restart acknowledgement is not a readiness acknowledgement', async () => {
        process.env.IS_WORKER_PROCESS = 'true';
        Object.defineProperty(process, 'send', {
            value: jest.fn(),
            configurable: true,
            writable: true,
        });

        const res = {
            writeHead: jest.fn(),
            end: jest.fn(),
        };

        await handleRestartService({}, res);

        expect(process.send).toHaveBeenCalledWith({ type: 'restart_request' });
        expect(res.writeHead).toHaveBeenCalledWith(202, { 'Content-Type': 'application/json' });
        expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
            success: true,
            ready: false,
        });
    });
});
