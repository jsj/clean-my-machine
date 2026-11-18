import checkbox from '@inquirer/checkbox';
import confirm from '@inquirer/confirm';
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { formatSize } from '../utils/size.js';
import { availableBytes } from '../utils/volumes.js';

const run = promisify(execFile);
const simctl = async (...args: string[]) =>
  (await run('/usr/bin/xcrun', ['simctl', ...args], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout;

const cleanupPaths = {
  caches: 'Library/Caches',
  logs: 'Library/Logs',
  temporary: 'tmp',
} as const;
type Category = keyof typeof cleanupPaths;

interface Device {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
  dataPath: string;
  dataPathSize?: number;
}

interface Runtime {
  runtimeIdentifier: string;
  version: string;
  build: string;
  state: string;
  sizeBytes?: number;
}

async function devices() {
  const result = JSON.parse(await simctl('list', 'devices', '-j')) as { devices: Record<string, Device[]> };
  return Object.entries(result.devices).flatMap(([runtime, entries]) =>
    entries.map(device => ({ ...device, runtime })));
}

async function hostSwap() {
  try {
    return (await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 5000 })).stdout.trim();
  } catch {
    return null;
  }
}

function swapUsedBytes(swap: string | null) {
  const match = swap?.match(/\bused\s*=\s*([\d.]+)\s*([KMGTP])/i);
  if (!match) return 0;
  return Number(match[1]) * 1024 ** ('KMGTP'.indexOf(match[2].toUpperCase()) + 1);
}

function size(bytes?: number) {
  return bytes === undefined ? 'size unavailable' : formatSize(bytes);
}

export async function xcodeInventory(json: boolean, knownDevices?: Awaited<ReturnType<typeof devices>>) {
  const [deviceList, runtimeResult, freeBytes, swap] = await Promise.all([
    knownDevices ?? devices(),
    simctl('runtime', 'list', '-j').then(raw => ({
      entries: Object.values(JSON.parse(raw) as Record<string, Runtime>),
      error: null,
    })).catch(() => ({ entries: [], error: 'Runtime image sizes are unavailable from simctl.' })),
    availableBytes(homedir()),
    hostSwap(),
  ]);
  const slimHints = swapUsedBytes(swap) >= 1024 ** 3
    ? deviceList.filter(device => device.state === 'Booted').map(device =>
      `xc runtime simulator slim on --destination ${device.udid}`)
    : [];
  if (json) {
    console.log(JSON.stringify({
      devices: deviceList, runtimes: runtimeResult.entries, runtimeError: runtimeResult.error,
      freeBytes, volumePath: homedir(), swap, slimHints,
    }, null, 2));
    return;
  }
  console.log(`Available on home volume: ${size(freeBytes)}`);
  console.log(`Host swap (diagnostic): ${swap ?? 'unavailable'}`);
  console.log('\nSimulator devices');
  for (const device of deviceList) {
    console.log(`  ${device.name}  ${device.udid}  ${device.state}  ${device.runtime}  ${size(device.dataPathSize)}${device.isAvailable ? '' : '  unavailable'}`);
  }
  console.log('\nShared runtime images');
  if (runtimeResult.error) console.log(`  ${runtimeResult.error}`);
  for (const runtime of runtimeResult.entries) {
    console.log(`  ${runtime.runtimeIdentifier}  ${runtime.version} (${runtime.build})  ${runtime.state}  ${size(runtime.sizeBytes)}`);
  }
  if (slimHints.length) {
    console.log('\nOptional XC commands to reduce simulator memory use');
    for (const hint of slimHints) console.log(`  ${hint}`);
  }
}

