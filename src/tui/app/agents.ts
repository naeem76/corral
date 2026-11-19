// Agent-specific UI rules: which agents can start a session, the `n` menu, the agent tag of a
// row, the actions an agent cannot do, and the wording of the service badge and the empty
// states for each combination of agents (both, OpenCode only, Copilot only, none).

import type { AgentId, SessionRow } from '../../types.ts';
import { AGENT_NAMES } from '../../types.ts';
import { defaultTheme, style, type Style } from '../style.ts';
import { createMenu } from '../widgets/menu.ts';
import type { App } from './app.ts';

const th = defaultTheme;
const ORDER: AgentId[] = ['opencode', 'copilot'];

export const COPILOT_RENAME = 'Copilot sessions cannot be renamed here. Rename it in Copilot with /rename.';
export const COPILOT_DELETE = 'Copilot sessions cannot be deleted here. Delete it in Copilot with /session delete, or archive it here with a.';
export const INSTALL_HINT =
  'Install OpenCode (opencode service start) or the GitHub Copilot CLI (winget install GitHub.Copilot, or npm i -g @github/copilot), then start this program again.';

/** True when the agent's program is on this machine (it may still not run now). */
export function installed(app: App, agent: AgentId): boolean {
  return app.agentInstalled(agent);
}

/** Agents that can start a new session now, in a fixed order. */
export function startableAgents(app: App): AgentId[] {
  const out: AgentId[] = [];
  for (const info of app.deps.hub.agents()) {
    // OpenCode: the service runs, or the program can start it. Copilot: the program is there.
    const ok = info.agent === 'opencode' ? info.available || installed(app, 'opencode') : installed(app, info.agent);
    if (ok) out.push(info.agent);
  }
  return ORDER.filter((a) => out.includes(a));
}

/** Agents that are in use here: available, or with sessions in the watched folders. */
export function agentsInUse(app: App): AgentId[] {
  const rows = app.deps.hub.agentsWithRows();
  const out = app.deps.hub.agents().filter((i) => i.available || rows.has(i.agent)).map((i) => i.agent);
  return ORDER.filter((a) => out.includes(a));
}

/** A machine with one agent sees no tags. */
export function showAgentTags(app: App): boolean {
  return agentsInUse(app).length > 1;
}

/** The short tag of a row ('oc' / 'cp'), or '' when tags are off. */
export function agentTag(app: App, row: SessionRow): string {
  return showAgentTags(app) ? th.glyphs.agent[row.agent] : '';
}

/** The saved default agent, when it can start now; else the first one that can. */
export function defaultAgent(app: App, list: AgentId[] = startableAgents(app)): AgentId | undefined {
  const saved = app.deps.store.ui.defaultAgent;
  return list.find((a) => a === saved) ?? list[0];
}

/**
 * Pick the agent for a new session: no menu with one agent; with two, a menu with the default
 * first (Enter takes it). The choice becomes the new default.
 */
export function pickAgent(app: App, then: (agent: AgentId) => void): void {
  const list = startableAgents(app);
  if (list.length === 0) {
    app.error(`No agent can start a session. ${INSTALL_HINT}`);
    return;
  }
  const choose = (a: AgentId) => {
    if (list.length > 1) app.deps.store.setUi({ defaultAgent: a });
    app.deps.hub.defaultAgent = a;
    then(a);
  };
  if (list.length === 1) {
    choose(list[0] as AgentId);
    return;
  }
  const def = defaultAgent(app, list) as AgentId;
  const ordered = [def, ...list.filter((a) => a !== def)];
  // Fixed keys (1 OpenCode, 2 Copilot), so the hand learns them; the default is first.
  const items = ordered.map((a) => ({ key: String(ORDER.indexOf(a) + 1), label: AGENT_NAMES[a], detail: a === def ? 'default' : '' }));
  app.modal = {
    kind: 'menu',
    state: createMenu('New session', items, 'Agent for the new session (Enter: the default):'),
    choose: (i) => {
      const a = ordered[i];
      if (a) choose(a);
    },
  };
}

/** Text that explains why an action is not possible for this session, or null. */
export function blockedAction(app: App, s: SessionRow, action: 'rename' | 'remove'): string | null {
  const cap = app.deps.hub.capabilitiesOf(s.id);
  if (action === 'rename' && !cap.rename) return s.agent === 'copilot' ? COPILOT_RENAME : `${AGENT_NAMES[s.agent]} sessions cannot be renamed here.`;
  if (action === 'remove' && !cap.remove) return s.agent === 'copilot' ? COPILOT_DELETE : `${AGENT_NAMES[s.agent]} sessions cannot be deleted here.`;
  return null;
}

// ---- wording by machine ----------------------------------------------------

/**
 * What this machine has:
 *   opencode-down  OpenCode is installed (or expected) and its service failed: an error
 *   both / opencode / copilot  the agents in use
 *   none           no agent at all
 *   starting       the first service check is not done yet
 */
export type AgentMode = 'starting' | 'both' | 'opencode' | 'copilot' | 'none';

