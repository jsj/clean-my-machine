import { readdir, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const dataVolume = '/System/Volumes/Data';

export async function availableBytes(path: string) {
  const volume = await statfs(path);
  return volume.bavail * volume.bsize;
}

export async function storageRoots() {
  const home = homedir();
  const internal = await stat(dataVolume).catch(() => undefined);
  const mounted = await readdir('/Volumes', { withFileTypes: true }).catch(() => []);
  const external = await Promise.all(mounted.filter(entry => entry.isDirectory()).map(async entry => {
    const path = join('/Volumes', entry.name);
    const info = await stat(path).catch(() => undefined);
    return info && info.dev !== internal?.dev ? { label: entry.name, path, dev: info.dev } : undefined;
  }));
  return [
    { label: 'Home folder', path: home, dev: (await stat(home)).dev },
    ...(internal ? [{ label: 'Internal data volume', path: dataVolume, dev: internal.dev }] : []),
    ...external.filter(entry => entry !== undefined),
  ];
}

export async function measureCleanupVolumes(paths: string[]) {
  const roots = await storageRoots().catch(() => []);
  const parents = await Promise.all([...new Set(paths.filter(path => path.startsWith('/')).map(path => dirname(path)))].map(async path => {
    const info = await stat(path).catch(() => undefined);
    return info ? { dev: info.dev, label: basename(path) || path, path } : undefined;
  }));
  const volumes = new Map<number, { label: string; path: string }>();
  for (const candidate of [...roots.slice(0, 1), ...parents]) {
    if (!candidate || volumes.has(candidate.dev)) continue;
    volumes.set(candidate.dev, roots.slice(1).find(root => root.dev === candidate.dev) ?? candidate);
  }
  return (await Promise.all([...volumes.values()].map(async volume => {
    const bytes = await availableBytes(volume.path).catch(() => undefined);
    return bytes === undefined ? undefined : { ...volume, bytes };
  }))).filter(volume => volume !== undefined);
}
