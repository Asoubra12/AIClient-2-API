import fs from 'fs';
import os from 'os';
import path from 'path';

describe('Antigravity IPOasis proxy lease storage', () => {
    let originalCwd;
    let tempDir;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-ipoasis-'));
        process.chdir(tempDir);
    });

    afterEach(async () => {
        jest.resetModules();
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('saves and reads proxy leases by provider UUID', async () => {
        const sqliteModule = await import('../src/db/sqlite.js');
        const leaseStore = await import('../src/db/proxy-lease-store.js');

        leaseStore.saveProxyLease({
            providerUuid: 'acct-a',
            subuserId: 1865,
            proxyUrl: 'http://user:pass@gate.ipoasis.com:8668',
            protocol: 'http',
            sessionType: 'sticky',
            leaseState: 'ready',
        });

        expect(leaseStore.getProxyLease('acct-a')).toEqual(expect.objectContaining({
            provider_uuid: 'acct-a',
            subuser_id: 1865,
            proxy_url: 'http://user:pass@gate.ipoasis.com:8668',
            protocol: 'http',
            session_type: 'sticky',
            lease_state: 'ready',
        }));

        sqliteModule.closeDb();
    });

    test('marks proxy lease errors without removing the stored lease row', async () => {
        const sqliteModule = await import('../src/db/sqlite.js');
        const leaseStore = await import('../src/db/proxy-lease-store.js');

        leaseStore.saveProxyLease({
            providerUuid: 'acct-b',
            subuserId: 1865,
            proxyUrl: 'http://user:pass@gate.ipoasis.com:8668',
            protocol: 'http',
            sessionType: 'sticky',
            leaseState: 'ready',
        });

        leaseStore.markProxyLeaseError('acct-b', 'proxy auth failed');

        expect(leaseStore.getProxyLease('acct-b')).toEqual(expect.objectContaining({
            provider_uuid: 'acct-b',
            last_error: 'proxy auth failed',
            lease_state: 'error',
        }));

        sqliteModule.closeDb();
    });

    test('rebuilds prepared statements after closeDb reopens SQLite', async () => {
        const sqliteModule = await import('../src/db/sqlite.js');
        const leaseStore = await import('../src/db/proxy-lease-store.js');

        leaseStore.saveProxyLease({
            providerUuid: 'acct-c',
            subuserId: 1865,
            proxyUrl: 'http://user-c:pass-c@gate.ipoasis.com:8668',
            protocol: 'http',
            sessionType: 'sticky',
            leaseState: 'ready',
        });

        sqliteModule.closeDb();

        leaseStore.saveProxyLease({
            providerUuid: 'acct-d',
            subuserId: 1865,
            proxyUrl: 'http://user-d:pass-d@gate.ipoasis.com:8668',
            protocol: 'http',
            sessionType: 'sticky',
            leaseState: 'ready',
        });

        expect(leaseStore.getProxyLease('acct-d')).toEqual(expect.objectContaining({
            provider_uuid: 'acct-d',
            proxy_url: 'http://user-d:pass-d@gate.ipoasis.com:8668',
        }));

        sqliteModule.closeDb();
    });
});

