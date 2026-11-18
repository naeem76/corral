// Pull-request providers. The Azure DevOps provider (through `az`) is a later task.

import type { Project, PullRequest } from '../types.ts';

export interface PrProvider {
  /** True when the provider can work on this machine (for example `az` is installed and signed in). */
  available(): Promise<boolean>;
  list(project: Project): Promise<PullRequest[]>;
}

export const nullPrProvider: PrProvider = {
  available: async () => false,
  list: async () => [],
};
