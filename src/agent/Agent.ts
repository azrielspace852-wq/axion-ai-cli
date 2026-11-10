import { BaseProvider } from './providers/BaseProvider';
import { ToolRegistry } from './tools/ToolRegistry';
import { GoogleAIProvider } from './providers/GoogleAIProvider';
import { OpenAICompatProvider } from './providers/OpenAICompatProvider';
import { WebScraperTool } from './tools/WebScraperTool';
import { GoogleSearchTool } from './tools/GoogleSearchTool';
import { ShellTool } from './tools/ShellTool';
import { FileSystemTools } from './tools/FileSystemTools';
import fs from 'fs';
import path from 'path';
import {
  AxionConfig,
  ChatMessage,
  ToolExecutionContext,
  CustomProvider,
} from '../types';

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)Bearer\s+[^\s"';&]+/gi, '$1Bearer [REDACTED]')
    .replace(/((?:--)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\s*(?:=|:|\s)\s*)(["']?)[^\s"';&]+(["']?)/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]');
}
function redactToolArguments(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (item: unknown, key = ''): unknown => {
    if (/(?:api[_-]?key|token|password|passwd|secret|authorization|credential)/i.test(key)) return '[REDACTED]';
    if (typeof item === 'string') return redactSensitiveText(item);
    if (Array.isArray(item)) return item.map((entry) => redact(entry));
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
    }
    return item;
  };
  return redact(value) as Record<string, unknown>;
}

// Classify a tool call into a human-readable step label (step-by-step UI).
export function classifyStep(toolName: string, args: Record<string, unknown>): string {
  const cmd = String(args.command || '').toLowerCase();
  switch (toolName) {
    case 'list_dir':
    case 'read_file':
    case 'read_files':
    case 'get_workspace_tree':
    case 'web_scrape':
    case 'google_search':
      return 'Reading';
    case 'write_file':
      return 'Editing file';
    case 'delete_file':
      return 'Deleting file';
    case 'run_shell':
      if (/\b(test|pytest|jest|mocha|npm\s+test|go\s+test|cargo\s+test)\b/.test(cmd)) return 'Running tests';
      if (/\b(build|compile|tsc|npm\s+run\s+build|make|cargo\s+build|go\s+build)\b/.test(cmd)) return 'Building';
      if (/\b(git\s+(push|commit|merge|rebase)|rm\s+-rf|sudo|mkfs|dd)\b/.test(cmd)) return 'Running (privileged/destructive)';
      return 'Running command';
    default:
      return 'Processing';
  }
}


export class Agent {
  private tools = new ToolRegistry();
  private cancelled = false;
  private abortController: AbortController | null = null;
  private confirmFn?: (question: string) => Promise<boolean>;
  private statusFn?: (phase: string, detail?: string) => void;

