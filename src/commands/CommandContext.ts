import type { AxionConfig } from '../types';
import type { ConfigManager } from '../config/ConfigManager';
import type { ConversationStore } from '../storage/ConversationStore';
import type { MemoryStore } from '../storage/MemoryStore';
import type { Agent } from '../agent/Agent';
export interface ReplLike {
  print(msg: string): void;
  question(q: string): Promise<string>;
  questionSecret(q: string): Promise<string>;
  editMultiline(prompt: string, initialValue: string): Promise<string | null>;
  select(prompt: string, options: string[], activeIndex?: number): Promise<number | null>;
  confirm(question: string): Promise<boolean>; // Yes/No explicit confirmation for dangerous actions
  clearScreen(): void;
  exit(code?: number): void;
  resetContext(): void;
  openConversation(id: string): boolean;
  newConversation(): void;
  currentConversationId(): string;
  currentConversationName(): string;
  renameCurrentConversation(newName: string): boolean;
  flushConversation(): void;
}
export interface CommandContext {
  args: string;
  config: AxionConfig;
  configManager: ConfigManager; // direct access for persistence / update(patch)
  saveConfig(): void;
  repl: ReplLike;
  conversations: ConversationStore;
  memories: MemoryStore;
  agent: Agent;
}
export interface HandlerResult {
  exit?: boolean;
}
