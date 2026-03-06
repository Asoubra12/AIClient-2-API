import { getQuota, decrementLocalEstimate, incrementLocalEstimate } from '../../db/quota-store.js';
import logger from '../../utils/logger.js';
import { AntigravityHook } from './hook-base.js';
import { quotaScheduler } from './quota-scheduler.js';

const ANTIGRAVITY_PROVIDER = 'gemini-antigravity';

function getAccountKey(providerConfig) {
  return providerConfig?.ANTIGRAVITY_ACCOUNT_EMAIL ||
    providerConfig?.accountEmail ||
    providerConfig?.accountId ||
    providerConfig?.uuid ||
    null;
}

function getQuotaScore(quotaState) {
  if (!quotaState) {
    return null;
  }

  if (Number.isFinite(quotaState.local_estimate)) {
    return quotaState.local_estimate;
  }

  if (Number.isFinite(quotaState.remaining_fraction)) {
    return quotaState.remaining_fraction;
  }

  return null;
}

export function reconcileQuotaReservation(reservation, actualSelection = {}) {
  const amount = Number(reservation?.amount);
  if (!reservation?.accountKey || !reservation?.model || !Number.isFinite(amount) || amount <= 0) {
    return reservation ?? null;
  }

  const actualProvider = actualSelection.provider || null;
  const actualUuid = actualSelection.uuid || null;
  const actualAccountKey = actualSelection.accountKey || null;

  if (!actualProvider && !actualUuid && !actualAccountKey) {
    return reservation;
  }

  if (actualProvider && actualProvider !== ANTIGRAVITY_PROVIDER) {
    incrementLocalEstimate(reservation.accountKey, reservation.model, amount);
    return null;
  }

  if (
    (actualUuid && actualUuid === reservation.uuid) ||
    (actualAccountKey && actualAccountKey === reservation.accountKey)
  ) {
    return reservation;
  }

  incrementLocalEstimate(reservation.accountKey, reservation.model, amount);

  if (actualAccountKey) {
    decrementLocalEstimate(actualAccountKey, reservation.model, amount);
    return {
      ...reservation,
      uuid: actualUuid || reservation.uuid,
      accountKey: actualAccountKey,
    };
  }

  return {
    ...reservation,
    uuid: actualUuid || reservation.uuid,
  };
}

export class QuotaSelectHook extends AntigravityHook {
  constructor({ scheduler = quotaScheduler, decrementAmount = 0.01 } = {}) {
    super();
    this.scheduler = scheduler;
    this.decrementAmount = decrementAmount;
  }

  get name() { return 'QuotaSelectHook'; }
  get type() { return 'pre'; }
  get priority() { return 200; }

  async execute(context) {
    const { config, model, options = {}, provider } = context;
    const providerPool = config?.providerPools?.[provider];

    this.scheduler.ensureStarted?.(config, provider);

    if (!Array.isArray(providerPool) || providerPool.length === 0 || !model) {
      return null;
    }

    let bestCandidate = null;
    let sawQuotaData = false;

    for (const providerConfig of providerPool) {
      if (!providerConfig?.uuid || providerConfig.isDisabled || providerConfig.isHealthy === false) {
        continue;
      }

      const accountKey = getAccountKey(providerConfig);
      if (!accountKey) {
        continue;
      }

      const quotaState = getQuota(accountKey, model);
      if (!quotaState) {
        continue;
      }

      sawQuotaData = true;
      const quotaScore = getQuotaScore(quotaState);
      if (!Number.isFinite(quotaScore) || quotaScore <= 0) {
        continue;
      }

      if (!bestCandidate || quotaScore > bestCandidate.quotaScore) {
        bestCandidate = {
          uuid: providerConfig.uuid,
          accountKey,
          quotaScore,
        };
      }
    }

    if (!bestCandidate) {
      if (!sawQuotaData) {
        Promise.resolve(this.scheduler.triggerColdStartRefresh?.(config, provider)).catch(error => {
          logger.debug(`[QuotaSelectHook] Cold-start refresh failed: ${error.message}`);
        });
      }
      return null;
    }

    decrementLocalEstimate(bestCandidate.accountKey, model, this.decrementAmount);

    return {
      preSelectedUuid: bestCandidate.uuid,
      quotaReservation: {
        uuid: bestCandidate.uuid,
        accountKey: bestCandidate.accountKey,
        model,
        amount: this.decrementAmount,
      },
      options: {
        ...options,
        preSelectedUuid: bestCandidate.uuid,
      },
    };
  }
}
