// Shared types & constants for AXION AI CLI

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;          // function/tool name for tool results
  toolCallId?: string;    // internal correlation ID for tool results
  providerCallId?: string; // provider-issued function call ID (Google functionResponse.id)
  toolCalls?: ToolCall[]; // assistant message requesting tools
  providerParts?: unknown[]; // raw provider parts; needed to preserve Gemini thought signatures
  timestamp?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerCallId?: string;
  thoughtSignature?: string;
}

export interface ToolParamSchema {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
  items?: ToolParamSchema;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParamSchema>;
    required?: string[];
  };
}

export type AccessScope = 'workspace' | 'global';

export interface ToolExecutionContext {
  permissions: PermissionSettings;
  cwd: string;
  accessScope: AccessScope;
  notice?: (msg: string) => void;
  confirm?: (question: string) => Promise<boolean>; // explicit Yes/No confirmation for dangerous actions
  abortSignal?: AbortSignal;                         // cancellation (ESC)
  dangerousActionPolicy?: DangerousActionPolicy;
  verbose?: boolean;
}

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface PermissionSettings {
  webAccess: boolean;
  searchAccess: boolean;
  shellExec: boolean;
  fileRead: boolean;
  fileWrite: boolean;
}

export type ProviderType = 'google-ai-studio' | 'openai-compatible';
export interface CustomProvider {
  id: string;            // unique slug; used as the activeProvider value when selected
  name: string;          // user-facing display name
  baseUrl: string;       // OpenAI-compatible chat completions endpoint base
  apiKey: string;
  defaultModel?: string; // optional model selected by default when this provider is active
}
export type DangerousActionPolicy = 'always-ask' | 'always-allow' | 'always-deny';

export interface CustomModel {
  id: string;      // model basename/model ID sent to the provider
  label: string;   // user-facing model name
  provider: ProviderType;
  providerId?: string; // exact registered provider id; required to associate a model with a custom provider
  baseUrl?: string; // optional per-model OpenAI-compatible endpoint
}

export interface AxionConfig {
  version: 1;
  language: 'en' | 'id';
  activeProvider: string;            // ProviderType or a CustomProvider.id
  google: { apiKey: string };
  openaiCompatible: { baseUrl: string; apiKey: string };
  model: string;                 // currently selected model id
  customModels: CustomModel[];
  customProviders: CustomProvider[];
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;          // LEGACY: migrated to customInstructions on load
  customInstructions: string;    // user-provided additional instructions (base system prompt is locked)
  permissions: PermissionSettings;
  dangerousActionPolicy: DangerousActionPolicy;
  verbose: boolean;              // when false, tool/file changes are summarized (not raw content)
  accessScope: AccessScope;
  maxToolCallsPerRequest: number; // 0 = unlimited; positive values are optional per-request execution budgets
  maxInputTokens?: number;   // optional soft cap on input context (estimated as chars/4; oldest non-system messages trimmed first)
  maxOutputTokens?: number;  // optional cap forwarded to the provider as maxOutputTokens / max_tokens
  hasCompletedOnboarding: boolean;
}

// Streaming chunk events emitted by providers (used for the dynamic status indicator).
export interface ProviderChunkEvent {
  type: 'start' | 'delta' | 'tool_call' | 'done';
  text?: string;      // incremental text delta (when type === 'delta')
  toolName?: string;  // name of the detected tool call (when type === 'tool_call')
}
export interface ProviderChatOptions {
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onChunk?: (event: ProviderChunkEvent) => void; // invoked on every streamed chunk / heartbeat
}

// Mask an API key for display: keep only the last 4 characters.
export function maskApiKey(key: string): string {
  const k = key || '';
  if (k.length <= 4) return '****';
  return `****${k.slice(-4)}`;
}

export interface ProviderChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  providerParts?: unknown[];
}

// Owner-specified default models (from project spec).
export const DEFAULT_MODELS: CustomModel[] = [
  { id: 'gemma-4-31b-it',        label: 'Gemma 4 31B IT',        provider: 'google-ai-studio' },
  { id: 'gemma-4-26b-a4b-it',    label: 'Gemma 4 26B A4B IT',    provider: 'google-ai-studio' },
  { id: 'gemini-3.5-flash',      label: 'Gemini 3.5 Flash',      provider: 'google-ai-studio' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', provider: 'google-ai-studio' },
  { id: 'gemini-3.8-flash',      label: 'Gemini 3.8 Flash',      provider: 'google-ai-studio' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', provider: 'google-ai-studio' },
];

export const DEFAULT_MODEL_ID = 'gemini-3.5-flash';

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  webAccess: true,
  searchAccess: true,
  shellExec: true, // owner requested shell execution enabled by default
  fileRead: true,
  fileWrite: false,
};

export const THINKING_BUDGET: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  low: 1024,
  medium: 4096,
  high: 10240,
  max: -1, // dynamic
};

export const USER_AGENT =
  'Mozilla/5.0 (compatible; AxionAICLI/1.0.2; +https://github.com/azrielspace852-wq/axion-ai-agents-cli)';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';