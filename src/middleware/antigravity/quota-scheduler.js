import deepmerge from 'deepmerge';
import logger from '../../utils/logger.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import * as quotaStore from '../../db/quota-store.js';

const REFRESH_BATCH_SIZE = 5;
const REFRESH_BATCH_DELAY_MS = 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const NEAR_RESET_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const NEAR_RESET_WINDOW_MS = 2 * 60 * 60 * 1000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getQuotaRows() {
  return quotaStore.getAllQuotas?.() || [];
}

function getEligibleNodes(config, providerType) {
  const providerPool = config?.providerPools?.[providerType];
  if (!Array.isArray(providerPool)) {
    return [];
  }

  return providerPool.filter(node => !node?.isDisabled && node?.isHealthy !== false);
}

async function getServiceAdapter(nodeConfig) {
  const adapterModule = await import('../../providers/adapter.js');
  return adapterModule.getServiceAdapter(nodeConfig);
}

export class QuotaScheduler {
  constructor() {
    this.intervalTimers = new Map();
    this.refreshPromises = new Map();
  }

  getRefreshIntervalMs(quotaRows = []) {
    const now = Date.now();
    const hasNearReset = quotaRows.some(row => {
      const resetAt = Date.parse(row?.reset_time);
      if (!Number.isFinite(resetAt) || resetAt <= now) {
        return false;
      }

      return resetAt - now <= NEAR_RESET_WINDOW_MS;
    });

    return hasNearReset ? NEAR_RESET_REFRESH_INTERVAL_MS : DEFAULT_REFRESH_INTERVAL_MS;
  }

  ensureStarted(config, providerType = MODEL_PROVIDER.ANTIGRAVITY) {
    if (this.intervalTimers.has(providerType) || getEligibleNodes(config, providerType).length === 0) {
      return;
    }

    this.scheduleNextRefresh(config, providerType);
  }

  scheduleNextRefresh(config, providerType = MODEL_PROVIDER.ANTIGRAVITY) {
    const existingTimer = this.intervalTimers.get(providerType);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const intervalMs = this.getRefreshIntervalMs(getQuotaRows());
    const timeout = setTimeout(() => {
      this.intervalTimers.delete(providerType);
      this.triggerImmediateRefresh(config, providerType)
        .catch(error => {
          logger.debug(`[QuotaScheduler] Scheduled refresh failed for ${providerType}: ${error.message}`);
        })
        .finally(() => {
          this.ensureStarted(config, providerType);
        });
    }, intervalMs);

    timeout.unref?.();
    this.intervalTimers.set(providerType, timeout);
  }

  async refreshProviderPool(config, providerType = MODEL_PROVIDER.ANTIGRAVITY) {
    const eligibleNodes = getEligibleNodes(config, providerType);
    if (eligibleNodes.length === 0) {
      return;
    }

    logger.info(`[QuotaScheduler] Refreshing ${eligibleNodes.length} ${providerType} account(s) in batches of ${REFRESH_BATCH_SIZE}`);

    for (let index = 0; index < eligibleNodes.length; index += REFRESH_BATCH_SIZE) {
      const batch = eligibleNodes.slice(index, index + REFRESH_BATCH_SIZE);

      const results = await Promise.allSettled(batch.map(async providerConfig => {
        const nodeConfig = deepmerge(config, {
          ...providerConfig,
          MODEL_PROVIDER: providerType,
        });
        delete nodeConfig.providerPools;

        const adapter = await getServiceAdapter(nodeConfig);
        const antigravityService = adapter?.antigravityApiService;
        const usageTarget = antigravityService?.getUsageLimits ? antigravityService : adapter;

        if (typeof usageTarget?.getUsageLimits === 'function') {
          await usageTarget.getUsageLimits();
        }

        if (antigravityService?.accountEmail) {
          providerConfig.ANTIGRAVITY_ACCOUNT_EMAIL = antigravityService.accountEmail;
        }
      }));

      results.forEach((result, batchIndex) => {
        if (result.status === 'rejected') {
          const providerConfig = batch[batchIndex];
          providerConfig.needsRefresh = true;
          providerConfig.lastErrorMessage = result.reason?.message || String(result.reason);
          logger.warn(`[QuotaScheduler] Failed to refresh quotas for ${providerConfig.uuid || 'unknown'}: ${providerConfig.lastErrorMessage}`);
        }
      });

      if (index + REFRESH_BATCH_SIZE < eligibleNodes.length) {
        await delay(REFRESH_BATCH_DELAY_MS);
      }
    }
  }

  queueRefresh(config, providerType = MODEL_PROVIDER.ANTIGRAVITY) {
    const inFlightRefresh = this.refreshPromises.get(providerType);
    if (inFlightRefresh) {
      return inFlightRefresh;
    }

    let refreshPromise;
    refreshPromise = (async () => {
      await this.refreshProviderPool(config, providerType);
    })().finally(() => {
      if (this.refreshPromises.get(providerType) === refreshPromise) {
        this.refreshPromises.delete(providerType);
      }
    });

    this.refreshPromises.set(providerType, refreshPromise);
    return refreshPromise;
  }

  triggerColdStartRefresh(config, providerType = MODEL_PROVIDER.ANTIGRAVITY) {
    return this.queueRefresh(config, providerType);
  }

  triggerImmediateRefresh(config, providerType = MODEL_PROVIDER.ANTIGRAVITY) {
    return this.queueRefresh(config, providerType);
  }
}

export const quotaScheduler = new QuotaScheduler();