export function agentMode(app: App): AgentMode {
  const connected = app.opencodeConnected();
  const hasOc =
    app.deps.hub.source('opencode') !== undefined &&
    (connected || app.service === 'ok' || app.service === 'down' || (app.service === 'starting' && installed(app, 'opencode')));
  const hasCp = app.deps.hub.source('copilot')?.available === true;
  if (app.service === 'starting' && !connected && !hasCp) return 'starting';
  if (hasOc && hasCp) return 'both';
  if (hasOc) return 'opencode';
  if (hasCp) return 'copilot';
  return 'none';
}

/** OpenCode should run here but its service is not available: an error worth red text. */
export function opencodeDown(app: App): boolean {
  return app.service === 'down' && !app.opencodeConnected();
}

export function serviceBadge(app: App): { text: string; style: Style } {
  const cp = app.deps.hub.source('copilot')?.available === true;
  if (app.opencodeConnected()) return { text: cp ? '● OpenCode · Copilot' : '● OpenCode', style: style(2) };
  if (app.service === 'down') return { text: cp ? '● OpenCode offline · Copilot' : '● OpenCode offline', style: style(1) };
  if (app.service === 'absent') return cp ? { text: '● Copilot only', style: th.dim } : { text: '● no agent', style: style(3) };
  return { text: cp ? '○ connecting · Copilot' : '○ connecting', style: style(3) };
}

/** Empty Sessions column. */
export function emptySessionsText(app: App): string {
  const mode = agentMode(app);
  if (mode === 'none') return 'No agent found. ? shows how to install one.';
  if (opencodeDown(app) && mode !== 'both') return 'OpenCode service not available.';
  return app.checkoutPath ? 'No sessions. n starts one.' : '';
}

/** Empty inbox. */
export function emptyInboxText(app: App): string[] {
  const mode = agentMode(app);
  if (mode === 'none') return ['No agent found.', INSTALL_HINT];
  if (opencodeDown(app) && mode !== 'both') return ['The OpenCode service is not available.', 'Run "node src/main.ts doctor" for details.'];
  if (app.deps.store.projects.length === 0) return ['No projects yet.', 'Press v for the projects view, then n to add a project folder.'];
  if (!app.opencodeConnected() && (mode === 'starting' || mode === 'opencode' || mode === 'both')) return ['Connecting to OpenCode…'];
  return ['No sessions in your projects.', 'Press v for the projects view, select a folder and press n for a new session.'];
}

/** How Enter opens the selected session, for the information panel. */
export function openHint(app: App, s: SessionRow): string {
  if (s.agent === 'copilot' && !(app.service === 'ok' && app.opencodeConnected())) {
    return 'Enter opens the session in the full window (the pane needs the OpenCode service). Exit Copilot to come back.';
  }
  return 'Enter opens the session here. O opens it in the full window.';
}

/** Lines of the "Agents" section of the help. */
export function agentHelpLines(app: App): Array<{ heading?: string; key?: string; text?: string }> {
  const mode = agentMode(app);
  const here =
    mode === 'both' ? 'This machine: OpenCode and Copilot.'
    : mode === 'opencode' ? 'This machine: OpenCode only.'
    : mode === 'copilot' ? 'This machine: Copilot only (no OpenCode service).'
    : mode === 'none' ? `This machine: no agent found. ${INSTALL_HINT}`
    : 'This machine: still checking.';
  const out: Array<{ heading?: string; key?: string; text?: string }> = [
    { heading: 'Agents' },
    { key: '', text: here },
    { key: `${th.glyphs.agent.opencode} / ${th.glyphs.agent.copilot}`, text: 'Agent tag of a row (OpenCode / Copilot); shown only when both are in use' },
    { key: 'n', text: 'With two agents: a menu, 1 OpenCode, 2 Copilot; Enter takes the default (the last choice)' },
    { key: 'Copilot', text: 'List, status, start, resume, archive (kept here), snooze, settle' },
    { key: 'Copilot', text: 'Not here: rename (/rename in Copilot), delete (/session delete in Copilot)' },
    { key: 'Copilot', text: 'Runs in the pane only through the OpenCode service; without it, in the full window' },
  ];
  if (opencodeDown(app) && app.serviceError) out.push({ key: 'OpenCode', text: `Service not available: ${app.serviceError}` });
  return out;
}

/** The quit question. A Copilot program in a pane ends with the pane (its turn stops). */
export function quitText(app: App): string {
  const copilot = app.panes.list().filter((p) => p.agent === 'copilot');
  const base = app.deps.hub.source('opencode') && app.service !== 'absent'
    ? 'Leave corral? OpenCode sessions keep running in the OpenCode service.'
    : 'Leave corral?';
  if (copilot.length === 0) return base.replace('OpenCode sessions keep', 'Sessions keep');
  const busy = copilot.filter((p) => {
    const st = app.deps.hub.status(p.sessionId);
    return st === 'working' || st === 'needs-input';
  }).length;
  const n = copilot.length;
  return `${base} ${n} Copilot session${n > 1 ? 's' : ''} in the pane will stop${busy ? ` (${busy} working now)` : ''}; resume later with Enter.`;
}
