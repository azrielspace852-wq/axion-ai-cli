#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import axios from 'axios';
import { ConfigManager } from './config/ConfigManager';
import { ConversationStore } from './storage/ConversationStore';
import { MemoryStore } from './storage/MemoryStore';
import { Agent } from './agent/Agent';
import { REPL } from './repl/REPL';
import { VERSION } from './banner';
import { handleFeedback } from './commands/handlers';
import { localizeUiText, setLanguage } from './i18n';

const NPM_PACKAGE_NAME = '@axion-neuralis/axion-ai-cli';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/';
const NPM_LATEST_URL = 'https://registry.npmjs.org/@axion-neuralis%2Faxion-ai-cli/latest';
const UPDATE_COMMAND = `npm install --global ${NPM_PACKAGE_NAME}@latest`;

type UpdateInfo = {
  latestVersion?: string;
  releaseNotes?: string;
  publishedAt?: string;
  packageName?: string;
  registryUrl?: string;
  installCommand?: string;
};

type NpmLatestMetadata = { name?: string; version?: string; time?: string };

function readVersion(): string {
  try {
    const file = path.join(__dirname, 'version.json');
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string };
      if (parsed && typeof parsed.version === 'string' && parsed.version) return parsed.version;
    }
  } catch {
    // fall through to the compiled-in constant
  }
  return VERSION;
}

function readUpdateInfo(): UpdateInfo {
  try {
    const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'update-info.json'), 'utf8'));
    if (local && typeof local === 'object') return local as UpdateInfo;
  } catch { /* ignore */ }
  return {};
}

function isVersionNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const next = parse(candidate);
  const installed = parse(current);
  if (!next || !installed) return candidate !== current;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

async function fetchRegistryLatest(): Promise<NpmLatestMetadata> {
  const response = await axios.get(NPM_LATEST_URL, {
    timeout: 4000,
    responseType: 'json',
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  });
  const data = response.data as NpmLatestMetadata;
  if (!data || data.name !== NPM_PACKAGE_NAME || typeof data.version !== 'string' || !data.version) {
    throw new Error('Unexpected npm registry metadata for AXION AI CLI.');
  }
  return data;
}

function applyStoredLanguage(): void {
  // CLI subcommands execute before ConfigManager/REPL initialization.
  try {
    const dataDir = process.env.AXION_DATA_DIR || path.join(os.homedir(), '.axn-cli');
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as { language?: string };
    setLanguage(config.language === 'id' ? 'id' : 'en');
  } catch { setLanguage('en'); }
}

function printFullHelp(): void {
  const ui = (value: string): string => localizeUiText(value);
  const v = readVersion();
  console.log(chalk.cyan.bold(`AXION AI CLI v${v}`));
  console.log(chalk.dim(ui('Terminal AI agent with workspace-aware tools, memory, and model management.')));
  console.log('');
  console.log(chalk.bold(ui('Usage:')));
  console.log('  axion-ai-cli [command] [options]');
  console.log('  axion-cli    (compatibility alias)');
  console.log('  axn-cli      (compatibility alias)');
  console.log('');
  console.log(chalk.bold(ui('Terminal commands (run without entering chat):')));
  const termCmds: Array<[string, string]> = [
    ['(no args)', 'Enter interactive chat mode'],
    ['--help, -h', 'Show this help'],
    ['--version, -v', 'Print the installed version'],
    ['--feedback', 'Show feedback/support contact info, then enter chat'],
    ['update --info', 'Show latest version, release notes, and update instructions (does NOT update)'],
    ['update', 'Install the latest published package from npmjs using npm'],
  ];
  for (const [cmd, desc] of termCmds) console.log(`  ${chalk.cyan(cmd.padEnd(16))} ${ui(desc)}`);
  console.log('');
  console.log(chalk.bold(ui('In-chat commands (type inside the REPL):')));
  const inApp: Array<[string, string]> = [
    ['/help', 'Show in-chat command list'],
    ['/models', 'Select/add/edit/delete models (filtered by active provider)'],
    ['/thinking', 'Set reasoning level: off/low/medium/high/max'],
    ['/system', 'View the locked base system prompt (read-only)'],
    ['/memory', 'Manage long-term memory'],
    ['/api-key', 'Set/update the provider API key'],
    ['/permissions', 'Toggle web/search/shell permissions'],
    ['/provider', 'Switch LLM provider (Google AI Studio / OpenAI-compatible)'],
    ['/tool-limit', 'Configure an optional per-request tool-call budget (0 = unlimited by default)'],
    ['/max-tool-call', 'Alias for /tool-limit'],
    ['/max-token', 'Set input-token soft cap and output-token limit'],
    ['/privacy-policy', 'Show security & privacy information'],
    ['/access', 'Workspace-only or global access scope'],
    ['/clear', 'Clear screen and current context'],
    ['/conversation', 'List/open/delete/backup saved conversations'],
    ['/rename', 'Rename the current conversation'],
    ['/language', 'Switch interface language (en/id)'],
    ['/feedback', 'Show support contacts'],
    ['/exit', 'Exit the CLI'],
  ];
  for (const [cmd, desc] of inApp) console.log(`  ${chalk.cyan(cmd.padEnd(16))} ${ui(desc)}`);
  console.log('');
  console.log(chalk.dim(ui(`User data: ~/.axn-cli  |  Package: ${NPM_PACKAGE_NAME}  |  License: GPL-3.0`)));
}

