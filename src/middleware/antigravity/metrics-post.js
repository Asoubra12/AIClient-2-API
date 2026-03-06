import { v4 as uuidv4 } from 'uuid';
import { telemetryLogStore } from '../../db/telemetry-log-store.js';
import logger from '../../utils/logger.js';
import { AntigravityHook } from './hook-base.js';
import { fingerprintManager, toPlatformId } from './fingerprint.js';
import {
  buildConversationOfferedStatus,
  createNanoTimestamp,
  createMetricsPayloadTemplate,
  formatDurationMs,
  randomHex,
  resolveAccountEmail,
  resolveProject,
  resolveRequestType,
  resolveTelemetryService,
  resolveTrajectoryId,
  shouldSkipTelemetry,
} from './telemetry-utils.js';

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class MetricsHook extends AntigravityHook {
  constructor({
    fingerprintManager: manager = fingerprintManager,
    telemetryLogStore: logStore = telemetryLogStore,
    delayMs = () => randomBetween(10, 200),
    createUuid = uuidv4,
    createTraceId = () => randomHex(8),
    now = () => new Date(),
  } = {}) {
    super();
    this.fingerprintManager = manager;
    this.telemetryLogStore = logStore;
    this.delayMs = delayMs;
    this.createUuid = createUuid;
    this.createTraceId = createTraceId;
    this.now = now;
    this.telemetryLogStore?.scheduleCleanup?.();
  }

  get name() { return 'MetricsHook'; }
  get type() { return 'post'; }
  get priority() { return 400; }

  async execute(context) {
    if (shouldSkipTelemetry(context)) {
      return null;
    }

    const timeout = setTimeout(() => {
      Promise.resolve(this.sendTelemetry(context)).catch(error => {
        logger.debug(`[MetricsHook] Failed to send telemetry: ${error.message}`);
      });
    }, this.delayMs());

    timeout.unref?.();
    return null;
  }

  async sendTelemetry(context) {
    if (shouldSkipTelemetry(context)) {
      return;
    }

    const service = resolveTelemetryService(context);
    if (!service?.callApi) {
      return;
    }

    const accountEmail = resolveAccountEmail(context);
    const telemetryEntry = {
      accountEmail,
      requestId: context?.requestId,
      model: context?.model,
    };
    this.telemetryLogStore?.ensureRequestLog?.(telemetryEntry);
    const fingerprint = this.fingerprintManager.getOrCreateFingerprint(accountEmail);
    const payload = this.buildPayload(context, fingerprint);
    await service.callApi('recordCodeAssistMetrics', payload);
    this.telemetryLogStore?.markMetricsSent?.(telemetryEntry);
  }

  buildPayload(context, fingerprint) {
    const now = this.now();
    const isAgentic = resolveRequestType(context) === 'agent';
    const payload = createMetricsPayloadTemplate();
    const metric = payload.metrics?.[0] || {};
    const conversationOffered = metric.conversationOffered || {};

    payload.project = resolveProject(context);
    payload.requestId = this.createUuid();
    payload.metadata = {
      ...payload.metadata,
      ideVersion: fingerprint?.ideVersion || payload.metadata?.ideVersion || '1.19.6',
      platform: toPlatformId(fingerprint),
    };

    metric.timestamp = createNanoTimestamp(now);
    metric.conversationOffered = {
      ...conversationOffered,
      status: buildConversationOfferedStatus(context),
      traceId: this.createTraceId(),
      streamingLatency: {
        firstMessageLatency: formatDurationMs(context?.firstTokenLatencyMs ?? 0),
        totalLatency: formatDurationMs(context?.latencyMs ?? context?.timing?.durationMs ?? 0),
      },
    };

    if (isAgentic) {
      metric.conversationOffered.isAgentic = true;
      metric.conversationOffered.initiationMethod = 'AGENT';
      metric.conversationOffered.trajectoryId = resolveTrajectoryId(context?.requestId, this.createUuid);
    } else {
      delete metric.conversationOffered.isAgentic;
      delete metric.conversationOffered.initiationMethod;
      delete metric.conversationOffered.trajectoryId;
    }

    payload.metrics = [metric];
    return payload;
  }
}
