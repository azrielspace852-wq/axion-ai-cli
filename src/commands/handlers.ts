import chalk from 'chalk';
import { CommandContext, HandlerResult } from './CommandContext';
import {
  DEFAULT_MODELS,
  CustomModel,
  ProviderType,
  ThinkingLevel,
  PermissionSettings,
  maskApiKey,
} from '../types';
import { t, setLanguage } from '../i18n';

async function choose(ctx: CommandContext, prompt: string, options: string[], activeIndex?: number): Promise<number | null> {
  return ctx.repl.select(prompt, options, activeIndex);
}

function promptValue(ctx: CommandContext, prompt: string, current: string): Promise<string> {
  return ctx.repl.question(`${prompt} [${current}]: `);
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

interface RegisteredModelProvider {
  id: string;
  name: string;
  transport: ProviderType;
  custom: boolean;
}

function registeredModelProviders(ctx: CommandContext): RegisteredModelProvider[] {
  return [
    { id: 'google-ai-studio', name: 'Google AI Studio', transport: 'google-ai-studio', custom: false },
    { id: 'openai-compatible', name: 'OpenAI-compatible (built-in)', transport: 'openai-compatible', custom: false },
    ...(ctx.config.customProviders || []).map((provider) => ({
      id: provider.id,
      name: `${provider.name} (${provider.id})`,
      transport: 'openai-compatible' as ProviderType,
      custom: true,
    })),
  ];
}

function validModelId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f]/.test(value);
}

function hasUsableProviderCredentials(ctx: CommandContext, provider: RegisteredModelProvider): boolean {
  if (provider.id === 'google-ai-studio') return Boolean(ctx.config.google.apiKey.trim());
  if (provider.id === 'openai-compatible') {
    return validHttpUrl(ctx.config.openaiCompatible.baseUrl) && Boolean(ctx.config.openaiCompatible.apiKey.trim());
  }
  const registered = (ctx.config.customProviders || []).find((item) => item.id === provider.id);
  return Boolean(registered && validHttpUrl(registered.baseUrl) && registered.apiKey.trim());
}

export async function handleModels(ctx: CommandContext): Promise<HandlerResult | void> {
  const actions = await choose(ctx, 'Custom model management', [
    'Select a model', 'Add custom model', 'Edit custom model', 'Delete custom model', 'Cancel',
  ]);
  if (actions === null || actions === 4) return;
  if (actions === 1) return addCustomModel(ctx);
  if (actions === 2) return editCustomModel(ctx);
  if (actions === 3) return deleteCustomModel(ctx);

  const active = ctx.config.activeProvider;
  const all: CustomModel[] = [...DEFAULT_MODELS, ...ctx.config.customModels].filter((model) => (model.providerId || model.provider) === active);
  if (!all.length) return ctx.repl.print(`No models available for provider "${active}". Add one with "Add custom model" or switch provider with /provider.`);
  const activeModelIdx = all.findIndex((model) => model.id === ctx.config.model);
  const selected = await choose(ctx, `Select model (provider: ${active})`, [
    ...all.map((model) => `${model.label} (${model.id})`),
    'Cancel',
  ], activeModelIdx >= 0 ? activeModelIdx : undefined);
  if (selected === null || selected >= all.length) return;
  const model = all[selected];
  ctx.config.model = model.id;
  ctx.config.activeProvider = model.providerId || model.provider;
  ctx.saveConfig();
  ctx.repl.print(`Model set to ${model.label}.`);
}