async function printUpdateInfo(current: string): Promise<void> {
  const info = readUpdateInfo();
  let latest = info.latestVersion || current;
  let registryAvailable = false;
  try {
    const metadata = await fetchRegistryLatest();
    latest = metadata.version as string;
    registryAvailable = true;
  } catch {
    console.log(chalk.dim(localizeUiText('(npmjs registry check failed; showing bundled version information.)')));
  }
  const updateAvailable = isVersionNewer(latest, current);
  console.log(chalk.bold(localizeUiText('AXION AI CLI — Update Information')));
  console.log(`  ${localizeUiText('Package')}:           ${NPM_PACKAGE_NAME}`);
  console.log(`  ${localizeUiText('Installed version')}: ${current}`);
  console.log(`  ${localizeUiText('Latest available')}:  ${latest}${updateAvailable ? chalk.green(` (${localizeUiText('update available')})`) : chalk.dim(` (${localizeUiText('up to date / cached')})`)}`);
  console.log(`  ${localizeUiText('Registry')}:          ${registryAvailable ? NPM_REGISTRY_URL : localizeUiText('npmjs (temporarily unreachable)')}`);
  if (info.publishedAt && latest === info.latestVersion) console.log(`  ${localizeUiText('Published')}:         ${info.publishedAt}`);
  const releaseNotes = latest === info.latestVersion ? info.releaseNotes : undefined;
  if (releaseNotes) {
    console.log(chalk.bold(`  ${localizeUiText('Release notes')}:`));
    console.log(`    ${releaseNotes}`);
  }
  console.log('');
  if (updateAvailable) {
    console.log(chalk.cyan(`  ${localizeUiText('To update, run')}:  ${UPDATE_COMMAND}`));
  } else {
    console.log(chalk.dim(`  ${localizeUiText('You are using the latest known version. Run axion-ai-cli update to reinstall.')}`));
  }
}

function runUpdate(): void {
  const npmCheck = spawnSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (npmCheck.error || npmCheck.status !== 0) {
    console.error(chalk.red(localizeUiText('npm is required to update AXION AI CLI. Install Node.js with npm, then retry.')));
    process.exit(1);
  }
  if (process.env.AXION_UPDATE_DRY_RUN === '1') {
    console.log(`[dry-run] ${localizeUiText('would execute')}: ${UPDATE_COMMAND}`);
    console.log(`[dry-run] ${localizeUiText('registry')}: ${NPM_REGISTRY_URL}`);
    process.exit(0);
  }
  console.log(chalk.cyan(localizeUiText('Updating AXION AI CLI from npmjs: ')) + UPDATE_COMMAND);
  const result = spawnSync('npm', ['install', '--global', `${NPM_PACKAGE_NAME}@latest`, '--registry', NPM_REGISTRY_URL], { stdio: 'inherit' });
  if (result.error) {
    console.error(chalk.red(`${localizeUiText('Update failed')}: ${result.error.message}`));
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

async function checkForUpdate(current: string): Promise<void> {
  // Best-effort npmjs check. A registry outage must never block CLI startup.
  try {
    let latest: string | undefined;
    let notes: string | undefined;
    try {
      const metadata = await fetchRegistryLatest();
      latest = metadata.version;
      const localInfo = readUpdateInfo();
      notes = metadata.version === localInfo.latestVersion ? localInfo.releaseNotes : undefined;
    } catch {
      const local = readUpdateInfo();
      latest = local.latestVersion;
      notes = local.releaseNotes;
    }
    if (latest && isVersionNewer(latest, current)) {
      console.log(chalk.yellow(localizeUiText(`A new version (${latest}) is available. Run: axion-ai-cli update`)));
      if (notes) console.log(chalk.dim(`  ${notes}`));
    }
  } catch {
    // Intentionally silent: update checks must never break the REPL.
  }
}

async function main(): Promise<void> {
  applyStoredLanguage();
  const argv = process.argv.slice(2);
  const arg0 = argv[0];
  const arg1 = argv[1];

  if (arg0 === '--version' || arg0 === '-v') {
    console.log(readVersion());
    return;
  }
  if (arg0 === '--help' || arg0 === '-h') {
    printFullHelp();
    return;
  }
  if (arg0 === 'update') {
    if (arg1 === '--info') {
      await printUpdateInfo(readVersion());
      return;
    }
    runUpdate();
    return;
  }
  const currentVersion = readVersion();
  void checkForUpdate(currentVersion);
  const cfgMgr = new ConfigManager();
  const conversations = new ConversationStore();
  const memories = new MemoryStore();
  const notice = (m: string) => console.log(chalk.dim(m));
  const agent = new Agent(() => cfgMgr.get(), notice);

  if (arg0 === '--feedback') {
    // --feedback: show the feedback/support info immediately, then proceed into chat.
    const fakeCtx = { repl: { print: (m: string) => console.log(localizeUiText(m)) } };
    await handleFeedback(fakeCtx as never);
    console.log('');
  }

  const repl = new REPL(cfgMgr, conversations, memories, agent);
  await repl.start();
}

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red(localizeUiText('Unhandled error:')), reason);
});
process.on('uncaughtException', (err) => {
  console.error(chalk.red(localizeUiText('Fatal:')), err.message);
  process.exit(1);
});
main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(chalk.red(localizeUiText(msg)));
  process.exit(1);
});
