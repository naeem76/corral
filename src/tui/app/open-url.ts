// Open a pull-request URL in the browser without a shell.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { envGet, type Env } from '../../core/paths.ts';

/** True for an absolute http(s) URL without control characters or spaces. */
export function isWebUrl(url: string): boolean {
  if (/[\s\x00-\x1f\x7f"]/.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** The program and arguments that open `url`. No shell on any platform. */
export function openCommand(url: string, platform: NodeJS.Platform, env: Env): { file: string; args: string[] } {
  if (platform === 'win32') {
    const root = envGet(env, 'SystemRoot', platform) ?? 'C:\\Windows';
    // url.dll opens the default browser; rundll32 is a real .exe, so cmd.exe is never needed.
    return { file: path.win32.join(root, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') return { file: 'open', args: [url] };
  return { file: 'xdg-open', args: [url] };
}

export type Spawner = (file: string, args: string[]) => Promise<void>;

const defaultSpawner: Spawner = (file, args) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

export async function openUrl(url: string, opts: { platform?: NodeJS.Platform; env?: Env; spawner?: Spawner } = {}): Promise<void> {
  if (!isWebUrl(url)) throw new Error(`not an http(s) URL: ${url.slice(0, 80)}`);
  const { file, args } = openCommand(url, opts.platform ?? process.platform, opts.env ?? process.env);
  await (opts.spawner ?? defaultSpawner)(file, args);
}