async function addCustomModel(ctx: CommandContext): Promise<void> {
  const id = (await ctx.repl.question('Model basename / provider model ID: ')).trim();
  if (!id) return ctx.repl.print('Cancelled.');
  if (!validModelId(id)) return ctx.repl.print('Invalid model ID. Use 1–200 characters without whitespace or control characters.');
  if (ctx.config.customModels.some((model) => model.id === id) || DEFAULT_MODELS.some((model) => model.id === id)) {
    return ctx.repl.print('A model with that basename already exists.');
  }
  const label = (await ctx.repl.question('Model display name (maximum 100 characters): ')).trim() || id;
  if (label.length > 100 || /[\u0000-\u001f]/.test(label)) return ctx.repl.print('Invalid model display name. Use at most 100 characters without control characters.');

  const providers = registeredModelProviders(ctx);
  const activeProvider = providers.find((provider) => provider.id === ctx.config.activeProvider);
  if (!activeProvider) return ctx.repl.print('The active provider is not registered. Select a registered provider with /provider first.');
  const otherProviders = providers.filter((provider) => provider.id !== activeProvider.id);
  const options = [
    `Use active provider (${activeProvider.name})`,
    ...otherProviders.map((provider) => `Use another registered provider (${provider.name})`),
    'Cancel',
  ];
  const providerIndex = await choose(ctx, `Use provider active (${activeProvider.name}) or another registered provider?`, options, 0);
  if (providerIndex === null || providerIndex === options.length - 1) return;
  const selectedProvider = providerIndex === 0 ? activeProvider : otherProviders[providerIndex - 1];
  if (!selectedProvider) return ctx.repl.print('Invalid provider selection. No changes were saved.');
  if (!hasUsableProviderCredentials(ctx, selectedProvider)) {
    return ctx.repl.print(`Provider ${selectedProvider.name} is not configured with a valid endpoint and API key. Configure it with /provider or /api-key before adding a model.`);
  }

  let baseUrl = '';
  if (selectedProvider.id === 'openai-compatible') {
    baseUrl = (await ctx.repl.question('Optional model-specific base URL (blank uses registered provider settings): ')).trim();
    if (baseUrl && !validHttpUrl(baseUrl)) return ctx.repl.print('Invalid base URL; expected an absolute HTTP/HTTPS URL without embedded credentials.');
  }
  const customModel: CustomModel = {
    id,
    label,
    provider: selectedProvider.transport,
    ...(selectedProvider.custom ? { providerId: selectedProvider.id } : {}),
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/$/, '') } : {}),
  };
  ctx.config.customModels.push(customModel);
  ctx.config.activeProvider = selectedProvider.id;
  ctx.config.model = id;
  ctx.saveConfig();
  ctx.repl.print(`Added and selected custom model "${label}" for registered provider "${selectedProvider.name}".`);
}

async function editCustomModel(ctx: CommandContext): Promise<void> {
  const models = ctx.config.customModels;
  if (!models.length) return ctx.repl.print('No custom models to edit. Built-in models cannot be edited.');
  const index = await choose(ctx, 'Select a custom model to edit', [...models.map((model) => `${model.label} (${model.id})`), 'Cancel']);
  if (index === null || index >= models.length) return;
  const model = models[index];
  const name = (await promptValue(ctx, 'Model name', model.label)).trim();
  if (name && (name.length > 100 || /[\u0000-\u001f]/.test(name))) {
    return ctx.repl.print('Invalid model display name. Use at most 100 characters without control characters.');
  }
  const basename = (await promptValue(ctx, 'Model basename / provider model ID', model.id)).trim();
  if (basename && !validModelId(basename)) return ctx.repl.print('Invalid model ID. No changes were saved.');
  if (basename && basename !== model.id && (models.some((item, i) => i !== index && item.id === basename) || DEFAULT_MODELS.some((item) => item.id === basename))) {
    return ctx.repl.print('That model basename is already in use. No changes were saved.');
  }
  const providers = registeredModelProviders(ctx);
  const currentProviderId = model.providerId || model.provider;
  const currentProviderIndex = providers.findIndex((provider) => provider.id === currentProviderId);
  const providerIndex = await choose(ctx, `Provider (current: ${providers[currentProviderIndex]?.name || currentProviderId})`, [
    ...providers.map((provider) => provider.name), 'Cancel',
  ], currentProviderIndex >= 0 ? currentProviderIndex : undefined);
  if (providerIndex === null || providerIndex >= providers.length) return;
  const nextProvider = providers[providerIndex];
  if (!nextProvider) return;
  if (!hasUsableProviderCredentials(ctx, nextProvider)) {
    return ctx.repl.print(`Provider ${nextProvider.name} is not configured with a valid endpoint and API key. No changes were saved.`);
  }
  let baseUrl = model.baseUrl || '';
  if (nextProvider.id === 'openai-compatible') {
    const nextUrl = (await promptValue(ctx, 'Model-specific base URL (blank clears override)', baseUrl || 'provider default')).trim();
    if (nextUrl) {
      if (!validHttpUrl(nextUrl)) return ctx.repl.print('Invalid base URL. No changes were saved.');
      baseUrl = nextUrl.replace(/\/$/, '');
    } else baseUrl = '';
  } else baseUrl = '';

  const oldId = model.id;
  model.label = name || model.label;
  model.id = basename || model.id;
  model.provider = nextProvider.transport;
  if (nextProvider.custom) model.providerId = nextProvider.id;
  else delete model.providerId;
  if (baseUrl && nextProvider.id === 'openai-compatible') model.baseUrl = baseUrl;
  else delete model.baseUrl;
  if (ctx.config.model === oldId) {
    ctx.config.model = model.id;
    ctx.config.activeProvider = nextProvider.id;
  }
  ctx.saveConfig();
  ctx.repl.print(`Updated custom model "${model.label}" for provider "${nextProvider.name}".`);
}

