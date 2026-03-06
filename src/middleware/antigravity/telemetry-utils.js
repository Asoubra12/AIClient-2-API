import crypto from 'crypto';
import { readFileSync } from 'fs';

const METRICS_TEMPLATE_URL = new URL('../../../tools/security-poc/payloads/recordCodeAssistMetrics.json', import.meta.url);
const TRAJECTORY_TEMPLATE_URL = new URL('../../../tools/security-poc/payloads/recordTrajectoryAnalytics.json', import.meta.url);

function loadJsonTemplate(url) {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const METRICS_TEMPLATE = loadJsonTemplate(METRICS_TEMPLATE_URL);
const TRAJECTORY_TEMPLATE = loadJsonTemplate(TRAJECTORY_TEMPLATE_URL);

export function createMetricsPayloadTemplate() {
  if (!METRICS_TEMPLATE) {
    throw new Error(`Missing telemetry template: ${METRICS_TEMPLATE_URL.pathname}`);
  }
  return cloneJson(METRICS_TEMPLATE);
}

export function createTrajectoryPayloadTemplate() {
  if (!TRAJECTORY_TEMPLATE) {
    throw new Error(`Missing telemetry template: ${TRAJECTORY_TEMPLATE_URL.pathname}`);
  }
  return cloneJson(TRAJECTORY_TEMPLATE);
}

export function randomHex(size = 8) {
  return crypto.randomBytes(size).toString('hex');
}

export function createNanoTimestamp(date = new Date()) {
  const iso = date.toISOString();
  const [base, fractionWithZone] = iso.split('.');
  const fraction = (fractionWithZone || '000Z').replace('Z', '');
  return `${base}.${fraction.padEnd(3, '0')}000000Z`;
}

export function formatDurationMs(durationMs = 0) {
  const safeDurationMs = Math.max(0, Number(durationMs) || 0);
  const totalNanoseconds = Math.round(safeDurationMs * 1_000_000);
  const seconds = Math.floor(totalNanoseconds / 1_000_000_000);
  const nanoseconds = totalNanoseconds % 1_000_000_000;
  return `${seconds}.${String(nanoseconds).padStart(9, '0')}s`;
}

export function resolveTelemetryService(context) {
  return context?.service?.antigravityApiService || context?.service || null;
}

export function resolveProject(context) {
  const service = resolveTelemetryService(context);
  return service?.projectId ||
    context?.serviceConfig?.PROJECT_ID ||
    context?.config?.PROJECT_ID ||
    context?.config?.projectId ||
    context?.requestBody?.project ||
    null;
}

export function resolveAccountEmail(context) {
  const service = resolveTelemetryService(context);
  return service?.accountEmail ||
    context?.serviceConfig?.ANTIGRAVITY_ACCOUNT_EMAIL ||
    context?.accountEmail ||
    context?.uuid ||
    'unknown-account';
}

export function resolveTelemetryMode(context) {
  const mode = context?.serviceConfig?.telemetryMode ||
    context?.config?.telemetryMode ||
    'redacted';
  return ['full', 'redacted', 'off'].includes(mode) ? mode : 'redacted';
}

export function shouldSkipTelemetry(context) {
  return resolveTelemetryMode(context) === 'off';
}

export function resolveRequestType(context) {
  return context?.requestBody?.requestType ||
    context?.requestBody?.request?.requestType ||
    'agent';
}

export function resolveSessionId(context) {
  return context?.requestBody?._middlewareSessionId ||
    context?.requestBody?.sessionId ||
    context?.requestBody?.request?.sessionId ||
    null;
}

export function resolveTrajectoryId(requestId, createUuid) {
  if (typeof requestId === 'string') {
    const parts = requestId.split('/');
    if (parts.length >= 3 && parts[2]) {
      return parts[2];
    }
  }
  return createUuid();
}

export function buildResponseId(requestId, createUuid) {
  if (typeof requestId === 'string' && requestId.startsWith('req_vrtx_')) {
    return requestId;
  }
  return `req_vrtx_${createUuid().replace(/-/g, '').slice(0, 24)}`;
}

export function estimateTokenCount(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  return Math.max(1, Math.ceil(text.trim().length / 4));
}

export function maskSensitiveContent(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, '[API_KEY]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[API_KEY]')
    .replace(/ghp_[A-Za-z0-9_]+/g, '[API_KEY]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})[^\s]*/g, '[PRIVATE_URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
}

function flattenParts(parts = []) {
  return parts
    .map(part => part?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function extractPromptMessages(context) {
  const contents = context?.requestBody?.contents ||
    context?.requestBody?.request?.contents ||
    context?.originalRequestBody?.contents ||
    context?.originalRequestBody?.request?.contents ||
    [];

  if (!Array.isArray(contents)) {
    return [];
  }

  return contents
    .map((content, index) => {
      const text = flattenParts(content?.parts);
      if (!text) {
        return null;
      }

      return {
        index,
        role: content?.role || 'user',
        text,
      };
    })
    .filter(Boolean);
}

export function buildTelemetryPromptText(text, telemetryMode = 'redacted') {
  const maskedText = maskSensitiveContent(text);
  const tokenCount = estimateTokenCount(text);

  if (telemetryMode !== 'full') {
    return {
      prompt: `[REDACTED: ${tokenCount} tokens]`,
      tokenCount,
    };
  }

  return {
    prompt: maskedText,
    tokenCount,
  };
}

export function resolvePromptInputText(context) {
  const messages = extractPromptMessages(context)
    .filter(message => message.role !== 'model' && message.role !== 'system');

  if (messages.length === 0) {
    return '';
  }

  return messages.map(message => message.text).join('\n\n').trim();
}

export function resolveResponseText(context) {
  if (typeof context?.responseText === 'string' && context.responseText.trim()) {
    return context.responseText.trim();
  }

  if (typeof context?.error?.message === 'string' && context.error.message.trim()) {
    return `Generation failed: ${context.error.message.trim()}`;
  }

  return '';
}

function resolveUserStateDescription(context) {
  return context?.userStateDescription ||
    context?.requestBody?._telemetryUserState ||
    context?.requestBody?.request?._telemetryUserState ||
    context?.originalRequestBody?._telemetryUserState ||
    context?.originalRequestBody?.request?._telemetryUserState ||
    'No browser pages are currently open.';
}

function resolveWorkspacePath(context) {
  return context?.workspacePath ||
    context?.requestBody?.workspacePath ||
    context?.requestBody?.request?.workspacePath ||
    context?.originalRequestBody?.workspacePath ||
    context?.originalRequestBody?.request?.workspacePath ||
    process.cwd();
}

function resolveConversationSummaries(context) {
  const summarySources = [
    context?.conversationSummaries,
    context?.requestBody?.conversationSummaries,
    context?.requestBody?.request?.conversationSummaries,
    context?.originalRequestBody?.conversationSummaries,
    context?.originalRequestBody?.request?.conversationSummaries,
  ];

  for (const value of summarySources) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function formatConversationTimestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return 'unknown';
}

function buildConversationSummaryField(value, telemetryMode, fallback) {
  const sourceText = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return buildTelemetryPromptText(sourceText, telemetryMode).prompt;
}

export function buildConversationHistoryPrompt(context, telemetryMode = 'redacted') {
  const summaries = resolveConversationSummaries(context).slice(0, 7);

  if (summaries.length === 0) {
    return `Step Id: 1\n# Conversation History\nHere are the conversation IDs, titles, and summaries of your most recent 0 conversations, in reverse chronological order:\n\n<conversation_summaries>\nNo recent conversation summaries are available.\n</conversation_summaries>`;
  }

  const renderedSummaries = summaries.map((summary, index) => {
    const conversationId = summary?.id ||
      summary?.conversationId ||
      summary?.uuid ||
      `summary-${index + 1}`;
    const title = buildConversationSummaryField(
      summary?.title || summary?.conversationTitle || summary?.name,
      telemetryMode,
      'Untitled Conversation'
    );
    const objective = buildConversationSummaryField(
      summary?.objective || summary?.userObjective || summary?.summary || summary?.description,
      telemetryMode,
      'No objective summary is available.'
    );
    const detail = summary?.summary || summary?.description || summary?.content || '';
    const detailBlock = detail
      ? `\n${buildConversationSummaryField(detail, telemetryMode, '')}`
      : '';

    return `## Conversation ${conversationId}: ${title}\n- Created: ${formatConversationTimestamp(summary?.createdAt || summary?.created_at)}\n- Last modified: ${formatConversationTimestamp(summary?.updatedAt || summary?.updated_at || summary?.lastModifiedAt || summary?.last_modified_at)}\n\n### USER Objective:\n${objective}${detailBlock}`;
  });

  return `Step Id: 1\n# Conversation History\nHere are the conversation IDs, titles, and summaries of your most recent ${summaries.length} conversations, in reverse chronological order:\n\n<conversation_summaries>\n${renderedSummaries.join('\n\n')}\n</conversation_summaries>`;
}

export function buildRequestPrompt(text, now = new Date(), telemetryMode = 'redacted', context = null) {
  const promptText = buildTelemetryPromptText(text, telemetryMode);
  return {
    prompt: `Step Id: 0\n\n<USER_REQUEST>\n${promptText.prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${now.toISOString()}. This is the latest source of truth for time; do not attempt to get the time any other way.\n\nThe user's current state is as follows:\n${resolveUserStateDescription(context)}\n</ADDITIONAL_METADATA>`,
    tokenCount: promptText.tokenCount,
    userPrompt: promptText.prompt,
  };
}

export function createContentChecksum(text = '') {
  return crypto.createHash('md5').update(String(text)).digest('hex').slice(0, 8);
}

export function createUserInformationPrompt(fingerprint, context = null) {
  const workspacePath = resolveWorkspacePath(context);
  const normalizedWorkspacePath = workspacePath.replace(/\\/g, '/');
  const os = fingerprint?.os || 'windows';

  return `<user_information>\nThe USER's OS version is ${os}.\nThe user has 1 active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:\n${workspacePath} -> ${normalizedWorkspacePath}\nCode relating to the user's requests should be written in the locations listed above. Avoid writing project code files to tmp, in the .gemini dir, or directly to the Desktop and similar folders unless explicitly asked.\n</user_information>`;
}

export function createArtifactsPrompt(cascadeId, fingerprint) {
  const os = fingerprint?.os || 'windows';

  if (os === 'windows') {
    return `<artifacts>\nArtifact Directory Path: C:\\Users\\REDACTED_USER\\.gemini\\antigravity\\brain\\${cascadeId}\n</artifacts>`;
  }

  if (os === 'darwin') {
    return `<artifacts>\nArtifact Directory Path: /Users/REDACTED_USER/.gemini/antigravity/brain/${cascadeId}\n</artifacts>`;
  }

  return `<artifacts>\nArtifact Directory Path: /home/REDACTED_USER/.gemini/antigravity/brain/${cascadeId}\n</artifacts>`;
}

export function buildConversationOfferedStatus(context) {
  return context?.error ? 'ACTION_STATUS_ERROR' : 'ACTION_STATUS_NO_ERROR';
}
