import fs from 'fs';
import {
  AXN_DIR,
  CONFIG_PATH,
  MEMORY_DIR,
  CONVERSATIONS_DIR,
  INSTRUCTIONS_DIR,
} from './paths';
import {
  AxionConfig,
  DEFAULT_PERMISSIONS,
  DEFAULT_MODEL_ID,
  ThinkingLevel,
  CustomModel,
  CustomProvider,
  DangerousActionPolicy,
} from '../types';
import { ensurePrivateDir, writeJsonAtomically } from '../utils/jsonFile';

export const DEFAULT_CONFIG: AxionConfig = {
  version: 1,
  language: 'en',
  activeProvider: 'google-ai-studio',
  google: { apiKey: '' },
  openaiCompatible: { baseUrl: '', apiKey: '' },
  model: DEFAULT_MODEL_ID,
  customModels: [],
  customProviders: [],
  thinkingLevel: 'medium',
  systemPrompt: '',           // LEGACY field, retained for backward-compatible reads
  customInstructions: '',     // user-provided additional instructions (base prompt is locked)
  permissions: { ...DEFAULT_PERMISSIONS },
  dangerousActionPolicy: 'always-ask',
  verbose: false,
  accessScope: 'workspace',
  maxToolCallsPerRequest: 0,
  maxInputTokens: undefined,
  maxOutputTokens: undefined,
  hasCompletedOnboarding: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
function normalizeTokenLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 1 ? n : undefined;
}
function parseCustomModels(value: unknown): CustomModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CustomModel => {
    if (!isRecord(item)) return false;
    return typeof item.id === 'string' && item.id.trim().length > 0 &&
      typeof item.label === 'string' &&
      (item.provider === 'google-ai-studio' || item.provider === 'openai-compatible');
  }).map((item) => ({
    id: item.id.trim(),
    label: item.label.trim() || item.id.trim(),
    provider: item.provider,
    ...(typeof item.providerId === 'string' && item.providerId.trim() ? { providerId: item.providerId.trim() } : {}),
    ...(typeof item.baseUrl === 'string' && item.baseUrl.trim() ? { baseUrl: item.baseUrl.trim() } : {}),
  }));
}
function isValidProviderEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch { return false; }
}

function parseCustomProviders(value: unknown): CustomProvider[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CustomProvider[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '';
    if (!id || seen.has(id)) continue; // uniqueness enforced; duplicates dropped
    seen.add(id);
    if (typeof item.baseUrl !== 'string' || !isValidProviderEndpoint(item.baseUrl.trim())) continue;
    out.push({
      id,
      name: (typeof item.name === 'string' && item.name.trim()) ? item.name.trim() : id,
      baseUrl: item.baseUrl.trim().replace(/\/$/, ''),
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      ...(typeof item.defaultModel === 'string' && item.defaultModel.trim() ? { defaultModel: item.defaultModel.trim() } : {}),
    });
  }
  return out;
}

const BUILTIN_PROVIDERS = new Set(['google-ai-studio', 'openai-compatible']);