async function deleteCustomModel(ctx: CommandContext): Promise<void> {
  const models = ctx.config.customModels;
  if (!models.length) return ctx.repl.print('No custom models to delete. Built-in models are protected.');
  const index = await choose(ctx, 'Select a custom model to delete', [...models.map((model) => `${model.label} (${model.id})`), 'Cancel']);
  if (index === null || index >= models.length) return;
  const model = models[index];
  const confirm = await choose(ctx, `Delete custom model "${model.label}"?`, ['Delete', 'Keep']);
  if (confirm !== 0) return;
  ctx.config.customModels.splice(index, 1);
  if (ctx.config.model === model.id) {
    ctx.config.model = DEFAULT_MODELS[0].id;
    ctx.config.activeProvider = DEFAULT_MODELS[0].provider;
  }
  ctx.saveConfig();
  ctx.repl.print(`Deleted custom model "${model.label}". Built-in models were not affected.`);
}

export async function handleThinking(ctx: CommandContext): Promise<HandlerResult | void> {
  const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
  const activeIdx = levels.indexOf(ctx.config.thinkingLevel);
  const selected = await choose(ctx, `Thinking level (current: ${ctx.config.thinkingLevel})`, [...levels, 'Cancel'], activeIdx >= 0 ? activeIdx : undefined);
  if (selected === null || selected >= levels.length) return;
  ctx.config.thinkingLevel = levels[selected];
  ctx.saveConfig();
  ctx.repl.print(`Thinking set to ${levels[selected]}.`);
}

// /system-prompt: view the LOCKED base system prompt + current custom instructions (read-only).
export async function handleViewSystemPrompt(ctx: CommandContext): Promise<HandlerResult | void> {
  ctx.repl.print(chalk.bold('Base system prompt (LOCKED — cannot be edited by the user)'));
  ctx.repl.print(chalk.dim('Core rules: anti-hallucination, workspace awareness, execution transparency, no secrets in output. Custom instructions below are appended and can never override these core rules.'));
  ctx.repl.print('');
  ctx.repl.print(chalk.bold('Current custom instructions (edit with /instructions):'));
  ctx.repl.print(ctx.config.customInstructions || chalk.dim('(none)'));
  ctx.repl.print(chalk.dim('Use /instructions to set or clear custom instructions.'));
}

// /instructions: edit user-provided custom instructions (appended to the locked base prompt).
export async function handleInstructions(ctx: CommandContext): Promise<HandlerResult | void> {
  ctx.repl.print(chalk.bold('Current custom instructions:'));
  ctx.repl.print(ctx.config.customInstructions || chalk.dim('(none)'));
  ctx.repl.print(chalk.dim('Enter inserts a newline. CTRL+X opens save confirmation; Y saves, N or ESC cancels. CTRL+A clears the editor.'));
  const answer = await ctx.repl.editMultiline('Edit custom instructions (the existing text is prefilled):', ctx.config.customInstructions || '');
  if (answer === null) return ctx.repl.print('Custom instructions edit cancelled; no changes were saved.');
  ctx.config.customInstructions = answer.trim().toLowerCase() === 'clear' ? '' : answer;
  ctx.saveConfig();
  ctx.repl.print('Custom instructions saved.');
}

export async function handleVerbose(ctx: CommandContext): Promise<HandlerResult | void> {
  ctx.config.verbose = !ctx.config.verbose;
  ctx.saveConfig();
  ctx.repl.print(`Verbose output: ${ctx.config.verbose ? 'ON (full tool output / diffs)' : 'OFF (summaries only, default)'}`);
}

