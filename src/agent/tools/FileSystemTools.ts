import fs from 'fs';
import path from 'path';
import { AgentTool, ToolResult } from '../../types';

// Resolve a path against the workspace; enforce workspace scope when active.
function resolvePath(input: string, ctx: { cwd: string; accessScope: string }): { ok: true; abs: string } | { ok: false; error: string } {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Empty path.' };
  let abs: string;
  try {
    const candidate = path.resolve(ctx.cwd, raw);
    try {
      // Resolve the final path as well as its parent. This prevents an in-workspace
      // symlink from being used to read, overwrite, or delete an out-of-workspace target.
      abs = fs.realpathSync(candidate);
    } catch {
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) {
          return { ok: false, error: `Unresolved symbolic link is blocked: ${candidate}` };
        }
      } catch { /* path does not exist yet; find the closest existing ancestor below */ }
      const missingParts: string[] = [];
      let existingAncestor = candidate;
      while (!fs.existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) return { ok: false, error: `No existing parent directory for path: ${candidate}` };
        missingParts.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
      }
      const realAncestor = fs.realpathSync(existingAncestor);
      abs = path.join(realAncestor, ...missingParts);
    }
  } catch {
    return { ok: false, error: `Invalid or inaccessible path: ${raw}` };
  }
  if (ctx.accessScope === 'workspace') {
    let root: string;
    try { root = fs.realpathSync(ctx.cwd); }
    catch { return { ok: false, error: 'Workspace root is inaccessible.' }; }
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
      return { ok: false, error: `Workspace scope blocks path outside the workspace: ${abs}` };
    }
  }
  return { ok: true, abs };
}

const DEFAULT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.cache', '.next', 'coverage', '__pycache__']);
const DEFAULT_READ_FILES_BUDGET = 1024 * 1024;
const MAX_READ_FILES_BUDGET = 10 * 1024 * 1024;
const MAX_EXPLICIT_FILE_PATHS = 1000;
const MAX_WORKSPACE_SCAN_FILES = 50000;
const MAX_WORKSPACE_SCAN_DEPTH = 100;
const MAX_SINGLE_FILE_READ_BYTES = 64 * 1024;

function hasSymbolicLinkComponent(inputPath: string): boolean {
  const absolute = path.resolve(inputPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // A missing/inaccessible component will be reported by the normal resolver.
      return false;
    }
  }
  return false;
}

