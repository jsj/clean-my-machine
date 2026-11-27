import confirm from '@inquirer/confirm';
import select from '@inquirer/select';
import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { runScans } from '../scanners/index.js';
import { formatSize, sanitizeDisplayName } from '../utils/index.js';
import { measureCleanupVolumes, printFreeSpaceChanges } from '../utils/volumes.js';

function run(cwd: string, executable: string, ...args: string[]): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    execFile(executable, args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolveOutput(stdout);
    });
  });
}

function git(cwd: string, ...args: string[]): Promise<Buffer> {
  return run(cwd, 'git', ...args);
}

const readProcessList = promisify(execFile);

async function processDirectories(): Promise<string[] | null> {
  try {
    const { stdout } = await readProcessList('/usr/sbin/lsof', ['-nP', '-d', 'cwd', '-F0n'], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const paths = stdout.split('\0').filter(field => field.startsWith('n/')).map(field => field.slice(1));
    return paths.length ? paths : null;
  } catch {
    return null;
  }
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

async function removableWorktree(path: string, directories: string[] | null) {
  const target = await realpath(path);
  if (!directories) throw new Error('Could not verify whether a process is using this worktree.');
  if (directories.some(directory => containsPath(target, directory) || containsPath(path, directory))) {
    throw new Error('A process is working inside this checkout.');
  }
  if (containsPath(target, await realpath(process.cwd()))) {
    throw new Error('Exit this worktree before removing it.');
  }

  let topLevel: string;
  let commonDir: string;
  let gitDir: string;
  try {
    [topLevel, commonDir, gitDir] = await Promise.all([
      git(target, 'rev-parse', '--show-toplevel'),
      git(target, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      git(target, 'rev-parse', '--absolute-git-dir'),
    ]).then(paths => Promise.all(paths.map(value => realpath(value.toString().replace(/\n$/, '')))));
  } catch {
    throw new Error('Git could not verify this linked worktree. It needs manual review.');
  }

  if (topLevel !== target || dirname(gitDir) !== join(commonDir, 'worktrees')) {
    throw new Error('Git could not verify this linked worktree. It needs manual review.');
  }

  const metadata = new Set(await readdir(gitDir));
  if (metadata.has('locked')) throw new Error('Git has locked this worktree.');
  if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer']
      .some(entry => metadata.has(entry))) {
    throw new Error('A Git operation is in progress in this worktree.');
  }

  const [head, status, index, reflog, identity] = await Promise.all([
    git(target, 'rev-parse', 'HEAD'),
    git(target, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'),
    git(target, 'ls-files', '-v', '-z'),
    git(target, 'reflog', 'show', '--format=%H', 'HEAD'),
    stat(target),
  ]);
  if (status.length) throw new Error('This worktree contains modified, untracked, or ignored files.');
  if (index.toString().split('\0').some(entry => /^[a-zS] /.test(entry))) {
    throw new Error('This worktree has files marked to skip Git status checks. It needs manual review.');
  }
  const commit = head.toString().trim();

  try {
    await git(dirname(target), `--git-dir=${commonDir}`, 'merge-base', '--is-ancestor', commit, 'HEAD');
  } catch {
    throw new Error('This worktree has commits that are not in the primary checkout’s history, or Git could not verify its history.');
  }

  // Removing a worktree also removes its HEAD reflog.
  const previousHeads = [...new Set(reflog.toString().trim().split('\n').filter(Boolean))];
  for (let offset = 0; offset < previousHeads.length; offset += 128) {
    const unique = await git(dirname(target), `--git-dir=${commonDir}`, 'rev-list',
      '--single-worktree', '--max-count=1', ...previousHeads.slice(offset, offset + 128), '--not', '--all');
    if (unique.length) throw new Error('This worktree’s reflog contains commits without a shared Git ref.');
  }

  return { target, commonDir, commit, device: identity.dev, inode: identity.ino };
}

export async function reviewAgentWorktrees(): Promise<void> {
  console.log('Looking for older and orphaned worktrees…');
  const { results } = await runScans(['git-worktrees']);
  const result = results[0];
  if (result?.error) throw new Error(result.error);
  if (!result?.items.length) {
    console.log('No older or orphaned worktrees found.');
    return;
  }

  const directories = await processDirectories();
  const eligible = new Map<string, Awaited<ReturnType<typeof removableWorktree>>>();
  const choices = [];
  for (const item of result.items) {
    const choice = {
      name: `${sanitizeDisplayName(item.path)} · ${formatSize(item.size)} · ${item.detail ?? 'older worktree'}`,
      value: item.path,
    };
    try {
      eligible.set(item.path, await removableWorktree(item.path, directories));
      choices.push({ ...choice, description: 'Clean checkout with commits in the primary checkout’s history.' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      choices.push({ ...choice, disabled: sanitizeDisplayName(reason.split('\n')[0]) });
    }
  }

  const path = await select({
    message: 'Review a worktree',
    choices: [...choices, { name: 'Back', value: null }],
  });
  if (path === null) return;
  const reviewed = eligible.get(path);
  if (!reviewed) return;

  try {
    if (!await confirm({ message: `Remove ${sanitizeDisplayName(reviewed.target)}?`, default: false })) return;

    const volumesBefore = await measureCleanupVolumes([reviewed.target]);
    const current = await removableWorktree(path, await processDirectories());
    if (current.target !== reviewed.target || current.commonDir !== reviewed.commonDir
        || current.commit !== reviewed.commit || current.device !== reviewed.device || current.inode !== reviewed.inode) {
      throw new Error('The worktree changed during review. Scan again before removing it.');
    }
    await git(dirname(current.target), `--git-dir=${current.commonDir}`, 'worktree', 'remove', '--', current.target);
    console.log(`Removed ${sanitizeDisplayName(current.target)}.`);
    await printFreeSpaceChanges(volumesBefore);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}