export async function handleMemory(ctx: CommandContext): Promise<HandlerResult | void> {
  const memories = ctx.memories.list();
  ctx.repl.print(chalk.bold('Long-term memory'));
  if (!memories.length) ctx.repl.print(chalk.dim('(empty)'));
  memories.forEach((topic) => {
    ctx.repl.print(`• ${topic.about} [${topic['memory-id']}]`);
    topic.memories.forEach((entry) => ctx.repl.print(chalk.dim(`  ${entry['memory-number']}. ${entry.content}`)));
  });
  const action = await choose(ctx, 'Memory actions', [
    'Add memory', 'Edit memory entry', 'Delete memory entry', 'Rename topic', 'Delete topic', 'Clear all memory', 'Cancel',
  ]);
  if (action === null || action === 6) return;
  if (action === 5) {
    const confirm = await choose(ctx, 'Delete every saved memory?', ['Delete all', 'Cancel']);
    if (confirm === 0) { ctx.memories.clear(); ctx.repl.print('All memory cleared.'); }
    return;
  }
  if (action === 0) {
    const about = (await ctx.repl.question('Topic / about: ')).trim();
    const content = (await ctx.repl.question('Memory content: ')).trim();
    if (!about || !content) return ctx.repl.print('Topic and content are required.');
    const summarized = await ctx.agent.summarizeForMemory(content);
    ctx.memories.add(about, summarized);
    return ctx.repl.print('Memory saved.');
  }
  if (!memories.length) return;
  const topicIndex = await choose(ctx, 'Select memory topic', [...memories.map((item) => item.about), 'Cancel']);
  if (topicIndex === null || topicIndex >= memories.length) return;
  const topic = memories[topicIndex];
  if (action === 3) {
    const newName = (await promptValue(ctx, 'New topic name', topic.about)).trim();
    if (!newName) return;
    if (!ctx.memories.renameTopic(topic['memory-id'], newName)) return ctx.repl.print('Unable to rename topic.');
    return ctx.repl.print('Memory topic renamed.');
  }
  if (action === 4) {
    const confirm = await choose(ctx, `Delete memory topic "${topic.about}"?`, ['Delete topic', 'Cancel']);
    if (confirm === 0) { ctx.memories.delete(topic['memory-id']); ctx.repl.print('Memory topic deleted.'); }
    return;
  }
  if (!topic.memories.length) return ctx.repl.print('This topic has no memory entries.');
  const entryIndex = await choose(ctx, `Select an entry in "${topic.about}"`, [
    ...topic.memories.map((item) => `${item['memory-number']}. ${item.content}`), 'Cancel',
  ]);
  if (entryIndex === null || entryIndex >= topic.memories.length) return;
  const entry = topic.memories[entryIndex];
  if (action === 1) {
    const next = (await promptValue(ctx, 'Updated memory content', entry.content)).trim();
    if (!next) return ctx.repl.print('Empty content is not saved.');
    ctx.memories.updateEntry(topic['memory-id'], entry['memory-number'], next);
    return ctx.repl.print('Memory entry updated.');
  }
  if (action === 2) {
    const confirm = await choose(ctx, 'Delete this memory entry?', ['Delete entry', 'Cancel']);
    if (confirm === 0) { ctx.memories.deleteEntry(topic['memory-id'], entry['memory-number']); ctx.repl.print('Memory entry deleted.'); }
  }
}

export async function handleApiKey(ctx: CommandContext): Promise<HandlerResult | void> {
  const key = (await ctx.repl.questionSecret(`Enter API key for ${ctx.config.activeProvider}: `)).trim();
  if (!key) return ctx.repl.print('Cancelled.');
  if (ctx.config.activeProvider === 'openai-compatible') ctx.config.openaiCompatible.apiKey = key;
  else ctx.config.google.apiKey = key;
  ctx.saveConfig();
  ctx.repl.print('API key saved.');
}

export async function handlePermissions(ctx: CommandContext): Promise<HandlerResult | void> {
  const keys: (keyof PermissionSettings)[] = ['webAccess', 'searchAccess', 'shellExec', 'fileRead', 'fileWrite'];
  for (;;) {
    const policyLabel = ctx.config.dangerousActionPolicy;
    const options = [
      ...keys.map((key) => `${key}: ${ctx.config.permissions[key] ? 'ON' : 'OFF'}`),
      `Dangerous action policy: ${policyLabel}`,
      `Verbose output: ${ctx.config.verbose ? 'ON' : 'OFF'}`,
      'Save and exit',
    ];
    const selected = await choose(ctx, 'Toggle permissions / policy (Enter/Escape to finish)', options);
    if (selected === null || selected === options.length - 1) break;
    if (selected < keys.length) {
      const key = keys[selected];
      ctx.config.permissions[key] = !ctx.config.permissions[key];
      continue;
    }
    if (selected === keys.length) {
      const p = await choose(ctx, 'Dangerous action policy (rm -rf, git push, sudo, file overwrite/delete)', [
        'always-ask — confirm every dangerous action (default)',
        'always-allow — never ask (use with caution)',
        'always-deny — block all dangerous actions',
        'Cancel',
      ], ctx.config.dangerousActionPolicy === 'always-ask' ? 0 : ctx.config.dangerousActionPolicy === 'always-allow' ? 1 : 2);
      if (p === 0) ctx.config.dangerousActionPolicy = 'always-ask';
      else if (p === 1) ctx.config.dangerousActionPolicy = 'always-allow';
      else if (p === 2) ctx.config.dangerousActionPolicy = 'always-deny';
      continue;
    }
    if (selected === keys.length + 1) {
      ctx.config.verbose = !ctx.config.verbose;
    }
  }
  ctx.saveConfig();
}

export async function handleAccess(ctx: CommandContext): Promise<HandlerResult | void> {
  const activeIdx = ctx.config.accessScope === 'workspace' ? 0 : 1;
  const selected = await choose(ctx, `Access scope (current: ${ctx.config.accessScope})`, [
    'Workspace only — current directory policy', 'Global — broader filesystem access', 'Cancel',
  ], activeIdx);
  if (selected === null || selected === 2) return;
  ctx.config.accessScope = selected === 0 ? 'workspace' : 'global';
  ctx.saveConfig();
  ctx.repl.print(`Access scope set to ${ctx.config.accessScope}.`);
  if (ctx.config.accessScope === 'workspace') {
    ctx.repl.print(chalk.yellow('Note: workspace scope is an agent policy and working-directory restriction, not an OS-level sandbox for arbitrary shell commands.'));
  }
}

