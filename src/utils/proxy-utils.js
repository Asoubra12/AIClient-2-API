/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

function safeString(value) {
    return value === undefined || value === null ? '' : String(value);
}

export function maskProxyUrl(proxyUrl) {
    const raw = safeString(proxyUrl).trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        const protocol = url.protocol || 'http:';
        const host = url.hostname;
        const port = url.port ? `:${url.port}` : '';
        if (!host) return '';
        return `${protocol}//${host}${port}`;
    } catch {
        return '';
    }
}

/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const trimmedUrl = proxyUrl.trim();
    if (!trimmedUrl) {
        return null;
    }

    try {
        const url = new URL(trimmedUrl);
        const protocol = url.protocol.toLowerCase();
        const host = url.hostname || null;
        const port = url.port ? Number.parseInt(url.port, 10) : null;
        const maskedUrl = maskProxyUrl(trimmedUrl) || '[invalid proxy url]';

        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            // SOCKS 代理
            const socksAgent = new SocksProxyAgent(trimmedUrl);
            return {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks',
                proxyHost: host,
                proxyPort: Number.isFinite(port) ? port : null,
                maskedUrl
            };
        } else if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理
            return {
                httpAgent: new HttpProxyAgent(trimmedUrl),
                httpsAgent: new HttpsProxyAgent(trimmedUrl),
                proxyType: 'http',
                proxyHost: host,
                proxyPort: Number.isFinite(port) ? port : null,
                maskedUrl
            };
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }
    } catch (error) {
        logger.error(`[Proxy] Failed to parse proxy URL: ${error.message}`);
        return null;
    }
}

/**
 * Returns the effective proxy URL for a provider with a stable "source" label.
 * This never returns credentials, only the raw URL (caller should mask before display).
 *
 * @param {Object} config - merged config (global + node config)
 * @param {string} providerType
 * @returns {{proxyUrl: string|null, source: ('node'|'global'|null), explicitlyDisabled: boolean}}
 */
export function getEffectiveProxyUrl(config, providerType) {
    // Node-level override semantics:
    // - NODE_PROXY_URL_PRESENT=true and NODE_PROXY_URL='' means explicit disable
    if (config?.NODE_PROXY_URL_PRESENT === true) {
        const raw = safeString(config.NODE_PROXY_URL).trim();
        if (!raw) {
            return { proxyUrl: null, source: 'node', explicitlyDisabled: true };
        }
        return { proxyUrl: raw, source: 'node', explicitlyDisabled: false };
    }

    if (!isProxyEnabledForProvider(config, providerType)) {
        return { proxyUrl: null, source: null, explicitlyDisabled: false };
    }

    const raw = safeString(config?.PROXY_URL).trim();
    if (!raw) {
        return { proxyUrl: null, source: null, explicitlyDisabled: false };
    }

    return { proxyUrl: raw, source: 'global', explicitlyDisabled: false };
}

/**
 * Safe proxy summary for logs/UI: never includes userinfo credentials.
 * @param {Object} config - merged config (global + node config)
 * @param {string} providerType
 * @returns {{enabled: boolean, source: ('node'|'global'|null), proxyType: string|null, host: string|null, port: number|null, maskedUrl: string, explicitlyDisabled: boolean}}
 */
export function getProxySummary(config, providerType) {
    const effective = getEffectiveProxyUrl(config, providerType);
    if (!effective.proxyUrl) {
        return {
            enabled: false,
            source: effective.source,
            proxyType: null,
            host: null,
            port: null,
            maskedUrl: '',
            explicitlyDisabled: effective.explicitlyDisabled
        };
    }

    const parsed = parseProxyUrl(effective.proxyUrl);
    if (!parsed) {
        return {
            enabled: true,
            source: effective.source,
            proxyType: null,
            host: null,
            port: null,
            maskedUrl: maskProxyUrl(effective.proxyUrl) || '',
            explicitlyDisabled: effective.explicitlyDisabled
        };
    }

    return {
        enabled: true,
        source: effective.source,
        proxyType: parsed.proxyType || null,
        host: parsed.proxyHost || null,
        port: Number.isFinite(parsed.proxyPort) ? parsed.proxyPort : null,
        maskedUrl: parsed.maskedUrl || maskProxyUrl(effective.proxyUrl) || '',
        explicitlyDisabled: effective.explicitlyDisabled
    };
}

/**
 * 检查指定的提供商是否启用了代理
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabledForProvider(config, providerType) {
    if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.PROXY_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    return enabledProviders.includes(providerType);
}

/**
 * 获取指定提供商的代理配置
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} 代理配置对象或 null
 */
export function getProxyConfigForProvider(config, providerType) {
    // Node-level override: if explicitly present, it takes precedence and does NOT require
    // PROXY_ENABLED_PROVIDERS to include providerType.
    if (config?.NODE_PROXY_URL_PRESENT === true) {
        const raw = config.NODE_PROXY_URL;
        const trimmed = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!trimmed) {
            return null; // explicit disable
        }

        const proxyConfig = parseProxyUrl(trimmed);
        if (proxyConfig) {
            logger.info(`[Proxy] Using node ${proxyConfig.proxyType} proxy for ${providerType}: ${proxyConfig.maskedUrl || maskProxyUrl(trimmed)}`);
        }
        if (proxyConfig) proxyConfig.proxySource = 'node';
        return proxyConfig;
    }

    if (!isProxyEnabledForProvider(config, providerType)) {
        return null;
    }

    const proxyConfig = parseProxyUrl(config.PROXY_URL);
    if (proxyConfig) {
        logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy for ${providerType}: ${proxyConfig.maskedUrl || maskProxyUrl(config.PROXY_URL)}`);
    }
    if (proxyConfig) proxyConfig.proxySource = 'global';
    return proxyConfig;
}

/**
 * 为 axios 配置代理
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(axiosConfig, config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} transporter 配置对象或 null
 */
export function getGoogleAuthProxyConfig(config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}
