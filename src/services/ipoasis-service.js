import axios from 'axios';
import { proxyLeaseStore } from '../db/proxy-lease-store.js';
import logger from '../utils/logger.js';

const IPOASIS_BASE_URL = 'https://api.ipoasis.com';
const IPOASIS_STICKY_SESSION_TYPE = 'sticky';

function normalizeProtocol(protocol) {
    const value = typeof protocol === 'string' ? protocol.trim().toLowerCase() : '';
    return value || 'http';
}

function normalizeProxyUrl(rawProxy, protocol) {
    if (typeof rawProxy !== 'string' || !rawProxy.trim()) {
        throw new Error('IPOasis returned an empty proxy lease');
    }

    const parts = rawProxy.trim().split(':');
    if (parts.length !== 4) {
        throw new Error(`Unsupported IPOasis proxy format: ${rawProxy}`);
    }

    const [host, port, username, password] = parts;
    const normalizedProtocol = normalizeProtocol(protocol);
    return `${normalizedProtocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

export class IpoasisService {
    constructor({
        apiKey,
        baseUrl = IPOASIS_BASE_URL,
        httpClient = axios,
        leaseStore = proxyLeaseStore,
    } = {}) {
        this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
        this.baseUrl = baseUrl;
        this.httpClient = httpClient;
        this.leaseStore = leaseStore;
    }

    async generateStickyProxy({
        providerUuid,
        providerType,
        subuserId,
        protocol = 'http',
        country,
        city,
        state,
    } = {}) {
        if (!this.apiKey) {
            throw new Error('IPOASIS_API_KEY is required');
        }

        if (!providerUuid) {
            throw new Error('providerUuid is required');
        }

        if (!subuserId) {
            throw new Error('IPOASIS_SUBUSER_ID is required');
        }

        const normalizedProtocol = normalizeProtocol(protocol);

        try {
            const response = await this.httpClient.get(
                `${this.baseUrl}/v1/proxy/dynamic/${subuserId}`,
                {
                    headers: {
                        'X-API-KEY': this.apiKey,
                    },
                    params: {
                        count: 1,
                        country,
                        protocol: normalizedProtocol,
                        sessionType: IPOASIS_STICKY_SESSION_TYPE,
                        ...(city ? { city } : {}),
                        ...(state ? { state } : {}),
                    },
                }
            );

            const proxyEntry = Array.isArray(response?.data) ? response.data[0] : null;
            const proxyUrl = normalizeProxyUrl(proxyEntry, normalizedProtocol);
            const lease = {
                providerUuid,
                providerType,
                subuserId,
                proxyUrl,
                protocol: normalizedProtocol,
                country,
                city,
                state,
                sessionType: IPOASIS_STICKY_SESSION_TYPE,
                leaseState: 'ready',
                lastError: null,
            };

            this.leaseStore.saveProxyLease?.(lease);
            return lease;
        } catch (error) {
            try {
                this.leaseStore.markProxyLeaseError?.(providerUuid, error.message);
            } catch (markError) {
                logger.debug(`[IPOasis] Failed to mark proxy lease error for ${providerUuid}: ${markError.message}`);
            }
            throw error;
        }
    }
}

export function createIpoasisService(options) {
    return new IpoasisService(options);
}

export { normalizeProxyUrl };
