import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import confirm from '@inquirer/confirm';
import select from '@inquirer/select';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runScans } from '../scanners/index.js';
import { CATEGORIES } from '../types.js';
import { reviewAgentWorktrees } from './worktree.js';

vi.mock('@inquirer/confirm', () => ({ default: vi.fn() }));
vi.mock('@inquirer/select', () => ({ default: vi.fn() }));
vi.mock('../scanners/index.js', () => ({ runScans: vi.fn() }));

let directory: string;
let source: string;
let target: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  directory = await mkdtemp(join(tmpdir(), 'cmm-remove-worktree-'));
  source = join(directory, 'source');
  target = join(directory, 'target');
  git(directory, 'init', '-q', source);
  await writeFile(join(source, '.gitignore'), '.env\n');
  git(source, 'add', '.gitignore');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
  git(source, 'worktree', 'add', '--detach', target);
  const item = { path: target, name: 'target', size: 1, isDirectory: true };
  vi.mocked(runScans).mockResolvedValue({
    results: [{ category: CATEGORIES['git-worktrees'], items: [item], totalSize: 1 }],
    totalItems: 1,
    totalSize: 1,
  });
  vi.mocked(select).mockResolvedValue(target);
  vi.mocked(confirm).mockResolvedValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('removes a confirmed clean linked worktree through Git', async () => {
  await reviewAgentWorktrees();

  expect(confirm).toHaveBeenCalledOnce();
  expect(existsSync(target)).toBe(false);
  expect(git(source, 'worktree', 'list')).not.toContain('target');
});

it.each(['untracked.txt', '.env', '.gitignore'])('preserves worktrees with local changes to %s', async file => {
  await writeFile(join(target, file), 'local content');
  await reviewAgentWorktrees();

  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(join(target, file))).toBe(true);
});

it('preserves detached commits absent from the primary checkout', async () => {
  git(target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Unique');
  await reviewAgentWorktrees();

  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(target)).toBe(true);
});

it('checks again after confirmation before removing anything', async () => {
  vi.mocked(confirm).mockImplementation(async () => {
    await writeFile(join(target, '.env'), 'added during review');
    return true;
  });
  await reviewAgentWorktrees();

  expect(existsSync(join(target, '.env'))).toBe(true);
});

it('preserves a worktree whose reflog holds a detached commit', async () => {
  git(target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Unique');
  git(target, 'reset', '--hard', 'HEAD^');
  await reviewAgentWorktrees();

  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(target)).toBe(true);
});

it('preserves a worktree with changes hidden from Git status', async () => {
  git(target, 'update-index', '--assume-unchanged', '.gitignore');
  await writeFile(join(target, '.gitignore'), 'local content');
  await reviewAgentWorktrees();

  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(target)).toBe(true);
});

it('shows why a worktree with an active process is protected', async () => {
  const child = spawn('/bin/sleep', ['30'], { cwd: target });
  try {
    await once(child, 'spawn');
    await reviewAgentWorktrees();

    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      choices: expect.arrayContaining([expect.objectContaining({
        value: target,
        disabled: 'A process is working inside this checkout.',
      })]),
    }));
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(target)).toBe(true);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});

it('rechecks for processes that start during confirmation', async () => {
  let active: ReturnType<typeof spawn> | undefined;
  try {
    vi.mocked(confirm).mockImplementation(async () => {
      active = spawn('/bin/sleep', ['30'], { cwd: target });
      await once(active, 'spawn');
      return true;
    });

    await reviewAgentWorktrees();
    expect(confirm).toHaveBeenCalledOnce();
    expect(existsSync(target)).toBe(true);
  } finally {
    if (active) {
      active.kill();
      await once(active, 'exit');
    }
  }
});

it('protects a locked worktree and explains why', async () => {
  git(source, 'worktree', 'lock', target);
  await reviewAgentWorktrees();

  expect(select).toHaveBeenCalledWith(expect.objectContaining({
    choices: expect.arrayContaining([expect.objectContaining({
      value: target,
      disabled: 'Git has locked this worktree.',
    })]),
  }));
  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(target)).toBe(true);
});

it('returns to the menu when there are no worktrees', async () => {
  vi.mocked(runScans).mockResolvedValue({ results: [], totalItems: 0, totalSize: 0 });

  await reviewAgentWorktrees();

  expect(select).not.toHaveBeenCalled();
});

it('reports scan errors before offering removal', async () => {
  vi.mocked(runScans).mockResolvedValue({
    results: [{ category: CATEGORIES['git-worktrees'], items: [], totalSize: 0, error: 'Scan failed' }],
    totalItems: 0,
    totalSize: 0,
  });

  await expect(reviewAgentWorktrees()).rejects.toThrow('Scan failed');
  expect(select).not.toHaveBeenCalled();
});

it('leaves the checkout intact when returning to the menu or declining removal', async () => {
  vi.mocked(select).mockResolvedValueOnce(null);
  await reviewAgentWorktrees();
  expect(confirm).not.toHaveBeenCalled();

  vi.mocked(confirm).mockResolvedValueOnce(false);
  await reviewAgentWorktrees();
  expect(confirm).toHaveBeenCalledOnce();
  expect(existsSync(target)).toBe(true);
});

it('preserves a directory that Git cannot verify as a linked checkout', async () => {
  await writeFile(join(target, '.git'), 'gitdir: /missing-worktree-metadata\n');
  await reviewAgentWorktrees();

  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(target)).toBe(true);
});

it('preserves a worktree while a Git operation is in progress', async () => {
  const gitDir = git(target, 'rev-parse', '--absolute-git-dir').trim();
  await writeFile(join(gitDir, 'MERGE_HEAD'), git(target, 'rev-parse', 'HEAD'));
  await reviewAgentWorktrees();

  expect(confirm).not.toHaveBeenCalled();
  expect(existsSync(target)).toBe(true);
});