export async function reviewSimulatorsFromDefaultCommand() {
  const deviceList = await devices().catch(() => []);
  if (!deviceList.length) {
    console.log('No Xcode simulators found.');
    return;
  }

  await xcodeInventory(false, deviceList);
  const [udid] = await checkbox({
    message: 'Choose one simulator to preview, or press Enter to continue',
    choices: deviceList.map(device => ({
      name: `${device.name} · ${device.state} · ${size(device.dataPathSize)} · ${device.udid}`,
      value: device.udid,
    })),
    validate: selected => selected.length <= 1 || 'Select one simulator at a time.',
  });
  if (!udid) return;

  await simulatorCleanup(udid, {});
  if (deviceList.find(device => device.udid === udid)?.state !== 'Shutdown') return;

  const category = await checkbox({
    message: 'Select simulator files to clear, or press Enter to skip',
    choices: [
      { name: 'Caches', value: 'caches' as const },
      { name: 'Logs', value: 'logs' as const },
      { name: 'Temporary files', value: 'temporary' as const },
    ],
  });
  if (category.length && await confirm({
    message: 'Permanently clear the selected files on this simulator?',
    default: false,
  })) {
    await simulatorCleanup(udid, { category, confirm: true });
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function directoryOnVolume(root: string, relativePath: string, deviceNumber: number) {
  let path = root;
  for (const component of relativePath.split('/')) {
    path = join(path, component);
    const info = await lstatIfPresent(path);
    if (!info?.isDirectory() || info.dev !== deviceNumber) return undefined;
  }
  return path;
}

async function allocatedBytes(path: string) {
  const { stdout } = await run('/usr/bin/du', ['-skx', path], { timeout: 30000 });
  return Number(stdout.split(/\s+/, 1)[0]) * 1024;
}

async function clearContents(path: string, deviceNumber: number) {
  if (await realpath(path) !== path || (await lstat(path)).dev !== deviceNumber) {
    throw new Error('Simulator cleanup directory changed while applying the plan.');
  }
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstatIfPresent(child);
    if (!info || info.dev !== deviceNumber) continue;
    if (info.isDirectory()) {
      await clearContents(child, deviceNumber);
      await rmdir(child);
    } else {
      await unlink(child);
    }
  }
}

export async function simulatorCleanup(udid: string, options: {
  confirm?: boolean;
  dryRun?: boolean;
  json?: boolean;
  category?: Category[];
}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid)) {
    throw new Error('Specify one exact simulator UDID.');
  }
  const device = (await devices()).find(item => item.udid.toUpperCase() === udid.toUpperCase());
  if (!device) throw new Error('Simulator UDID was not found.');
  const home = await realpath(homedir());
  const root = join(home, 'Library/Developer/CoreSimulator/Devices', device.udid, 'data');
  if (device.dataPath !== root || await realpath(root) !== root) {
    throw new Error('Simulator data must be in the standard device directory with no symlink components.');
  }

  const deviceNumber = (await lstat(root)).dev;
  const categories = [...new Set(options.category ?? Object.keys(cleanupPaths) as Category[])];
  const entries = await Promise.all(categories.map(async category => {
    const relativePath = cleanupPaths[category];
    const path = await directoryOnVolume(root, relativePath, deviceNumber);
    return { category, path, bytes: path ? await allocatedBytes(path) : 0 };
  }));
  const usagePaths = {
    installedApps: 'Containers/Bundle/Application',
    appDataAndDocuments: 'Containers/Data/Application',
    sharedAppData: 'Containers/Shared/AppGroup',
    userMedia: 'Media',
  };
  const usage = Object.fromEntries(await Promise.all(Object.entries(usagePaths).map(async ([label, relativePath]) => {
    const path = await directoryOnVolume(root, relativePath, deviceNumber);
    return [label, path ? await allocatedBytes(path) : 0] as const;
  })));

  const applied = Boolean(options.confirm && !options.dryRun);
  let freeSpaceChangeBytes: number | undefined;
  if (applied) {
    const current = (await devices()).find(item => item.udid === device.udid);
    if (current?.state !== 'Shutdown' || current.dataPath !== root) throw new Error('Shut down this simulator before cleaning it.');
    const before = await availableBytes(root);
    for (const entry of entries) {
      if (!entry.path) continue;
      const path = await directoryOnVolume(root, cleanupPaths[entry.category], deviceNumber);
      if (path !== entry.path || await realpath(path) !== path) {
        throw new Error('Simulator cleanup directory changed while applying the plan.');
      }
      await clearContents(path, deviceNumber);
    }
    freeSpaceChangeBytes = await availableBytes(root) - before;
  }

  if (options.json) {
    console.log(JSON.stringify({ device, entries, usage, applied, freeSpaceChangeBytes }, null, 2));
    return;
  }
  console.log(`${device.name} (${device.udid}), ${device.state}`);
  console.log(applied ? 'Cleanup completed' : 'Cleanup preview');
  for (const entry of entries) console.log(`  ${entry.category}: ${size(entry.bytes)}`);
  console.log('Usage only');
  for (const [label, bytes] of Object.entries(usage)) console.log(`  ${label}: ${size(bytes)}`);
  if (freeSpaceChangeBytes !== undefined) {
    console.log(`Observed free-space change: ${freeSpaceChangeBytes < 0 ? '-' : '+'}${size(Math.abs(freeSpaceChangeBytes))}`);
  } else {
    console.log('To apply, shut down this device and rerun with --confirm.');
  }
}