export async function handleToolLimit(ctx: CommandContext): Promise<HandlerResult | void> {
  const current = ctx.config.maxToolCallsPerRequest;
  const options = ['Unlimited (default)', '5', '10', '20', '30', '50', '100', 'Enter custom value', 'Cancel'];
  const presetValues = [0, 5, 10, 20, 30, 50, 100];
  const activeIdx = presetValues.indexOf(current);
  const selected = await choose(ctx, `Tool calls per request (current: ${current === 0 ? 'Unlimited' : current})`, options, activeIdx >= 0 ? activeIdx : undefined);
  if (selected === null || selected === 8) return;
  let value = presetValues[selected];
  if (selected === 7) value = Number((await ctx.repl.question('Enter 0 for unlimited or a positive safe integer: ')).trim());
  if (!Number.isSafeInteger(value) || value < 0) return ctx.repl.print('Invalid value. Enter 0 (unlimited) or a positive safe integer.');
  ctx.config.maxToolCallsPerRequest = value;
  ctx.saveConfig();
  ctx.repl.print(value === 0 ? 'Tool calls are unlimited per request; repeated identical tool calls remain protected by the loop guard.' : `Tool-call budget set to ${value} per request.`);
}

export async function handleProvider(ctx: CommandContext): Promise<HandlerResult | void> {
  const cfg = ctx.config;
  for (;;) {
    const custom = cfg.customProviders || [];
    const options = [
      'Google AI Studio',
      'OpenAI-compatible (built-in)',
      ...custom.map((p) => `Custom: ${p.name} (${p.id})`),
      'Add custom provider…',
      ...(custom.length ? ['Edit custom provider…', 'Delete custom provider…'] : []),
      'Save and exit',
    ];
    let activeIdx: number | undefined;
    if (cfg.activeProvider === 'google-ai-studio') activeIdx = 0;
    else if (cfg.activeProvider === 'openai-compatible') activeIdx = 1;
    else {
      const ci = custom.findIndex((p) => p.id === cfg.activeProvider);
      if (ci >= 0) activeIdx = 2 + ci;
    }
    const selected = await choose(ctx, `Active provider: ${cfg.activeProvider}`, options, activeIdx);
    if (selected === null || selected === options.length - 1) break;
    if (selected === 0) {
      cfg.activeProvider = 'google-ai-studio';
      ctx.saveConfig();
      ctx.repl.print('Provider set to Google AI Studio.');
      continue;
    }
    if (selected === 1) {
      const baseUrl = (await ctx.repl.question('Base URL (e.g. https://api.openai.com/v1): ')).trim();
      if (!validHttpUrl(baseUrl)) { ctx.repl.print('Invalid base URL.'); continue; }
      const apiKey = (await ctx.repl.questionSecret('API Key: ')).trim();
      if (!apiKey) { ctx.repl.print('Cancelled — empty API key.'); continue; }
      cfg.openaiCompatible = { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
      cfg.activeProvider = 'openai-compatible';
      ctx.saveConfig();
      ctx.repl.print('Provider set to OpenAI-compatible.');
      continue;
    }
    const addIdx = 2 + custom.length;
    if (selected === addIdx) {
      // Add custom provider (all custom providers are OpenAI-compatible).
      const name = (await ctx.repl.question('Custom provider name (e.g. My OpenAI): ')).trim();
      if (!name) { ctx.repl.print('Cancelled — empty name.'); continue; }
      // Derive a unique slug id from the name.
      let idRaw = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
      if (idRaw === 'google-ai-studio' || idRaw === 'openai-compatible') idRaw = `${idRaw}-custom`;
      let suffix = 2;
      const baseId = idRaw;
      while (custom.some((p) => p.id === idRaw)) {
        idRaw = `${baseId}-${suffix}`;
        suffix += 1;
      }
      const baseUrl = (await ctx.repl.question('Base URL (OpenAI-compatible /v1, e.g. https://api.openai.com/v1): ')).trim();
      if (!validHttpUrl(baseUrl)) { ctx.repl.print('Invalid base URL — expected absolute HTTP/HTTPS URL without credentials.'); continue; }
      const apiKey = (await ctx.repl.questionSecret('API Key (secret, stored in config.json mode 0600): ')).trim();
      if (!apiKey) { ctx.repl.print('Cancelled — empty API key.'); continue; }
      const defaultModel = (await ctx.repl.question('Default model (optional, Enter to skip): ')).trim();
      cfg.customProviders = [...custom, { id: idRaw, name, baseUrl: baseUrl.replace(/\/$/, ''), apiKey, ...(defaultModel ? { defaultModel } : {}) }];
      cfg.activeProvider = idRaw;
      if (defaultModel) cfg.model = defaultModel;
      ctx.saveConfig();
      ctx.repl.print(`Custom provider "${name}" (${idRaw}) added and selected. OpenAI-compatible. Key: ${maskApiKey(apiKey)}`);
      continue;
    }
    const editIdx = addIdx + 1;
    if (custom.length && selected === editIdx) {
      const pick = await choose(ctx, 'Edit which custom provider?', [...custom.map((p) => p.name), 'Cancel']);
      if (pick === null || pick === custom.length) continue;
      const p = custom[pick];
      const name = (await ctx.repl.question(`Display name (current: ${p.name}, Enter to keep): `)).trim() || p.name;
      const baseUrl = (await ctx.repl.question(`Base URL (current: ${p.baseUrl}, Enter to keep): `)).trim() || p.baseUrl;
      if (!validHttpUrl(baseUrl)) { ctx.repl.print('Invalid base URL.'); continue; }
      const apiKeyRaw = (await ctx.repl.questionSecret(`API Key (Enter to keep ${maskApiKey(p.apiKey)}): `)).trim();
      const apiKey = apiKeyRaw || p.apiKey;
      const defaultModel = (await ctx.repl.question(`Default model (current: ${p.defaultModel || '(none)'}, Enter to keep): `)).trim();
      cfg.customProviders = custom.map((x) => x.id === p.id
        ? { ...x, name, baseUrl: baseUrl.replace(/\/$/, ''), apiKey, ...(defaultModel ? { defaultModel } : (x.defaultModel ? { defaultModel: x.defaultModel } : {})) }
        : x);
      ctx.saveConfig();
      ctx.repl.print(`Custom provider "${p.id}" updated.`);
      continue;
    }
    const delIdx = editIdx + 1;
    if (custom.length && selected === delIdx) {
      const pick = await choose(ctx, 'Delete which custom provider?', [...custom.map((p) => p.name), 'Cancel']);
      if (pick === null || pick === custom.length) continue;
      const p = custom[pick];
      const confirm = await choose(ctx, `Delete custom provider "${p.name}"? This removes its stored API key.`, ['Delete', 'Cancel']);
      if (confirm !== 0) continue;
      cfg.customProviders = custom.filter((x) => x.id !== p.id);
      if (cfg.activeProvider === p.id) cfg.activeProvider = 'google-ai-studio';
      ctx.saveConfig();
      ctx.repl.print(`Custom provider "${p.id}" deleted.`);
      continue;
    }
    // Otherwise: selecting a custom provider (indices 2 .. 2+custom.length-1)
    const customIdx = selected - 2;
    if (customIdx >= 0 && customIdx < custom.length) {
      const p = custom[customIdx];
      cfg.activeProvider = p.id;
      if (p.defaultModel) cfg.model = p.defaultModel;
      ctx.saveConfig();
      ctx.repl.print(`Provider set to custom: ${p.name} (${p.id}). Key: ${maskApiKey(p.apiKey)}`);
    }
  }
}

export async function handleClear(ctx: CommandContext): Promise<HandlerResult | void> {
  ctx.repl.flushConversation();
  ctx.repl.clearScreen();
  ctx.repl.resetContext();
  ctx.repl.print(chalk.dim('Screen and current context cleared. History file kept.'));
}

export async function handleConversation(ctx: CommandContext): Promise<HandlerResult | void> {
  ctx.repl.flushConversation();
  const list = ctx.conversations.list();
  if (!list.length) return ctx.repl.print('No saved conversations.');
  const actions = await choose(ctx, 'Conversation actions', ['Open conversation', 'New conversation', 'Rename conversation', 'Delete conversation', 'Backup conversation', 'Cancel']);
  if (actions === null || actions === 5) return;
  if (actions === 1) { ctx.repl.newConversation(); return ctx.repl.print('Started a new conversation.'); }
  if (actions === 2) {
    // Rename: current conversation by default, or pick another.
    const pick = await choose(ctx, 'Rename which conversation?', ['Current conversation', 'Pick from list…', 'Cancel']);
    if (pick === null || pick === 2) return;
    if (pick === 0) return renameCurrent(ctx);
    const convIdx = await choose(ctx, 'Select conversation', [...list.map((item) => `${item['conversation-name']} (${item.messages.length} messages)`), 'Cancel']);
    if (convIdx === null || convIdx >= list.length) return;
    const target = list[convIdx];
    const newName = (await ctx.repl.question(`${t('rename.prompt')} [${target['conversation-name']}]: `)).trim();
    if (!newName) return ctx.repl.print(t('rename.cancelled'));
    if (ctx.conversations.rename(target['conversation-id'], newName)) ctx.repl.print(t('rename.done'));
    else ctx.repl.print('Rename failed.');
    return;
  }
  const currentId = ctx.repl.currentConversationId();
  const activeConvIdx = list.findIndex((item) => item['conversation-id'] === currentId);
  const selected = await choose(ctx, 'Select conversation', [...list.map((item) => `${item['conversation-name']} (${item.messages.length} messages)`), 'Cancel'], activeConvIdx >= 0 ? activeConvIdx : undefined);
  if (selected === null || selected >= list.length) return;
  const conversation = list[selected];
  if (actions === 0) {
    if (ctx.repl.openConversation(conversation['conversation-id'])) ctx.repl.print(`Opened "${conversation['conversation-name']}".`);
    else ctx.repl.print('Failed to open conversation.');
  } else if (actions === 3) {
    const confirm = await choose(ctx, `Delete "${conversation['conversation-name']}"?`, ['Delete', 'Cancel']);
    if (confirm === 0) { ctx.conversations.delete(conversation['conversation-id']); ctx.repl.print('Conversation deleted.'); }
  } else {
    const destination = ctx.conversations.backup(conversation['conversation-id']);
    ctx.repl.print(destination ? `Backed up to ${destination}` : 'Backup failed.');
  }
}

// /rename [<new name>]: rename the current conversation.
export async function handleRename(ctx: CommandContext): Promise<HandlerResult | void> {
  if (ctx.args.trim()) {
    if (ctx.repl.renameCurrentConversation(ctx.args.trim())) ctx.repl.print(t('rename.done'));
    else ctx.repl.print(t('rename.cancelled'));
    return;
  }
  return renameCurrent(ctx);
}

async function renameCurrent(ctx: CommandContext): Promise<void> {
  const current = ctx.repl.currentConversationName();
  const newName = (await ctx.repl.question(`${t('rename.prompt')} [${current}]: `)).trim();
  if (!newName) { ctx.repl.print(t('rename.cancelled')); return; }
  if (ctx.repl.renameCurrentConversation(newName)) ctx.repl.print(`${t('rename.done')} → "${newName}"`);
  else ctx.repl.print('Rename failed.');
}

export async function handleLanguage(ctx: CommandContext): Promise<HandlerResult | void> {
  const activeIdx = ctx.config.language === 'en' ? 0 : 1;
  const selected = await choose(ctx, 'Interface language', ['English', 'Bahasa Indonesia', 'Cancel'], activeIdx);
  if (selected === null || selected === 2) return;
  ctx.config.language = selected === 1 ? 'id' : 'en';
  setLanguage(ctx.config.language);
  ctx.saveConfig();
  ctx.repl.print(selected === 1 ? 'Bahasa diatur ke Indonesia.' : 'Language set to English.');
}

export async function handleFeedback(ctx: CommandContext): Promise<HandlerResult | void> {
  ctx.repl.print(chalk.bold('AXION AI CLI — Feedback & Support'));
  ctx.repl.print('Email: axionneuralis@gmail.com');
  ctx.repl.print('Email: azrielspace852@gmail.com');
  ctx.repl.print('GitHub Issues: https://github.com/azrielspace852-wq/axion-ai-agents-cli/issues');
  ctx.repl.print(chalk.dim('Use GitHub Issues to report reproducible bugs and feature requests. Do not include API keys or secrets.'));
}

export async function handleHelp(ctx: CommandContext): Promise<HandlerResult | void> {
  const cmds: Array<[string, string]> = [
    ['/feedback', 'Show support email addresses and GitHub issue tracker'],
    ['/access', 'Choose workspace-only or global access scope'],
    ['/models', 'Select, add, edit, or delete custom models'],
    ['/thinking', t('help.thinking')],
    ['/system', 'View the locked base system prompt (read-only)'],
    ['/system-prompt', 'View the locked base system prompt + current custom instructions'],
    ['/instructions', 'Set or clear your custom instructions (appended to base prompt)'],
    ['/verbose', 'Toggle verbose output (full tool output vs summaries)'],
    ['/memory', t('help.memory')],
    ['/api-key', t('help.apikey')],
    ['/permissions', t('help.permissions')],
    ['/tool-limit', t('help.toolLimit')],
    ['/max-tool-call', t('help.maxToolCall')],
    ['/max-token', t('help.maxToken')],
    ['/privacy-policy', t('help.privacyPolicy')],
    ['/provider', t('help.provider')],
    ['/clear', t('help.clear')],
    ['/conversation', t('help.conversation')],
    ['/rename', t('help.rename')],
    ['/language', t('help.language')],
    ['/help', t('help.help')],
    ['/exit', t('help.exit')],
  ];
  ctx.repl.print(chalk.bold(t('help.title')) + ':');
  for (const [command, description] of cmds) ctx.repl.print(`  ${chalk.cyan(command.padEnd(16))} ${description}`);
}

export async function handlePrivacyPolicy(ctx: CommandContext): Promise<HandlerResult | void> {
  const lines: string[] = [
    chalk.bold('AXION AI CLI — Security & Privacy (honest summary)'),
    '',
    chalk.bold('1. Where your data is stored'),
    `   • All local data lives in ~/.axn-cli (override with $AXION_DATA_DIR):`,
    '     - config.json (including API keys), conversations/, memory/, instructions/',
    '     - Files are written with mode 0600 and directories with 0700 (owner-only).',
    '   • API keys are stored in plain text in the local config file. There is NO',
    '     end-to-end encryption and no OS keychain integration. Anyone with read',
    '     access to your home directory can read them.',
    '',
    chalk.bold('2. What is sent to AI providers'),
    '   • When you chat, the following are sent to the active LLM provider',
    '     (Google AI Studio or your configured OpenAI-compatible endpoint):',
    '     - your messages and the conversation history,',
    '     - the system prompt (workspace root path only; no tree or file contents are attached automatically),',
    '     - tool definitions and, when tools run, tool results (web pages, search',
    '       results, shell command output, file contents the agent reads).',
    '   • That data is governed by the provider\'s own privacy policy, not by AXION.',
    '',
    chalk.bold('3. What AXION itself does NOT do'),
    '   • No telemetry, analytics, or crash reporting is sent to any AXION server.',
    '   • No third-party tracking. The only network calls are: the LLM provider API,',
    '     web search / page fetch triggered by tools (to public hosts only), and the',
    '     optional version check and package installation from the official npm registry.',
    '',
    chalk.bold('4. Risks you should understand'),
    '   • The shell tool executes commands with YOUR user privileges. Workspace',
    '     "access scope" is an agent policy, not an OS sandbox.',
    '   • `axion-ai-cli update` asks npm to install the latest published package',
    '     from https://registry.npmjs.org/. Review package provenance and metadata.',
    '   • Conversation history may contain sensitive text; it is stored locally in',
    '     plain JSON. Delete it manually any time via /conversation or rm -rf ~/.axn-cli.',
    '',
    chalk.bold('5. Your controls'),
    '   • /clear resets in-memory context; /conversation lets you delete/backup saved chats.',
    '   • /permissions toggles web/search/shell access; /api-key rotates the stored key.',
    '   • To erase everything: remove the ~/.axn-cli directory.',
    '',
    chalk.dim('This summary is informational, not legal advice. Review the provider policies and LICENSE (GPL-3.0).'),
  ];
  for (const line of lines) ctx.repl.print(line);
}

export async function handleMaxToken(ctx: CommandContext): Promise<HandlerResult | void> {
  const cfg = ctx.config;
  const fmt = (n: number | undefined) => (typeof n === 'number' ? String(n) : 'unset (no limit)');
  ctx.repl.print(chalk.bold('Token limits'));
  ctx.repl.print(`  Input soft cap (maxInputTokens):  ${fmt(cfg.maxInputTokens)}`);
  ctx.repl.print(`  Output cap (maxOutputTokens):     ${fmt(cfg.maxOutputTokens)}`);
  ctx.repl.print(chalk.dim('  Note: input tokens are ESTIMATED as characters/4 (no real tokenizer is bundled).'));
  ctx.repl.print(chalk.dim('  When over the cap, oldest non-system messages are dropped first. This is approximate.'));
  const action = await choose(ctx, 'Change which limit?', ['Set input soft cap', 'Set output cap', 'Clear both', 'Cancel']);
  if (action === null || action === 3) return;
  if (action === 2) {
    cfg.maxInputTokens = undefined;
    cfg.maxOutputTokens = undefined;
    ctx.saveConfig();
    return ctx.repl.print('Token limits cleared.');
  }
  const raw = (await ctx.repl.question(action === 0
    ? 'Input soft cap in tokens (positive integer, blank to keep current): '
    : 'Output cap in tokens forwarded to the provider (positive integer, blank to keep current): ')).trim();
  if (!raw) return ctx.repl.print('Unchanged.');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return ctx.repl.print('Invalid value. Enter a positive integer. No changes were saved.');
  if (action === 0) cfg.maxInputTokens = value;
  else cfg.maxOutputTokens = value;
  ctx.saveConfig();
  ctx.repl.print(action === 0
    ? `Input soft cap set to ~${value} tokens (estimated as chars/4; oldest messages trimmed first).`
    : `Output cap set to ${value} tokens (forwarded to the provider as maxOutputTokens/max_tokens).`);
}

export async function handleExit(): Promise<HandlerResult> {
  return { exit: true };
}