describe('Antigravity IPOasis sticky proxy generation', () => {
    test('requests one sticky proxy and normalizes the lease into a URL', async () => {
        const requests = [];
        const savedLeases = [];
        const httpClient = {
            get: jest.fn(async (url, config) => {
                requests.push({ url, config });
                return {
                    data: ['gate.ipoasis.com:8668:aiproxy:Microtech123'],
                };
            }),
        };

        const { IpoasisService } = await import('../src/services/ipoasis-service.js');
        const service = new IpoasisService({
            apiKey: 'ipoasis-key',
            httpClient,
            leaseStore: {
                saveProxyLease: lease => savedLeases.push(lease),
                markProxyLeaseError: jest.fn(),
            },
        });

        const lease = await service.generateStickyProxy({
            providerUuid: 'acct-a',
            providerType: 'gemini-antigravity',
            subuserId: 1865,
            protocol: 'http',
            country: 'US',
            city: 'nyc',
            state: 'ny',
        });

        expect(httpClient.get).toHaveBeenCalledTimes(1);
        expect(requests[0]).toEqual(expect.objectContaining({
            url: 'https://api.ipoasis.com/v1/proxy/dynamic/1865',
            config: expect.objectContaining({
                headers: { 'X-API-KEY': 'ipoasis-key' },
                params: expect.objectContaining({
                    count: 1,
                    country: 'US',
                    protocol: 'http',
                    sessionType: 'sticky',
                    city: 'nyc',
                    state: 'ny',
                }),
            }),
        }));
        expect(lease).toEqual(expect.objectContaining({
            providerUuid: 'acct-a',
            subuserId: 1865,
            protocol: 'http',
            sessionType: 'sticky',
            proxyUrl: 'http://aiproxy:Microtech123@gate.ipoasis.com:8668',
        }));
        expect(savedLeases).toEqual([
            expect.objectContaining({
                providerUuid: 'acct-a',
                proxyUrl: 'http://aiproxy:Microtech123@gate.ipoasis.com:8668',
            }),
        ]);
    });

    test('allows multiple nodes sharing one sub-user id to receive distinct leases', async () => {
        const savedLeases = [];
        const httpClient = {
            get: jest.fn()
                .mockResolvedValueOnce({
                    data: ['gate.ipoasis.com:8668:user-a:pass-a'],
                })
                .mockResolvedValueOnce({
                    data: ['gate.ipoasis.com:8668:user-b:pass-b'],
                }),
        };

        const { IpoasisService } = await import('../src/services/ipoasis-service.js');
        const service = new IpoasisService({
            apiKey: 'ipoasis-key',
            httpClient,
            leaseStore: {
                saveProxyLease: lease => savedLeases.push(lease),
                markProxyLeaseError: jest.fn(),
            },
        });

        const firstLease = await service.generateStickyProxy({
            providerUuid: 'acct-a',
            providerType: 'gemini-antigravity',
            subuserId: 1865,
            protocol: 'http',
            country: 'US',
        });
        const secondLease = await service.generateStickyProxy({
            providerUuid: 'acct-b',
            providerType: 'gemini-antigravity',
            subuserId: 1865,
            protocol: 'http',
            country: 'US',
        });

        expect(firstLease.proxyUrl).not.toBe(secondLease.proxyUrl);
        expect(savedLeases.map(lease => lease.providerUuid)).toEqual(['acct-a', 'acct-b']);
    });
});

describe('Antigravity IPOasis config defaults and examples', () => {
    let originalCwd;
    let tempDir;

    beforeEach(() => {
        jest.resetModules();
        originalCwd = process.cwd();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-ipoasis-config-'));
        process.chdir(tempDir);
    });

    afterEach(() => {
        jest.resetModules();
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('default config exposes IPOasis global keys', async () => {
        const { initializeConfig } = await import('../src/core/config-manager.js');

        const config = await initializeConfig([], 'missing-config.json');

        expect(config).toEqual(expect.objectContaining({
            IPOASIS_API_KEY: null,
            IPOASIS_PROXY_PROTOCOL: 'http',
            IPOASIS_PROXY_COUNTRY: null,
            IPOASIS_PROXY_CITY: null,
            IPOASIS_PROXY_STATE: null,
        }));
    });

    test('Antigravity example nodes use IPOASIS_SUBUSER_ID instead of PROXY_URL', () => {
        const providerPools = JSON.parse(
            fs.readFileSync(path.resolve(originalCwd, 'configs/provider_pools.json.example'), 'utf8')
        );
        const configExample = JSON.parse(
            fs.readFileSync(path.resolve(originalCwd, 'configs/config.json.example'), 'utf8')
        );
        const antigravityNodes = providerPools['gemini-antigravity'];

        expect(configExample).toEqual(expect.objectContaining({
            IPOASIS_API_KEY: 'your-ipoasis-api-key',
            IPOASIS_PROXY_PROTOCOL: 'http',
            IPOASIS_PROXY_COUNTRY: 'US',
        }));
        expect(configExample.PROXY_ENABLED_PROVIDERS).not.toContain('gemini-antigravity');
        expect(Array.isArray(antigravityNodes)).toBe(true);
        expect(antigravityNodes).toHaveLength(2);
        antigravityNodes.forEach((node) => {
            expect(node.IPOASIS_SUBUSER_ID).toBe(1865);
            expect(node).not.toHaveProperty('PROXY_URL');
        });
    });
});
