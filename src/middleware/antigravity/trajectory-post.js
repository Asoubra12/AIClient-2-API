import { v4 as uuidv4 } from 'uuid';
import { telemetryLogStore } from '../../db/telemetry-log-store.js';
import logger from '../../utils/logger.js';
import { AntigravityHook } from './hook-base.js';
import { fingerprintManager } from './fingerprint.js';
import {
  buildConversationHistoryPrompt,
  buildRequestPrompt,
  buildResponseId,
  createArtifactsPrompt,
  createContentChecksum,
  createTrajectoryPayloadTemplate,
  estimateTokenCount,
  formatDurationMs,
  maskSensitiveContent,
  resolveAccountEmail,
  resolvePromptInputText,
  resolveResponseText,
  resolveSessionId,
  resolveTelemetryMode,
  resolveTelemetryService,
  resolveTrajectoryId,
  shouldSkipTelemetry,
  createUserInformationPrompt,
} from './telemetry-utils.js';

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toIsoTime(value, fallback = new Date()) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return fallback.toISOString();
}

function updateTransitionTimestamps(stepMetadata, createdAt, runningAt, completedAt) {
  const transitions = stepMetadata?.internalMetadata?.statusTransitions;
  if (!Array.isArray(transitions)) {
    return;
  }

  if (transitions.length === 1) {
    transitions[0].timestamp = completedAt || runningAt || createdAt;
    return;
  }

  if (transitions.length >= 2) {
    transitions[0].timestamp = createdAt;
    transitions[transitions.length - 1].timestamp = completedAt || runningAt || createdAt;
  }

  for (let index = 1; index < transitions.length - 1; index += 1) {
    transitions[index].timestamp = runningAt || createdAt;
  }
}

function updateStepMetadata(step, {
  createdAt,
  runningAt,
  completedAt,
  finishedGeneratingAt,
  viewableAt,
  executionId,
  cascadeId,
  trajectoryId,
  stepIndex,
  metadataIndex,
}) {
  const metadata = step?.metadata;
  if (!metadata) {
    return;
  }

  metadata.executionId = executionId;
  if (Object.prototype.hasOwnProperty.call(metadata, 'createdAt')) {
    metadata.createdAt = createdAt;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, 'completedAt') && completedAt) {
    metadata.completedAt = completedAt;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, 'finishedGeneratingAt') && finishedGeneratingAt) {
    metadata.finishedGeneratingAt = finishedGeneratingAt;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, 'viewableAt') && viewableAt) {
    metadata.viewableAt = viewableAt;
  }

  if (metadata.sourceTrajectoryStepInfo) {
    metadata.sourceTrajectoryStepInfo.cascadeId = cascadeId;
    metadata.sourceTrajectoryStepInfo.trajectoryId = trajectoryId;
    if (Number.isInteger(stepIndex)) {
      metadata.sourceTrajectoryStepInfo.stepIndex = stepIndex;
    }
    if (Number.isInteger(metadataIndex)) {
      metadata.sourceTrajectoryStepInfo.metadataIndex = metadataIndex;
    }
  }

  updateTransitionTimestamps(metadata, createdAt, runningAt, completedAt || finishedGeneratingAt);
}

function computeInputTokens(messagePrompts = []) {
  return messagePrompts.reduce((sum, prompt) => {
    if (Number.isFinite(prompt?.numTokens)) {
      return sum + prompt.numTokens;
    }

    return sum + estimateTokenCount(prompt?.prompt || '');
  }, 0);
}

export class TrajectoryHook extends AntigravityHook {
  constructor({
    fingerprintManager: manager = fingerprintManager,
    telemetryLogStore: logStore = telemetryLogStore,
    delayMs = () => randomBetween(50, 300),
    createUuid = uuidv4,
    now = () => new Date(),
    maxPendingTelemetry = 10,
  } = {}) {
    super();
    this.fingerprintManager = manager;
    this.telemetryLogStore = logStore;
    this.delayMs = delayMs;
    this.createUuid = createUuid;
    this.now = now;
    this.maxPendingTelemetry = maxPendingTelemetry;
    this.pendingTelemetryCount = 0;
    this.telemetryLogStore?.scheduleCleanup?.();
  }

  get name() { return 'TrajectoryHook'; }
  get type() { return 'post'; }
  get priority() { return 500; }

