#!/usr/bin/env node

import select from '@inquirer/select';
import { reviewAgentWorktrees } from './commands/worktree.js';
import { packageMaintenance } from './commands/packages.js';
import { browseLargestFolders } from './commands/storage.js';
import { Command, InvalidArgumentError, Option } from 'commander';
import { ExitPromptError } from '@inquirer/core';
import { appInstallCommand, cleanCommand, interactiveCommand, listCategories, maintenanceCommand, scanCommand, uninstallCommand } from './commands/index.js';
import { initConfig, configExists, listBackups, cleanOldBackups, restoreBackup, loadConfig, formatSize } from './utils/index.js';
import { reviewSimulatorsFromDefaultCommand, simulatorCleanup, xcodeInventory } from './commands/xcode.js';
import { formatError, isDebugEnabled } from './utils/errors.js';
import { CATEGORIES, type CategoryId, type Ecosystem } from './types.js';
import pkg from '../package.json' with { type: 'json' };

function parseCategoryId(value: string): CategoryId {
  if (!(value in CATEGORIES)) {
    throw new InvalidArgumentError(
      `Unknown category "${value}". Run "clean-my-machine categories" to list valid ids.`
    );
  }
  return value as CategoryId;
}

function parseCategoryIdList(value: string): CategoryId[] {
  return value.split(',').map((id) => parseCategoryId(id.trim()));
}

function appendOption(value: string, previous: string[] = []): string[] { return [...previous, value]; }
function parseEcosystems(value: string): Ecosystem[] {
  return value.split(',').map((part) => {
    const name = part.trim();
    if (!['node', 'rust', 'go'].includes(name)) throw new InvalidArgumentError(`Unknown ecosystem "${name}"`);
    return name as Ecosystem;
  });
}

/**
 * Terminates the CLI on an unrecoverable error: a cancelled prompt is a normal
 * exit, anything else is reported with a non-zero status (full stack with
 * MAC_CLEANER_DEBUG=1) instead of surfacing as an unhandled rejection.
 */
function handleFatalError(error: unknown): never {
  if (error instanceof ExitPromptError) {
    console.log('\n');
    process.exit(0);
  }

  console.error(`\nError: ${formatError(error)}`);
  if (isDebugEnabled() && error instanceof Error && error.stack) {
    console.error(error.stack);
  } else {
    console.error('Run again with MAC_CLEANER_DEBUG=1 for the full stack trace.');
  }
  process.exit(1);
}

/**
 * Wraps a command action so every failure goes through a single error path.
 */
function action<TArgs extends unknown[]>(
  run: (...args: TArgs) => Promise<unknown>
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await run(...args);
    } catch (error) {
      handleFatalError(error);
    }
  };
}

function setupErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => handleFatalError(reason));
  process.on('uncaughtException', (error) => handleFatalError(error));
}

function setupGracefulShutdown(): void {
  const handleExit = (signal: string) => {
    console.log(`\n${signal} received. Exiting...`);
    process.exit(0);
  };

  process.on('SIGINT', () => handleExit('SIGINT'));
  process.on('SIGTERM', () => handleExit('SIGTERM'));
  process.on('SIGQUIT', () => handleExit('SIGQUIT'));
}

setupErrorHandlers();
setupGracefulShutdown();

const program = new Command();