function normalizeConfig(value: unknown, existingConfig: boolean): AxionConfig {
  const parsed = isRecord(value) ? value : {};
  const google = isRecord(parsed.google) ? parsed.google : {};
  const openai = isRecord(parsed.openaiCompatible) ? parsed.openaiCompatible : {};
  const permissions = isRecord(parsed.permissions) ? parsed.permissions : {};
  const customProviders = parseCustomProviders(parsed.customProviders);
  const customProviderIds = new Set(customProviders.map((p) => p.id));

  // activeProvider: a built-in id OR a custom-provider id; anything else resets to default.
  let activeProvider: string = DEFAULT_CONFIG.activeProvider;
  if (typeof parsed.activeProvider === 'string' && parsed.activeProvider.trim()) {
    const ap = parsed.activeProvider.trim();
    if (BUILTIN_PROVIDERS.has(ap) || customProviderIds.has(ap)) activeProvider = ap;
  }

  const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
  const requestedLevel = parsed.thinkingLevel;
  const policies: DangerousActionPolicy[] = ['always-ask', 'always-allow', 'always-deny'];
  const requestedPolicy = parsed.dangerousActionPolicy;

  // Legacy migration: systemPrompt / instructions → customInstructions.
  const customInstructions = stringValue(
    parsed.customInstructions,
    stringValue(parsed.systemPrompt, stringValue(parsed.instructions, '')),
  );

  return {
    version: 1,
    language: parsed.language === 'id' ? 'id' : 'en',
    activeProvider,
    google: { apiKey: stringValue(google.apiKey, '') },
    openaiCompatible: {
      baseUrl: stringValue(openai.baseUrl, ''),
      apiKey: stringValue(openai.apiKey, ''),
    },
    model: stringValue(parsed.model, DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID,
    customModels: parseCustomModels(parsed.customModels).filter((model) => {
      if (!model.providerId) return true;
      if (model.providerId === 'google-ai-studio') return model.provider === 'google-ai-studio';
      if (model.providerId === 'openai-compatible') return model.provider === 'openai-compatible';
      return model.provider === 'openai-compatible' && customProviderIds.has(model.providerId);
    }),
    customProviders,
    thinkingLevel: levels.includes(requestedLevel as ThinkingLevel)
      ? requestedLevel as ThinkingLevel
      : DEFAULT_CONFIG.thinkingLevel,
    systemPrompt: '', // legacy field always normalized empty
    customInstructions,
    accessScope: parsed.accessScope === 'global' ? 'global' : 'workspace',
    dangerousActionPolicy: policies.includes(requestedPolicy as DangerousActionPolicy)
      ? (requestedPolicy as DangerousActionPolicy)
      : DEFAULT_CONFIG.dangerousActionPolicy,
    verbose: typeof parsed.verbose === 'boolean' ? parsed.verbose : DEFAULT_CONFIG.verbose,
    // 0 means unlimited. Positive safe integers configure an explicit per-request budget.
    maxToolCallsPerRequest: Number.isSafeInteger(parsed.maxToolCallsPerRequest) && Number(parsed.maxToolCallsPerRequest) >= 0
      ? Number(parsed.maxToolCallsPerRequest)
      : DEFAULT_CONFIG.maxToolCallsPerRequest,
    maxInputTokens: normalizeTokenLimit(parsed.maxInputTokens),
    maxOutputTokens: normalizeTokenLimit(parsed.maxOutputTokens),
    // Existing installations are treated as already onboarded; only a fresh config sees first-run help.
    hasCompletedOnboarding: typeof parsed.hasCompletedOnboarding === 'boolean'
      ? parsed.hasCompletedOnboarding
      : existingConfig,
    permissions: {
      webAccess: typeof permissions.webAccess === 'boolean' ? permissions.webAccess : DEFAULT_PERMISSIONS.webAccess,
      searchAccess: typeof permissions.searchAccess === 'boolean' ? permissions.searchAccess : DEFAULT_PERMISSIONS.searchAccess,
      shellExec: typeof permissions.shellExec === 'boolean' ? permissions.shellExec : DEFAULT_PERMISSIONS.shellExec,
      fileRead: typeof permissions.fileRead === 'boolean' ? permissions.fileRead : DEFAULT_PERMISSIONS.fileRead,
      fileWrite: typeof permissions.fileWrite === 'boolean' ? permissions.fileWrite : DEFAULT_PERMISSIONS.fileWrite,
    },
  };
}

export class ConfigManager {
  private config: AxionConfig;
  constructor() {
    this.ensureDirs();
    this.config = this.load();
  }
  private ensureDirs(): void {
    for (const dir of [AXN_DIR, MEMORY_DIR, CONVERSATIONS_DIR, INSTRUCTIONS_DIR]) {
      ensurePrivateDir(dir);
    }
  }
  private load(): AxionConfig {
    if (!fs.existsSync(CONFIG_PATH)) return normalizeConfig(DEFAULT_CONFIG, false);
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return normalizeConfig(JSON.parse(raw) as unknown, true);
    } catch {
      // Preserve a damaged file for diagnosis before falling back to safe defaults.
      try {
        const backup = `${CONFIG_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(CONFIG_PATH, backup);
        try { fs.chmodSync(backup, 0o600); } catch { /* best effort */ }
      } catch {
        // The fallback configuration remains usable even if a backup cannot be made.
      }
      return normalizeConfig(DEFAULT_CONFIG, true);
    }
  }
  get(): AxionConfig {
    return this.config;
  }
  needsOnboarding(): boolean {
    return !this.config.hasCompletedOnboarding;
  }
  save(): void {
    this.ensureDirs();
    writeJsonAtomically(CONFIG_PATH, this.config);
  }
  update(patch: Partial<AxionConfig>): void {
    this.config = normalizeConfig({ ...this.config, ...patch }, true);
    this.save();
  }
}
