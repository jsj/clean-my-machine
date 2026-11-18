import checkbox from '@inquirer/checkbox';
import confirm from '@inquirer/confirm';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { findBrewBinary } from '../scanners/homebrew.js';
import { measureCleanupVolumes, printFreeSpaceChanges } from '../utils/volumes.js';

const read = promisify(execFile);

async function findOnPath(name: string) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function packageLocation(executable: string, args: string[]) {
  try {
    const { stdout } = await read(executable, args, { cwd: homedir(), timeout: 5000 });
    const path = stdout.trim();
    return isAbsolute(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

interface PackageTask {
  label: string;
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function runPackageTask(task: PackageTask) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(task.executable, task.args, {
      cwd: homedir(), stdio: 'inherit', env: task.env,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ?? `exit code ${code}`));
    });
  });
}

export async function packageMaintenance() {
  const [brew, npm] = await Promise.all([
    findOnPath('brew').then(path => path ?? findBrewBinary()),
    findOnPath('npm'),
  ]);
  const tasks: Record<string, PackageTask> = {};
  if (brew) {
    tasks.upgrade = {
      label: 'Upgrade Homebrew packages (brew upgrade)',
      executable: brew, args: ['upgrade'],
      env: { ...process.env, HOMEBREW_NO_INSTALL_CLEANUP: '1' },
    };
    tasks.cleanup = {
      label: 'Remove old Homebrew versions and downloads (brew cleanup)',
      executable: brew, args: ['cleanup'],
    };
  }
  if (npm) {
    tasks.npm = {
      label: 'Update global npm packages (npm update --global)',
      executable: npm, args: ['update', '--global'],
    };
  }
  if (!Object.keys(tasks).length) {
    console.log('Homebrew and npm were not found.');
    return;
  }

  const selected = await checkbox({
    message: 'Select package maintenance tasks, or press Enter to go back',
    choices: Object.entries(tasks).map(([value, task]) => ({ value, name: task.label })),
  });
  if (!selected.length || !await confirm({
    message: 'Run the selected package maintenance tasks?',
    default: false,
  })) return;

  const locations = await Promise.all([
    brew && selected.some(id => id === 'upgrade' || id === 'cleanup') ? packageLocation(brew, ['--prefix']) : undefined,
    brew && selected.includes('cleanup') ? packageLocation(brew, ['--cache']) : undefined,
    npm && selected.includes('npm') ? packageLocation(npm, ['prefix', '--global']) : undefined,
  ]);
  const before = await measureCleanupVolumes([], locations.filter(path => path !== undefined));

  let upgradeFailed = false;
  for (const [id, task] of Object.entries(tasks)) {
    if (!selected.includes(id)) continue;
    if (id === 'cleanup' && upgradeFailed) {
      console.log('Skipped Homebrew cleanup after the upgrade failed.');
      continue;
    }
    console.log(`\n${task.label}`);
    try {
      await runPackageTask(task);
    } catch (error) {
      if (id === 'upgrade') upgradeFailed = true;
      process.exitCode = 1;
      console.error(`${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await printFreeSpaceChanges(before);
}
