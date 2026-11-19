// Public surface of src/core.

export { envGet, opencodeStateDirs, pathKey, samePath, serviceFileCandidates, stateDir, trimTrailingSep } from './paths.ts';
export type { Env } from './paths.ts';
export { defaultIsExecutable, describeResolveFailure, resolveExecutable, run } from './exe.ts';
export type { ResolveOptions, ResolveResult, RunOptions, RunResult, Runner } from './exe.ts';
export { buildQuery, discoverService, ensureService, locationQuery, OpenCodeClient, OpenCodeError } from './opencode.ts';
export type { ClientOptions, Connection, DiscoverDeps, EnsureDeps, OpenCodeApi, Query, RequestOptions, ServiceInfo } from './opencode.ts';
export { SseParser, subscribeEvents } from './events.ts';
export type { OcEvent, SseMessage, SubscribeOptions, Subscription } from './events.ts';
export { openPty } from './pty.ts';
export type { PtyInfo, PtyOptions, WsFactory, WsLike } from './pty.ts';
export { defaultState, parseState, Store, StoreError } from './store.ts';
export type { SessionMeta, StateData, StoreOptions, UiState } from './store.ts';
export { createGit, GitError, parseStatus, parseWorktreeList, worktreeDir } from './git.ts';
export type { Branch, CheckoutStatus, Git, GitOptions } from './git.ts';
export { SessionTracker, TRACKED_EVENTS } from './sessions.ts';
export type { EventHandlers, EventSubscriber, SessionInfo, SessionMetaStore, TrackerOptions } from './sessions.ts';
export { nullPrProvider } from './pr.ts';
export type { PrProvider } from './pr.ts';
export { createAzurePrProvider, mapPullRequest, parsePrList, pullRequestWebUrl, resolveAzLaunch, AZ_PR_LIST_ARGS } from './pr-azure.ts';
export { activeSnooze, buildInbox, classify, formatSnooze, formatTime, marksToClear, nextWake, snoozeEnd, snoozeEndedEarly } from './inbox.ts';
export type { MarkChange } from './inbox.ts';
export { parseSnoozePresets, parseSnoozeTime, resolveSnoozePreset, snoozeChoices, snoozeLabel, SNOOZE_TIME_FORMS } from './snooze.ts';
export type { SnoozeChoice } from './snooze.ts';
