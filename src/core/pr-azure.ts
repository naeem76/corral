// Pull requests from Azure DevOps through the `az` CLI.
// Placeholder with the final signature; the implementation is a separate task.

import type { PrProvider } from './pr.ts';
import { nullPrProvider } from './pr.ts';
import type { Runner } from './exe.ts';
import type { Env } from './paths.ts';

export interface AzurePrOptions {
  run?: Runner;
  env?: Env;
  platform?: NodeJS.Platform;
  /** How long a result stays valid, in milliseconds. */
  cacheMs?: number;
  now?: () => number;
}

export function createAzurePrProvider(_opts: AzurePrOptions = {}): PrProvider {
  return nullPrProvider;
}