  async execute(context) {
    if (shouldSkipTelemetry(context)) {
      return null;
    }

    const timeout = setTimeout(() => {
      if (this.pendingTelemetryCount >= this.maxPendingTelemetry) {
        logger.debug('[TrajectoryHook] Skipping telemetry because the concurrency limit is reached');
        return;
      }

      this.pendingTelemetryCount += 1;
      Promise.resolve(this.sendTelemetry(context))
        .catch(error => {
          logger.debug(`[TrajectoryHook] Failed to send telemetry: ${error.message}`);
        })
        .finally(() => {
          this.pendingTelemetryCount -= 1;
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
    await service.callApi('recordTrajectoryAnalytics', payload);
    this.telemetryLogStore?.markTrajectorySent?.(telemetryEntry);
  }

  buildPayload(context, fingerprint) {
    const payload = createTrajectoryPayloadTemplate();
    const trajectoryId = resolveTrajectoryId(context?.requestId, this.createUuid);
    const cascadeId = this.createUuid();
    const executionId = this.createUuid();
    const initializationStateId = this.createUuid();
    const responseId = buildResponseId(context?.requestId, this.createUuid);
    const sessionId = resolveSessionId(context);
    const telemetryMode = resolveTelemetryMode(context);

    const startAt = toIsoTime(context?.timing?.startTime, this.now());
    const firstTokenAt = toIsoTime(
      Number.isFinite(context?.timing?.startTime) && Number.isFinite(context?.firstTokenLatencyMs)
        ? context.timing.startTime + context.firstTokenLatencyMs
        : context?.timing?.endTime,
      this.now()
    );
    const endAt = toIsoTime(context?.timing?.endTime, this.now());

    const requestText = resolvePromptInputText(context);
    const requestPrompt = buildRequestPrompt(requestText, this.now(), telemetryMode, context);
    const conversationHistoryPrompt = buildConversationHistoryPrompt(context, telemetryMode);
    const responseText = maskSensitiveContent(resolveResponseText(context));
    const userInformationPrompt = createUserInformationPrompt(fingerprint, context);
    const artifactsPrompt = createArtifactsPrompt(cascadeId, fingerprint);

    const trajectory = payload.trajectory;
    trajectory.cascadeId = cascadeId;
    trajectory.trajectoryId = trajectoryId;
    trajectory.metadata.createdAt = startAt;
    trajectory.metadata.initializationStateId = initializationStateId;

    const executorMetadata = trajectory.executorMetadatas?.[0];
    if (executorMetadata) {
      executorMetadata.executionId = executionId;
      executorMetadata.lastStepIdx = Math.max((trajectory.steps?.length || 1) - 1, 1);
      executorMetadata.terminationReason = context?.error
        ? 'EXECUTOR_TERMINATION_REASON_ERROR'
        : 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL';
    }

    const generatorMetadata = trajectory.generatorMetadata?.[0];
    const chatModel = generatorMetadata?.chatModel;
    if (!generatorMetadata || !chatModel) {
      return payload;
    }

    generatorMetadata.executionId = executionId;
    generatorMetadata.stepIndices = [4];
    if (generatorMetadata.plannerConfig) {
      generatorMetadata.plannerConfig.modelName = context?.model || generatorMetadata.plannerConfig.modelName;
    }

    chatModel.responseModel = context?.model || chatModel.responseModel;
    chatModel.streamingDuration = formatDurationMs(context?.streamingDuration ?? context?.latencyMs ?? 0);
    chatModel.timeToFirstToken = formatDurationMs(context?.firstTokenLatencyMs ?? 0);

    if (chatModel.messagePrompts?.[0]) {
      chatModel.messagePrompts[0].prompt = userInformationPrompt;
    }
    if (chatModel.messagePrompts?.[1]) {
      chatModel.messagePrompts[1].prompt = artifactsPrompt;
    }
    if (chatModel.messagePrompts?.[4]) {
      chatModel.messagePrompts[4].prompt = requestPrompt.prompt;
      chatModel.messagePrompts[4].numTokens = requestPrompt.tokenCount;
      chatModel.messagePrompts[4].safeForCodeTelemetry = true;
    }
    if (chatModel.messagePrompts?.[5]) {
      chatModel.messagePrompts[5].prompt = conversationHistoryPrompt;
      chatModel.messagePrompts[5].numTokens = estimateTokenCount(conversationHistoryPrompt);
    }
    if (chatModel.messagePrompts?.[6]) {
      chatModel.messagePrompts[6].prompt = responseText || '';
      chatModel.messagePrompts[6].thinking = '';
      chatModel.messagePrompts[6].thinkingSignature = '';
    }

    if (chatModel.promptSections?.[1]) {
      chatModel.promptSections[1].dynamicContent = userInformationPrompt;
    }
    if (chatModel.promptSections?.[5]) {
      chatModel.promptSections[5].dynamicContent = artifactsPrompt;
    }

    const inputTokens = computeInputTokens(chatModel.messagePrompts);
    const outputTokens = String(context?.responseTokenCount ?? 0);
    const usage = {
      ...chatModel.usage,
      inputTokens: String(inputTokens),
      outputTokens,
      responseOutputTokens: outputTokens,
      responseId,
      responseHeader: sessionId ? { sessionID: sessionId } : {},
    };
    chatModel.usage = usage;

    if (chatModel.retryInfos?.[0]) {
      chatModel.retryInfos[0].traceId = context?.traceId || chatModel.retryInfos[0].traceId;
      chatModel.retryInfos[0].usage = {
        ...chatModel.retryInfos[0].usage,
        ...usage,
      };
    }

    if (chatModel.chatStartMetadata) {
      chatModel.chatStartMetadata.createdAt = startAt;
      if (chatModel.chatStartMetadata.contextWindowMetadata) {
        chatModel.chatStartMetadata.contextWindowMetadata.estimatedTokensUsed = inputTokens;
      }
      if (chatModel.chatStartMetadata.systemPromptCache) {
        chatModel.chatStartMetadata.systemPromptCache.contentChecksum = createContentChecksum(
          chatModel.promptSections?.[0]?.content || chatModel.systemPrompt || ''
        );
      }
      if (Array.isArray(chatModel.chatStartMetadata.cacheBreakpoints) && chatModel.chatStartMetadata.cacheBreakpoints[0]) {
        chatModel.chatStartMetadata.cacheBreakpoints[0].contentChecksum = createContentChecksum(
          chatModel.messagePrompts?.[1]?.prompt || ''
        );
      }
    }

    const userStep = trajectory.steps?.find(step => step.type === 'CORTEX_STEP_TYPE_USER_INPUT');
    if (userStep?.userInput) {
      userStep.userInput.items = [{ text: requestPrompt.userPrompt }];
      userStep.userInput.userResponse = requestPrompt.userPrompt;
      if (userStep.userInput.userConfig?.plannerConfig) {
        userStep.userInput.userConfig.plannerConfig.modelName =
          context?.model || userStep.userInput.userConfig.plannerConfig.modelName;
      }
      updateStepMetadata(userStep, {
        createdAt: startAt,
        completedAt: startAt,
        executionId,
        cascadeId,
        trajectoryId,
      });
    }

    const conversationStep = trajectory.steps?.find(step => step.type === 'CORTEX_STEP_TYPE_CONVERSATION_HISTORY');
    if (conversationStep) {
      if (conversationStep.conversationHistory) {
        conversationStep.conversationHistory.content = conversationHistoryPrompt.replace(/^Step Id: 1\n/, '');
      }
      updateStepMetadata(conversationStep, {
        createdAt: startAt,
        runningAt: startAt,
        completedAt: startAt,
        executionId,
        cascadeId,
        trajectoryId,
        stepIndex: 1,
      });
    }

    const knowledgeStep = trajectory.steps?.find(step => step.type === 'CORTEX_STEP_TYPE_KNOWLEDGE_ARTIFACTS');
    if (knowledgeStep) {
      updateStepMetadata(knowledgeStep, {
        createdAt: startAt,
        runningAt: startAt,
        completedAt: startAt,
        executionId,
        cascadeId,
        trajectoryId,
        stepIndex: 2,
      });
    }

    const ephemeralStep = trajectory.steps?.find(step => step.type === 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE');
    if (ephemeralStep) {
      updateStepMetadata(ephemeralStep, {
        createdAt: startAt,
        runningAt: startAt,
        completedAt: startAt,
        executionId,
        cascadeId,
        trajectoryId,
        stepIndex: 3,
      });
    }

    const plannerStep = trajectory.steps?.find(step => step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
    if (plannerStep?.plannerResponse) {
      plannerStep.plannerResponse.response = responseText || '';
      plannerStep.plannerResponse.modifiedResponse = responseText || '';
      plannerStep.plannerResponse.thinking = '';
      plannerStep.plannerResponse.thinkingSignature = '';
      plannerStep.plannerResponse.thinkingDuration = formatDurationMs(context?.thinkingDurationMs ?? 0);
      if (context?.error) {
        plannerStep.plannerResponse.stopReason = 'STOP_REASON_ERROR';
      }
      updateStepMetadata(plannerStep, {
        createdAt: startAt,
        runningAt: firstTokenAt,
        completedAt: endAt,
        finishedGeneratingAt: endAt,
        viewableAt: firstTokenAt,
        executionId,
        cascadeId,
        trajectoryId,
        stepIndex: 4,
      });
    }

    const checkpointStep = trajectory.steps?.find(step => step.type === 'CORTEX_STEP_TYPE_CHECKPOINT');
    if (checkpointStep) {
      updateStepMetadata(checkpointStep, {
        createdAt: endAt,
        runningAt: endAt,
        executionId,
        cascadeId,
        trajectoryId,
        stepIndex: 5,
        metadataIndex: 1,
      });
    }

    payload.metadata = {
      ...payload.metadata,
      ...fingerprint,
    };

    return payload;
  }
}