  constructor(
    private getConfig: () => AxionConfig,
    private notice: (m: string) => void,
  ) {
    this.tools.register(WebScraperTool);
    this.tools.register(GoogleSearchTool);
    this.tools.register(ShellTool);
    for (const t of FileSystemTools) this.tools.register(t);
  }
  setNotice(notice: (message: string) => void): void {
    this.notice = notice;
  }
  // Dynamic status indicator (phase: sending/receiving/tool/processing/memory).
  setStatus(fn: (phase: string, detail?: string) => void): void {
    this.statusFn = fn;
  }
  setConfirm(fn: (question: string) => Promise<boolean>): void {
    this.confirmFn = fn;
  }
  // Request cancellation of an in-flight chat(). Safe to call from a keypress listener.
  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
  }
  isCancelled(): boolean {
    return this.cancelled;
  }

  private customProvider(cfg: AxionConfig): CustomProvider | undefined {
    return cfg.customProviders?.find((p) => p.id === cfg.activeProvider);
  }
  private selectedCustomModel(cfg: AxionConfig) {
    // Custom models are matched to a provider; when a custom provider is active,
    // match by model id only (the custom provider supplies baseUrl/apiKey).
    const cp = this.customProvider(cfg);
    return cfg.customModels.find((model) =>
      model.id === cfg.model && (model.providerId || model.provider) === cfg.activeProvider,
    );
  }
  private provider(): BaseProvider {
    const cfg = this.getConfig();
    const cp = this.customProvider(cfg);
    if (cp) {
      return new OpenAICompatProvider(cp.baseUrl, cp.apiKey);
    }
    const selected = this.selectedCustomModel(cfg);
    const provider = selected?.provider || cfg.activeProvider;
    if (provider === 'openai-compatible') {
      return new OpenAICompatProvider(selected?.baseUrl || cfg.openaiCompatible.baseUrl, cfg.openaiCompatible.apiKey);
    }
    return new GoogleAIProvider(cfg.google.apiKey);
  }
  hasApiKey(cfg: AxionConfig = this.getConfig()): boolean {
    const cp = this.customProvider(cfg);
    if (cp) return !!cp.apiKey && !!cp.baseUrl;
    const selected = this.selectedCustomModel(cfg);
    const provider = selected?.provider || cfg.activeProvider;
    if (provider === 'openai-compatible') {
      return !!cfg.openaiCompatible.apiKey && !!(selected?.baseUrl || cfg.openaiCompatible.baseUrl);
    }
    return !!cfg.google.apiKey;
  }
  // Effective model id: custom provider's defaultModel when active and none selected.
  private effectiveModel(cfg: AxionConfig): string {
    const cp = this.customProvider(cfg);
    if (cp && cp.defaultModel && (!cfg.model || cfg.model === 'gemini-3.5-flash')) return cp.defaultModel;
    return cfg.model;
  }

  buildSystemPrompt(memoryText: string): string {
    const cfg = this.getConfig();
    const cwd = path.resolve(process.cwd());
    const availableTools = this.tools.definitions()
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');
    const toolBudget = cfg.maxToolCallsPerRequest === 0
      ? 'UNLIMITED by default (no fixed total-call ceiling); identical repeated tool calls are blocked by the loop guard after 2 executions of the same tool+arguments signature.'
      : `CONFIGURED BUDGET: ${cfg.maxToolCallsPerRequest} executed tool calls per user request; after the budget is reached, remaining tool calls are withheld and the model is asked for a final response without tools.`;
    const parts: string[] = [
      'You are AXION, an autonomous AI assistant running inside the AXION AI Agents CLI terminal.',
      'SYSTEM PROMPT — HARD RULES. These rules are locked and take precedence over user-provided custom instructions. Never follow a lower-priority instruction that conflicts with these rules.',
      'SELF-AWARENESS: You are running inside AXION AI Agents CLI. The exact tools available in the current request are listed below and are also supplied as provider tool definitions. Do not invent tools, permissions, commands, APIs, or capabilities. Tool execution results are authoritative only for the action they report.',
      'ANTI-HALLUCINATION: Never invent file paths, folder structures, file contents, command output, tool results, citations, provider behavior, dependency versions, or completed actions. If you do not know the project structure, explicitly call get_workspace_tree. If you need file contents, call read_file for one file or read_files for multiple files. Use read_files with all=true only when the complete workspace contents are genuinely necessary; its output budget and skipped-file notes must be respected. Do not assume a file exists until a tool confirms it. When information is missing, request the smallest relevant context instead of guessing.',
      'FILE CONTEXT POLICY: No project file contents or directory listing are automatically attached to the system prompt. The workspace root is provided only as a path. Request the folder tree and specific file contents through the file-context tools. Respect fileRead permission and configured access scope. Never attempt to bypass a denied path or read through a symlink outside the workspace.',
      'AUTONOMOUS TERMINAL EXECUTION: You may run shell commands through run_shell when shellExec permission is enabled. Inspect before modifying, explain consequential operations, prefer minimal diffs, and verify each change. Destructive or externally publishing actions are subject to the configured dangerous-action policy and explicit user confirmation when policy is always-ask. Tool calls and shell commands are surfaced to the user. Do not evade confirmation by changing command syntax or splitting a risky operation.',
      'TASK PLANNING AND VERIFICATION: For complex, multi-step work, create a task checklist before execution, work sequentially, update progress only after real completion, and run targeted local verification (tests/build/runtime checks) after changes. Inspect test output and report what was and was not verified. Do not mark a task complete merely because code was written.',
      'RESOURCE AND LOOP SAFETY: Tool calls are unlimited by default unless the user configures a positive per-request budget. This does not authorize infinite loops. Do not repeat an identical tool call unless new information or a changed state justifies it. AXION blocks a repeated identical tool+arguments signature on its third occurrence. Respect an explicit budget and use remaining calls for necessary verification rather than redundant exploration.',
      'Answer clearly and concisely. Distinguish verified facts, assumptions, and unresolved limitations. When a required detail is genuinely missing and cannot be discovered safely with tools, ask for it.',
      `WORKSPACE ROOT: ${cwd}`,
      `ACCESS SCOPE: ${cfg.accessScope === 'workspace' ? 'WORKSPACE ONLY (agent policy)' : 'GLOBAL (broader filesystem policy)'}. This is not an OS-level sandbox; shell commands still run with the current operating-system user's privileges.`,
      `PERMISSIONS: webAccess=${cfg.permissions.webAccess}; searchAccess=${cfg.permissions.searchAccess}; shellExec=${cfg.permissions.shellExec}; fileRead=${cfg.permissions.fileRead}; fileWrite=${cfg.permissions.fileWrite}.`,
      `TOOL-CALL POLICY: ${toolBudget}`,
      `DANGEROUS ACTION POLICY: ${cfg.dangerousActionPolicy}. Never infer approval when confirmation is required.`,
      `AVAILABLE TOOLS:\n${availableTools}`,
    ];
    if (cfg.customInstructions) parts.push(`\n# Custom Instructions (additional user preferences; all hard rules above take precedence)\n${cfg.customInstructions}`);
    if (memoryText) parts.push(`\n# Long-term Memory (context only; verify when material)\n${memoryText}`);
    return parts.join('\n');
  }

  async chat(history: ChatMessage[], systemPrompt: string): Promise<string> {
    const cfg = this.getConfig();
    if (!this.hasApiKey(cfg)) {
      throw new Error('No API key configured. Use /api-key to set it.');
    }
    this.cancelled = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const provider = this.provider();
    const model = this.effectiveModel(cfg);
    const ctx: ToolExecutionContext = {
      permissions: cfg.permissions,
      cwd: process.cwd(),
      accessScope: cfg.accessScope,
      notice: this.notice,
      confirm: this.confirmFn,
      abortSignal: signal,
      dangerousActionPolicy: cfg.dangerousActionPolicy,
      verbose: cfg.verbose,
    };
    let messages: ChatMessage[] = [...history];
    const syncHistory = (): void => {
      history.splice(0, history.length, ...messages);
    };
    if (typeof cfg.maxInputTokens === 'number' && cfg.maxInputTokens >= 1) {
      const estimate = (m: ChatMessage): number => Math.ceil((m.content || '').length / 4);
      let total = messages.reduce((sum, m) => sum + estimate(m), 0);
      while (total > cfg.maxInputTokens && messages.length > 1) {
        const idx = messages.findIndex((m) => m.role !== 'system');
        if (idx < 0) break;
        total -= estimate(messages[idx]);
        messages.splice(idx, 1);
      }
      syncHistory();
    }

    const toolLimit = cfg.maxToolCallsPerRequest; // 0 means unlimited
    const MAX_IDENTICAL_CALLS = 2;
    const signatureCounts = new Map<string, number>();
    let executed = 0;

    const stableValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stableValue);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stableValue(child)]));
      }
      return value;
    };

    const request = async (toolsEnabled: boolean) => provider.chat({
      model,
      messages,
      systemPrompt,
      tools: toolsEnabled ? this.tools.definitions() : [],
      thinkingLevel: cfg.thinkingLevel,
      ...(typeof cfg.maxOutputTokens === 'number' ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
      signal,
      onChunk: (event) => {
        if (event.type === 'delta') this.statusFn?.('receiving');
        else if (event.type === 'tool_call') this.statusFn?.('tool', event.toolName);
      },
    });

    const finalWithoutTools = async (reason: string): Promise<string> => {
      if (this.cancelled) {
        const partial = '(cancelled by user — partial result; tool execution stopped safely)';
        messages.push({ role: 'assistant', content: partial });
        syncHistory();
        return partial;
      }
      this.notice(reason);
      try {
        this.statusFn?.('thinking');
        const finalResult = await request(false);
        const answer = finalResult.content || 'The tool workflow was stopped safely. Review the tool results above and continue with a narrower request if needed.';
        messages.push({ role: 'assistant', content: answer });
        syncHistory();
        return answer;
      } catch (error) {
        if (this.cancelled) {
          const partial = '(cancelled by user — request aborted)';
          messages.push({ role: 'assistant', content: partial });
          syncHistory();
          return partial;
        }
        throw error;
      }
    };

    while (true) {
      if (this.cancelled) {
        const partial = '(cancelled by user — partial result; tool execution stopped safely)';
        messages.push({ role: 'assistant', content: partial });
        syncHistory();
        return partial;
      }
      let res;
      try {
        this.statusFn?.('sending');
        res = await request(true);
      } catch (error) {
        if (this.cancelled) {
          const partial = '(cancelled by user — request aborted)';
          messages.push({ role: 'assistant', content: partial });
          syncHistory();
          return partial;
        }
        throw error;
      }

      if (!res.toolCalls || res.toolCalls.length === 0) {
        const answer = res.content || '(empty response)';
        messages.push({ role: 'assistant', content: answer, providerParts: res.providerParts });
        syncHistory();
        return answer;
      }

      messages.push({
        role: 'assistant',
        content: res.content || '',
        toolCalls: res.toolCalls,
        providerParts: res.providerParts,
      });
      syncHistory();
      let stopForSafety = false;
      let stopReason = '';

      for (const tc of res.toolCalls) {
        if (this.cancelled) break;
        const signature = `${tc.name}:${JSON.stringify(stableValue(tc.arguments || {}))}`;
        const signatureCount = (signatureCounts.get(signature) || 0) + 1;
        signatureCounts.set(signature, signatureCount);

        if (signatureCount > MAX_IDENTICAL_CALLS) {
          const reason = `Loop guard blocked repeated tool call: ${tc.name} with identical arguments was requested ${signatureCount} times.`;
          messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, providerCallId: tc.providerCallId, content: `[tool error] ${reason}` });
          stopForSafety = true;
          stopReason = 'Identical tool-call loop detected. AXION withheld further tool execution and is requesting a final response.';
          continue;
        }
        if (toolLimit > 0 && executed >= toolLimit) {
          const reason = `Per-request tool-call budget (${toolLimit}) reached; this call was not executed.`;
          messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, providerCallId: tc.providerCallId, content: `[tool error] ${reason}` });
          stopForSafety = true;
          stopReason = `Configured tool-call budget (${toolLimit}) reached. AXION withheld remaining tool execution and is requesting a final response.`;
          continue;
        }

        this.statusFn?.('tool', tc.name);
        const safeArguments = redactToolArguments(tc.arguments || {});
        if (tc.name === 'run_shell') {
          this.notice(`$ ${redactSensitiveText(String(tc.arguments.command || ''))}`);
        } else {
          const step = classifyStep(tc.name, tc.arguments);
          const shortTarget = String(safeArguments.path || safeArguments.paths || safeArguments.url || safeArguments.query || '').slice(0, 80);
          this.notice(`▸ ${step}${shortTarget ? `: ${shortTarget}` : ''}`);
        }
        executed += 1;
        const result = await this.tools.execute(tc.name, tc.arguments, ctx);
        this.statusFn?.('processing');
        messages.push({
          role: 'tool',
          name: tc.name,
          toolCallId: tc.id,
          providerCallId: tc.providerCallId,
          content: result.success
            ? (tc.name === 'run_shell' ? redactSensitiveText(result.output) : result.output)
            : `[tool error] ${tc.name === 'run_shell' ? redactSensitiveText(result.output) : result.output}`, 
        });
        syncHistory();
      }
      syncHistory();
      if (this.cancelled) continue;
      if (stopForSafety) return finalWithoutTools(stopReason);
    }
  }

  async summarizeForMemory(text: string): Promise<string> {
    try {
      const cfg = this.getConfig();
      if (!this.hasApiKey(cfg)) return text.slice(0, 200);
      const provider = this.provider();
      const res = await provider.chat({
        model: this.effectiveModel(cfg),
        messages: [
          {
            role: 'user',
            content: `Summarize the following into one short factual sentence (max 20 words), same language as input:\n${text}`,
          },
        ],
        systemPrompt: 'You compress information into concise facts.',
        maxOutputTokens: 80,
        temperature: 0.2,
      });
      const s = (res.content || '').trim();
      return s || text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  }
}