function collectWorkspaceFiles(root: string, includeIgnored: boolean, maxFiles: number): { files: string[]; errors: string[]; truncated: boolean } {
  const files: string[] = [];
  const errors: string[] = [];
  let truncated = false;
  const walk = (directory: string, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_WORKSPACE_SCAN_DEPTH) {
      errors.push(`${path.relative(root, directory) || '.'}: maximum scan depth (${MAX_WORKSPACE_SCAN_DEPTH}) reached`);
      return;
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      errors.push(`${path.relative(root, directory) || '.'}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue; // do not follow symlinks during recursive scans
      if (entry.isDirectory()) {
        if (!includeIgnored && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
      if (truncated) return;
    }
  };
  walk(root, 0);
  return { files, errors, truncated };
}

async function confirmDangerous(ctx: { confirm?: (q: string) => Promise<boolean>; dangerousActionPolicy?: string }, question: string): Promise<boolean> {
  const policy = ctx.dangerousActionPolicy || 'always-ask';
  if (policy === 'always-allow') return true;
  if (policy === 'always-deny') return false;
  // always-ask (default)
  if (!ctx.confirm) return false; // no confirmation channel available → refuse by default
  return ctx.confirm(question);
}

export const ListDirTool: AgentTool = {
  definition: {
    name: 'list_dir',
    description: 'List the contents of a directory. Requires fileRead permission. In workspace scope, paths outside the workspace are blocked.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (relative or absolute)' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.permissions.fileRead) return { success: false, output: 'Permission denied: fileRead is disabled. Enable it via /permissions.' };
    const resolved = resolvePath(String(args.path || ''), ctx);
    if (!resolved.ok) return { success: false, output: resolved.error };
    try {
      const entries = fs.readdirSync(resolved.abs, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
      const lines = [
        `Directory: ${resolved.abs}`,
        `[${dirs.length} dirs] ${dirs.join('  ')}`,
        `[${files.length} files] ${files.slice(0, 200).join('  ')}${files.length > 200 ? ` …(+${files.length - 200} more)` : ''}`,
      ];
      return { success: true, output: lines.join('\n') };
    } catch (e) {
      return { success: false, output: `list_dir failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

export const ReadFileTool: AgentTool = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a text file. Requires fileRead permission. Large files are truncated with a note.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.permissions.fileRead) return { success: false, output: 'Permission denied: fileRead is disabled.' };
    const resolved = resolvePath(String(args.path || ''), ctx);
    if (!resolved.ok) return { success: false, output: resolved.error };
    let fd: number | undefined;
    try {
      const stat = fs.statSync(resolved.abs);
      if (!stat.isFile()) return { success: false, output: `Not a file: ${resolved.abs}` };
      fd = fs.openSync(resolved.abs, 'r');
      const readLength = Math.min(stat.size, MAX_SINGLE_FILE_READ_BYTES);
      const buffer = Buffer.alloc(readLength);
      let offset = 0;
      while (offset < readLength) {
        const count = fs.readSync(fd, buffer, offset, readLength - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const sample = buffer.subarray(0, Math.min(offset, 8192));
      if (sample.includes(0)) return { success: false, output: `Binary file is not read as text: ${resolved.abs}` };
      let content = buffer.subarray(0, offset).toString('utf8');
      const truncated = stat.size > readLength || content.length > 16000;
      if (content.length > 16000) content = content.slice(0, 16000);
      if (truncated) content += '\n…[truncated, file is larger]';
      return { success: true, output: `File: ${resolved.abs} (${stat.size} bytes)${truncated ? ' — TRUNCATED' : ''}\n${content}` };
    } catch (e) {
      return { success: false, output: `read_file failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
  },
};

export const WorkspaceTreeTool: AgentTool = {
  definition: {
    name: 'get_workspace_tree',
    description: 'Explicitly request the workspace directory tree. No file contents are included. Requires fileRead permission. Symlinks are listed but never traversed. By default, common generated/dependency folders (.git, node_modules, caches, coverage) are excluded; set includeIgnored=true to include them.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to inspect; defaults to the workspace root.' },
        includeIgnored: { type: 'boolean', description: 'Include common generated/dependency directories; defaults to false.' },
        maxEntries: { type: 'integer', description: 'Maximum entries to return; defaults to 10000, maximum 50000.' },
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.permissions.fileRead) return { success: false, output: 'Permission denied: fileRead is disabled. Enable it via /permissions.' };
    const requestedPath = String(args.path || '.');
    const requestedAbsolute = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(ctx.cwd, requestedPath);
    if (hasSymbolicLinkComponent(requestedAbsolute)) {
      return { success: false, output: `Symbolic-link paths are not traversed by get_workspace_tree: ${requestedPath}` };
    }
    const resolved = resolvePath(requestedPath, ctx);
    if (!resolved.ok) return { success: false, output: resolved.error };
    try {
      if (!fs.statSync(resolved.abs).isDirectory()) return { success: false, output: `Not a directory: ${resolved.abs}` };
      const includeIgnored = args.includeIgnored === true;
      const requestedMax = Number(args.maxEntries);
      const maxEntries = Number.isInteger(requestedMax) && requestedMax > 0 ? Math.min(requestedMax, 50000) : 10000;
      const lines = [`Workspace tree: ${resolved.abs}`, `Ignored folders: ${includeIgnored ? 'included' : [...DEFAULT_IGNORED_DIRECTORIES].join(', ')}`];
      let count = 0;
      let truncated = false;
      const walk = (directory: string, depth: number): void => {
        if (truncated) return;
        if (depth > MAX_WORKSPACE_SCAN_DEPTH) {
          lines.push(`${'  '.repeat(depth)}[maximum tree depth (${MAX_WORKSPACE_SCAN_DEPTH}) reached]`);
          return;
        }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
        catch (error) {
          lines.push(`${'  '.repeat(depth)}[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (!includeIgnored && entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
          if (count >= maxEntries) { truncated = true; return; }
          const prefix = '  '.repeat(depth);
          if (entry.isDirectory()) {
            lines.push(`${prefix}${entry.name}/`);
            count += 1;
            walk(path.join(directory, entry.name), depth + 1);
          } else if (entry.isSymbolicLink()) {
            lines.push(`${prefix}${entry.name} [symlink; not followed]`);
            count += 1;
          } else if (entry.isFile()) {
            lines.push(`${prefix}${entry.name}`);
            count += 1;
          }
          if (truncated) return;
        }
      };
      walk(resolved.abs, 0);
      if (truncated) lines.push(`…[tree truncated at ${maxEntries} entries; request a subdirectory or a higher maxEntries value (up to 50000)]`);
      return { success: true, output: lines.join('\n') };
    } catch (error) {
      return { success: false, output: `get_workspace_tree failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

export const ReadFilesTool: AgentTool = {
  definition: {
    name: 'read_files',
    description: 'Explicitly read several text files, or all text files in the workspace when all=true. Requires fileRead permission. Does not follow symlinks. Binary files are skipped. The default total output budget is 1 MiB; increase maxTotalBytes when needed. For large workspaces, prefer a small paths list or includeIgnored=true only when necessary.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'One or more file paths. Required unless all=true.' },
        all: { type: 'boolean', description: 'Read all discovered text files; defaults to false.' },
        includeIgnored: { type: 'boolean', description: 'Include common generated/dependency folders when all=true; defaults to false.' },
        maxTotalBytes: { type: 'integer', description: 'Total content budget in bytes; defaults to 1048576 (1 MiB), maximum 10485760 (10 MiB).' },
        maxFiles: { type: 'integer', description: 'Maximum files to discover when all=true; defaults to 10000, maximum 50000.' },
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.permissions.fileRead) return { success: false, output: 'Permission denied: fileRead is disabled. Enable it via /permissions.' };
    const rootResult = resolvePath('.', ctx);
    if (!rootResult.ok) return { success: false, output: rootResult.error };
    const all = args.all === true;
    const rawPaths = Array.isArray(args.paths) ? args.paths : [];
    if (!all && rawPaths.length === 0) return { success: false, output: 'Provide paths[] or set all=true.' };
    const requestedBudget = Number(args.maxTotalBytes);
    const requestedBudgetValid = Number.isSafeInteger(requestedBudget) && requestedBudget > 0;
    const maxTotalBytes = requestedBudgetValid
      ? Math.min(requestedBudget, MAX_READ_FILES_BUDGET)
      : DEFAULT_READ_FILES_BUDGET;
    const budgetClamped = requestedBudgetValid && requestedBudget > MAX_READ_FILES_BUDGET;
    const paths: string[] = [];
    let scanTruncated = false;
    let scanErrors: string[] = [];
    let explicitPathsTruncated = false;
    if (all) {
      const requestedMaxFiles = Number(args.maxFiles);
      const maxFiles = Number.isSafeInteger(requestedMaxFiles) && requestedMaxFiles > 0
        ? Math.min(requestedMaxFiles, MAX_WORKSPACE_SCAN_FILES)
        : 10000;
      const discovered = collectWorkspaceFiles(rootResult.abs, args.includeIgnored === true, maxFiles);
      paths.push(...discovered.files);
      scanTruncated = discovered.truncated;
      scanErrors = discovered.errors;
    } else {
      for (const item of rawPaths) {
        if (typeof item === 'string' && item.trim()) paths.push(item.trim());
        if (paths.length >= MAX_EXPLICIT_FILE_PATHS) { explicitPathsTruncated = rawPaths.length > MAX_EXPLICIT_FILE_PATHS; break; }
      }
    }
    const uniquePaths = [...new Set(paths)];
    const output: string[] = [`Requested file context: ${all ? 'all workspace text files' : `${uniquePaths.length} file(s)`}`, `Total output budget: ${maxTotalBytes} bytes`];
    if (budgetClamped) output.push(`Requested byte budget was capped at ${MAX_READ_FILES_BUDGET} bytes (10 MiB).`);
    if (explicitPathsTruncated) output.push(`Explicit path list was capped at ${MAX_EXPLICIT_FILE_PATHS} entries.`);
    if (scanTruncated) output.push(`Workspace file discovery was capped at ${uniquePaths.length} files. Use a narrower directory or request a different subset.`);
    if (scanErrors.length) output.push(`Workspace scan reported ${scanErrors.length} unreadable/depth-limited directory condition(s).`);
    let bytesUsed = 0;
    let readCount = 0;
    let skippedBinary = 0;
    let truncated = false;
    for (const requestedPath of uniquePaths) {
      const requestedAbsolute = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(ctx.cwd, requestedPath);
      if (hasSymbolicLinkComponent(requestedAbsolute)) {
        output.push(`\n[skipped] ${requestedPath}: symbolic links are not read by read_files`);
        continue;
      }
      const resolved = resolvePath(requestedPath, ctx);
      if (!resolved.ok) {
        output.push(`\n[blocked/unavailable] ${requestedPath}: ${resolved.error}`);
        continue;
      }
      try {
        const stat = fs.statSync(resolved.abs);
        if (!stat.isFile()) {
          output.push(`\n[skipped] ${requestedPath}: not a regular file`);
          continue;
        }
        if (bytesUsed >= maxTotalBytes) { truncated = true; break; }
        const remaining = maxTotalBytes - bytesUsed;
        const fd = fs.openSync(resolved.abs, 'r');
        try {
          const currentStat = fs.fstatSync(fd);
          if (!currentStat.isFile()) { output.push(`\n[skipped] ${requestedPath}: not a regular file`); continue; }
          const sampleLength = Math.min(currentStat.size, 8192);
          const sample = Buffer.alloc(sampleLength);
          const sampleRead = sampleLength ? fs.readSync(fd, sample, 0, sampleLength, 0) : 0;
          if (sample.subarray(0, sampleRead).includes(0)) { skippedBinary += 1; continue; }
          const take = Math.min(currentStat.size, remaining);
          const buffer = Buffer.alloc(take);
          let offset = 0;
          while (offset < take) {
            const count = fs.readSync(fd, buffer, offset, take - offset, offset);
            if (count === 0) break;
            offset += count;
          }
          const content = buffer.subarray(0, offset).toString('utf8');
          output.push(`\n===== ${path.relative(rootResult.abs, resolved.abs) || path.basename(resolved.abs)} (${currentStat.size} bytes) =====\n${content}`);
          bytesUsed += offset;
          readCount += 1;
          if (offset < currentStat.size) { output.push(`\n[truncated at ${offset} of ${currentStat.size} bytes; increase maxTotalBytes (up to 10 MiB) or request this file separately]`); truncated = true; break; }
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        output.push(`\n[read failed] ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    output.push(`\nRead ${readCount} text file(s), ${bytesUsed} byte(s); skipped ${skippedBinary} binary file(s).`);
    if (truncated) output.push('Output budget reached. Request the remaining paths separately or raise maxTotalBytes.');
    if (all) output.push(`Discovered ${uniquePaths.length} file(s) in the selected scan scope.`);
    return { success: true, output: output.join('\n') };
  },
};

export const WriteFileTool: AgentTool = {
  definition: {
    name: 'write_file',
    description: 'Create or overwrite a text file atomically (temp file + rename). Requires fileWrite permission. Overwriting an existing file is a dangerous action and may require confirmation. Returns a summary, not the full content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.permissions.fileWrite) return { success: false, output: 'Permission denied: fileWrite is disabled. Enable it via /permissions.' };
    const resolved = resolvePath(String(args.path || ''), ctx);
    if (!resolved.ok) return { success: false, output: resolved.error };
    const content = String(args.content ?? '');
    const existed = fs.existsSync(resolved.abs);
    if (existed) {
      const ok = await confirmDangerous(ctx as never, `Overwrite existing file ${resolved.abs}?`);
      if (!ok) return { success: false, output: `[blocked] Overwrite of ${resolved.abs} was not confirmed.` };
    }
    try {
      const dir = path.dirname(resolved.abs);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${resolved.abs}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      fs.renameSync(tmp, resolved.abs); // atomic on same filesystem
      return { success: true, output: `${existed ? 'Modified' : 'Created'}: ${resolved.abs} (${Buffer.byteLength(content, 'utf8')} bytes)` };
    } catch (e) {
      return { success: false, output: `write_file failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

export const DeleteFileTool: AgentTool = {
  definition: {
    name: 'delete_file',
    description: 'Delete a file. Requires fileWrite permission. Deletion is a dangerous action and requires confirmation unless policy allows. Returns a summary.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to delete' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.permissions.fileWrite) return { success: false, output: 'Permission denied: fileWrite is disabled.' };
    const resolved = resolvePath(String(args.path || ''), ctx);
    if (!resolved.ok) return { success: false, output: resolved.error };
    const ok = await confirmDangerous(ctx as never, `Delete file ${resolved.abs}? This cannot be undone.`);
    if (!ok) return { success: false, output: `[blocked] Deletion of ${resolved.abs} was not confirmed.` };
    try {
      if (!fs.existsSync(resolved.abs)) return { success: false, output: `File does not exist: ${resolved.abs}` };
      fs.unlinkSync(resolved.abs);
      return { success: true, output: `Deleted: ${resolved.abs}` };
    } catch (e) {
      return { success: false, output: `delete_file failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

export const FileSystemTools = [ListDirTool, ReadFileTool, WorkspaceTreeTool, ReadFilesTool, WriteFileTool, DeleteFileTool];
