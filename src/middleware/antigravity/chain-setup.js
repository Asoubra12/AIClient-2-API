import logger from '../../utils/logger.js';
import { AntigravityHook } from './hook-base.js';

function getSelectedProviderConfig(context) {
  const selectedUuid = context?.options?.preSelectedUuid || context?.preSelectedUuid;
  if (!selectedUuid) {
    return null;
  }

  const providerPool = context?.config?.providerPools?.[context?.provider];
  if (!Array.isArray(providerPool)) {
    return null;
  }

  return providerPool.find(providerConfig =>
    providerConfig?.uuid === selectedUuid && providerConfig.isDisabled !== true
  ) || null;
}

export class ChainSetupHook extends AntigravityHook {
  get name() { return 'ChainSetupHook'; }
  get type() { return 'pre'; }
  get priority() { return 250; }

  async execute(context) {
    const providerConfig = getSelectedProviderConfig(context);
    if (!providerConfig) {
      return null;
    }

    const [
      { default: deepmerge },
      { getServiceAdapter },
      { getProviderPoolManager },
    ] = await Promise.all([
      import('deepmerge'),
      import('../../providers/adapter.js'),
      import('../../services/service-manager.js'),
    ]);

    const nodeConfig = deepmerge(context.config, {
      ...providerConfig,
      MODEL_PROVIDER: context.provider,
    });
    delete nodeConfig.providerPools;

    const adapter = getServiceAdapter(nodeConfig);
    const service = adapter?.antigravityApiService;

    if (!service?.initialize) {
      return null;
    }

    try {
      await service.initialize();
    } catch (initialError) {
      logger.warn(`[ChainSetupHook] Initial initialize failed for ${providerConfig.uuid}: ${initialError.message}`);

      try {
        await service.initialize();
      } catch (finalError) {
        logger.warn(`[ChainSetupHook] Initialize retry failed for ${providerConfig.uuid}: ${finalError.message}`);
        getProviderPoolManager()?.markProviderUnhealthy?.(context.provider, { uuid: providerConfig.uuid }, finalError.message);
        return null;
      }
    }

    if (service.accountEmail) {
      providerConfig.ANTIGRAVITY_ACCOUNT_EMAIL = service.accountEmail;
    }

    return {
      accountEmail: service.accountEmail || providerConfig.ANTIGRAVITY_ACCOUNT_EMAIL || context.accountEmail || null,
    };
  }
}