program
  .name(pkg.name)
  .description('Open source CLI tool to clean your Mac')
  .version(pkg.version)
  .option('--root <path>', 'Repository root override (repeatable)', appendOption)
  .option('--include <ecosystems>', 'Add ecosystems (node,rust,go)', parseEcosystems)
  .option('--exclude <pattern>', 'Keep matching repository paths (repeatable)', appendOption)
  .option('--live', 'Review discovery live with sorting, search and paging')
  .option('-r, --risky', 'Include risky categories (downloads, iOS backups, etc)')
  .option('-f, --file-picker', 'Force file picker for ALL categories')
  .option('-A, --absolute-paths', 'Show absolute paths instead of truncated notations')
  .option('-d, --dry-run', 'Show what would be deleted without deleting anything')
  .option('--no-progress', 'Disable progress bar')
  .action(action(async (options) => {
    const scanForCleanup = async () => {
      const config = await loadConfig();
      await interactiveCommand({
        live: options.live ?? program.opts().live,
        roots: [...(program.opts().root ?? []), ...(options.root ?? [])],
        includeEcosystems: [...(program.opts().include ?? []), ...(options.include ?? [])],
        excludePaths: [...(program.opts().exclude ?? []), ...(options.exclude ?? [])],
        includeRisky: options.risky,
        filePicker: options.filePicker ?? config.filePicker,
        absolutePaths: options.absolutePaths,
        dryRun: options.dryRun ?? program.opts().dryRun,
        noProgress: !options.progress,
      });
    };
    if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) {
      await scanForCleanup();
      return;
    }

    while (true) {
      const task = await select({
        message: 'Clean My Machine',
        choices: [
          { name: 'Scan for cleanup and review package updates', value: 'clean' },
          { name: 'Review agent worktrees', value: 'worktrees' },
          { name: 'Map largest folders', value: 'storage' },
          { name: 'Review Xcode simulator storage', value: 'xcode' },
          { name: 'Exit', value: 'exit' },
        ],
      });
      if (task === 'exit') return;
      if (task === 'clean') {
        await scanForCleanup();
        await packageMaintenance();
      } else if (task === 'worktrees') {
        await reviewAgentWorktrees();
      } else if (task === 'storage') {
        await browseLargestFolders();
      } else {
        await reviewSimulatorsFromDefaultCommand();
      }
    }
  }));

program
  .command('scan')
  .description('Scan for cleanable files without deleting anything')
  .option('--root <path>', 'Repository root override (repeatable)', appendOption)
  .option('--include <ecosystems>', 'Add ecosystems (node,rust,go)', parseEcosystems)
  .option('--exclude <pattern>', 'Keep matching repository paths (repeatable)', appendOption)
  .option('--live', 'Live read-only review (interactive terminal only)')
  .option('-c, --category <id>', 'Scan a single category', parseCategoryId)
  .option('-v, --verbose', 'Show the largest items in each category')
  .option('--json', 'Output results as JSON (for scripts and integrations)')
  .option('--no-progress', 'Disable progress bar')
  .action(action(async (options) => {
    await scanCommand({
      live: options.live ?? program.opts().live,
      roots: [...(program.opts().root ?? []), ...(options.root ?? [])],
      includeEcosystems: [...(program.opts().include ?? []), ...(options.include ?? [])],
      excludePaths: [...(program.opts().exclude ?? []), ...(options.exclude ?? [])],
      category: options.category,
      verbose: options.verbose,
      json: options.json,
      noProgress: !options.progress,
    });
  }));

program
  .command('clean')
  .description('Clean cleanable files (non-interactive with --all or --categories)')
  .option('--root <path>', 'Repository root override (repeatable)', appendOption)
  .option('--include <ecosystems>', 'Add ecosystems (node,rust,go)', parseEcosystems)
  .option('--exclude <pattern>', 'Keep matching repository paths (repeatable)', appendOption)
  .option('--json', 'Output one JSON result; requires --all/--categories and --yes for actual cleanup')
  .option('-a, --all', 'Clean all non-risky categories without selection')
  .option('-c, --categories <ids>', 'Comma-separated category ids to clean (e.g. trash,browser-cache)', parseCategoryIdList)
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('-d, --dry-run', 'Show what would be cleaned without deleting')
  .option('--unsafe', 'Include risky categories (downloads, iOS backups, etc)')
  .option('--no-progress', 'Disable progress bar')
  .action(action(async (options) => {
    await cleanCommand({
      json: options.json,
      live: options.live ?? program.opts().live,
      roots: [...(program.opts().root ?? []), ...(options.root ?? [])],
      includeEcosystems: [...(program.opts().include ?? []), ...(options.include ?? [])],
      excludePaths: [...(program.opts().exclude ?? []), ...(options.exclude ?? [])],
      all: options.all,
      categories: options.categories,
      yes: options.yes,
      dryRun: options.dryRun ?? program.opts().dryRun,
      unsafe: options.unsafe,
      noProgress: !options.progress,
    });
  }));

program
  .command('uninstall')
  .description('Uninstall applications and their related files')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('-d, --dry-run', 'Show what would be uninstalled without actually uninstalling')
  .option('--no-progress', 'Disable progress bar')
  .action(action(async (options) => {
    await uninstallCommand({
      yes: options.yes,
      dryRun: options.dryRun ?? program.opts().dryRun,
      noProgress: !options.progress,
    });
  }));

