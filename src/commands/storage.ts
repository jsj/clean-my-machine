import select from '@inquirer/select';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { formatSize } from '../utils/size.js';
import { availableBytes, storageRoots } from '../utils/volumes.js';

const du = promisify(execFile);

function displayPath(path: string) {
  return path.replace(/[\p{Cc}\p{Cf}]/gu, char => JSON.stringify(char).slice(1, -1).replace(char, '�'));
}

async function folderSizes(path: string, dev: number) {
  const entries = await readdir(path, { withFileTypes: true });
  const folders = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const child = join(path, entry.name);
    const info = await stat(child).catch(() => undefined);
    return info?.dev === dev ? child : undefined;
  }));
  const allowed = new Set(folders.filter(folder => folder !== undefined));
  let partial = false;
  const output = await du('/usr/bin/du', ['-k', '-x', '-d', '1', path], {
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
  }).then(result => result.stdout).catch((error: { stdout?: string }) => {
    partial = true;
    return error.stdout ?? '';
  });
  const rows = output.split('\n').flatMap(line => {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (!match || !allowed.delete(match[2])) return [];
    return [{ path: match[2], bytes: Number(match[1]) * 1024 }];
  });
  rows.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { rows, partial: partial || allowed.size > 0 };
}

export async function browseLargestFolders() {
  const roots = await storageRoots();
  while (true) {
    const rootIndex = await select({
      message: 'Choose a location to map',
      choices: [
        ...roots.map((root, index) => ({ name: `${displayPath(root.label)} · ${displayPath(root.path)}`, value: index })),
        { name: 'Back to main menu', value: -1 },
      ],
    });
    if (rootIndex === -1) return;
    const root = roots[rootIndex];
    const stack = [root.path];
    const measured = new Map<string, Awaited<ReturnType<typeof folderSizes>>>();
    while (stack.length) {
      const path = stack[stack.length - 1];
      let result = measured.get(path);
      if (!result) {
        console.log(`\nMapping ${displayPath(path)}…`);
        result = await folderSizes(path, root.dev).catch(() => ({ rows: [], partial: true }));
        measured.set(path, result);
      }
      const free = await availableBytes(path).catch(() => undefined);
      console.log(`${displayPath(root.label)}${free === undefined ? '' : ` · ${formatSize(free)} available`}`);
      if (result.partial) console.log('Some folder sizes could not be measured.');
      const next = await select({
        message: result.rows.length ? 'Largest folders by allocated size' : 'No folders measured here',
        choices: [
          ...result.rows.map(row => ({ name: `${formatSize(row.bytes).padStart(10)}  ${displayPath(row.path.slice(path.length + 1))}`, value: row.path })),
          { name: stack.length > 1 ? 'Up one folder' : 'Back to locations', value: '' },
        ],
        pageSize: 12,
      });
      if (next) stack.push(next);
      else stack.pop();
    }
  }
}