program
  .command('maintenance')
  .description('Run maintenance tasks (DNS flush, free purgeable space, Time Machine snapshots)')
  .option('--dns', 'Flush DNS cache')
  .option('--purgeable', 'Free purgeable space')
  .option('--timemachine', 'Delete Time Machine local snapshots')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('-d, --dry-run', 'Show what would be done without changing anything')
  .action(action(async (options) => {
    await maintenanceCommand({
      dns: options.dns,
      purgeable: options.purgeable,
      timemachine: options.timemachine,
      yes: options.yes,
      dryRun: options.dryRun ?? program.opts().dryRun,
    });
  }));

const xcode = program.command('xcode').description('Inspect Xcode simulator storage and host swap');

xcode.command('scan')
  .description('List simulator devices, shared runtimes, and host swap')
  .option('--json', 'Output JSON')
  .action(action(async options => xcodeInventory(options.json)));

xcode.command('clean')
  .description('Preview or clean caches, logs, and temporary files for one simulator')
  .argument('<udid>', 'Exact simulator UDID')
  .addOption(new Option('--category <category...>', 'Select categories').choices(['caches', 'logs', 'temporary']))
  .option('--confirm', 'Permanently clear selected files on a shut-down simulator')
  .option('--dry-run', 'Preview cleanup')
  .option('--json', 'Output JSON')
  .action(action(async (udid, options) => simulatorCleanup(udid, {
    ...options, dryRun: options.dryRun ?? program.opts().dryRun,
  })));

const app = program
  .command('app')
  .description('Install or update the Mac Cleaner menu bar app');

app
  .command('install')
  .alias('update')
  .description('Download the latest Mac Cleaner app from GitHub, verify it and install it into /Applications')
  .option('--no-open', 'Do not open the app after installing')
  .option('--dir <path>', 'Install into this folder instead of /Applications')
  .action(action(async (options) => {
    await appInstallCommand({ open: options.open, dir: options.dir });
  }));

program
  .command('categories')
  .description('List all available categories')
  .action(() => {
    listCategories();
  });

program
  .command('config')
  .description('Manage configuration')
  .option('--init', 'Create default configuration file')
  .option('--show', 'Show current configuration')
  .action(action(async (options) => {
    if (options.init) {
      const exists = await configExists();
      if (exists) {
        console.log('Configuration file already exists.');
        return;
      }
      const path = await initConfig();
      console.log(`Created configuration file at: ${path}`);
      return;
    }

    if (options.show) {
      const exists = await configExists();
      if (!exists) {
        console.log('No configuration file found. Run "clean-my-machine config --init" to create one.');
        return;
      }
      const config = await loadConfig();
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    console.log('Use --init to create config or --show to display current config.');
  }));

program
  .command('backup')
  .description('Manage backups')
  .option('--list', 'List all backups')
  .option('--restore <dir>', 'Restore a backup back to its original locations')
  .option('--clean', 'Delete old backups permanently (older than 7 days), reclaiming disk space')
  .action(action(async (options) => {
    if (options.list) {
      const backups = await listBackups();
      if (backups.length === 0) {
        console.log('No backups found. Backups only happen when "backupEnabled": true is set in ~/.maccleanerrc');
        return;
      }
      console.log('\nBackups:');
      for (const backup of backups) {
        console.log(`  ${backup.date.toLocaleDateString()} - ${formatSize(backup.size)}`);
        console.log(`    ${backup.path}`);
      }
      console.log('\nRestore with: clean-my-machine backup --restore <path>');
      return;
    }

    if (options.restore) {
      const result = await restoreBackup(options.restore);
      console.log(`Restored ${result.success} items.`);
      if (result.failed > 0) {
        console.log(`Failed: ${result.failed}`);
        for (const error of result.errors) {
          console.log(`  ✗ ${error}`);
        }
        process.exitCode = 1;
      }
      return;
    }

    if (options.clean) {
      const cleaned = await cleanOldBackups();
      console.log(`Cleaned ${cleaned} old backups.`);
      return;
    }

    console.log('Use --list to show backups, --restore <dir> to bring one back, or --clean to remove old ones.');
  }));

program.parseAsync().catch(handleFatalError);
