//! Per-conversation runtime pool.
//!
//! Each conversation owns its own `AgentRuntime`, so switching the transcript
//! only changes which session the page renders. Background sessions keep
//! streaming and persisting through their own deps; they are disposed only by
//! an explicit stop, a deleted conversation, or page teardown.

import { AgentRuntime, type AgentRuntimeDeps, type RuntimeSnapshot } from './AgentRuntime'
import type { AgentProfile } from './runtime'
import type { ChatConversation } from '../types'

export interface RuntimePoolOptions {
  /** Factory seam for tests; defaults to the real runtime. */
  createRuntime?: (deps: AgentRuntimeDeps) => AgentRuntime
  /** A background draft adopted its conversation; the page learns the new row. */
  onAdopted?: (conversation: ChatConversation) => void
}

interface PooledSession {
  /** Map key; turns from `draft` into `c<id>` once the backend persists it. */
  key: string
  runtime: AgentRuntime
  off: () => void
  /** Dropped from the map; dispose once any in-flight open settles. */
  closed: boolean
  /** In-flight open calls; pruning must not race them. */
  pending: number
}

const DRAFT_KEY = 'draft'

/** Raised when a session is deleted or torn down while its open is in flight. */
export class SessionClosedError extends Error {
  constructor() {
    super('Session was closed while loading')
    this.name = 'SessionClosedError'
  }
}

function conversationKey(id: number): string {
  return `c${id}`
}

/** Busy while a run executes or ledger work still waits behind it. */
function isBusy(snapshot: RuntimeSnapshot): boolean {
  return snapshot.status !== 'idle' || snapshot.queued > 0
}

export class RuntimePool {
  private readonly deps: AgentRuntimeDeps
  private readonly options: RuntimePoolOptions
  private readonly sessions = new Map<string, PooledSession>()
  private active: AgentRuntime | null = null
  /** Guards `open`/`openDraft` against out-of-order completion. */
  private openToken = 0
  /** Synthetic keys for drafts that keep running after the user leaves them. */
  private backgroundSeq = 0

  constructor(deps: AgentRuntimeDeps, options: RuntimePoolOptions = {}) {
    this.deps = deps
    this.options = options
  }

  /** Runtime rendered before the first open finishes; bootstrap replaces it. */
  initial(): AgentRuntime {
    const session = this.ensure(DRAFT_KEY)
    this.active = session.runtime
    return session.runtime
  }

  /**
   * Open a saved conversation. A session that is still running is attached
   * as-is; rebuilding it would abort the generation this pool protects.
   */
  async open(conversation: ChatConversation, profile: AgentProfile | null): Promise<AgentRuntime> {
    const token = (this.openToken += 1)
    const session = this.ensure(conversationKey(conversation.id))
    if (!isBusy(session.runtime.snapshot())) {
      await this.runOpen(session, () => session.runtime.open(conversation, profile))
    }
    return this.activateIfCurrent(session, token)
  }

  /** Open an unsaved draft without disturbing a draft that is still running. */
  async openDraft(profile: AgentProfile | null): Promise<AgentRuntime> {
    const token = (this.openToken += 1)
    await this.retireDraft()
    const session = this.ensure(DRAFT_KEY)
    await this.runOpen(session, () => session.runtime.openDraft(profile))
    return this.activateIfCurrent(session, token)
  }

  /** Delete path: stop this conversation's run before its rows are removed. */
  async close(conversationId: number): Promise<void> {
    const session = this.sessions.get(conversationKey(conversationId))
    if (!session) return
    this.drop(session)
    await session.runtime.dispose()
  }

  /** Page teardown: every session, running or not, is disposed. */
  async disposeAll(): Promise<void> {
    this.openToken += 1
    const all = [...this.sessions.values()]
    this.sessions.clear()
    this.active = null
    await Promise.all(
      all.map((session) => {
        session.closed = true
        session.off()
        return session.runtime.dispose()
      }),
    )
  }

  // ---------------------------------------------------------------- internals

  private ensure(key: string): PooledSession {
    const existing = this.sessions.get(key)
    if (existing) return existing
    const runtime = this.options.createRuntime
      ? this.options.createRuntime(this.deps)
      : new AgentRuntime({ deps: this.deps })
    const session: PooledSession = { key, runtime, off: () => {}, closed: false, pending: 0 }
    // The pool subscribes first: adoption must be visible even while the page
    // is rendering a different conversation.
    session.off = runtime.subscribe((snapshot) => this.onSnapshot(session, snapshot))
    this.sessions.set(key, session)
    return session
  }

  /** Re-key a draft session once the backend persisted its conversation. */
  private onSnapshot(session: PooledSession, snapshot: RuntimeSnapshot): void {
    if (session.closed) return
    const adopted = snapshot.conversation
    if (!adopted) return
    const key = conversationKey(adopted.id)
    if (session.key === key) return
    this.rekey(session, key)
    this.options.onAdopted?.(adopted)
  }

  private async runOpen(session: PooledSession, open: () => Promise<void>): Promise<void> {
    session.pending += 1
    try {
      await open()
    } finally {
      session.pending -= 1
    }
  }

  /** Stale opens finish after a newer switch; they must not steal the display. */
  private async activateIfCurrent(
    session: PooledSession,
    token: number,
  ): Promise<AgentRuntime> {
    // A close/prune dropped the session while it loaded: release its agent and
    // never hand a disposed runtime back to the caller.
    if (session.closed) {
      await session.runtime.dispose()
      throw new SessionClosedError()
    }
    if (token === this.openToken) this.activate(session.runtime)
    return session.runtime
  }

  private activate(runtime: AgentRuntime): void {
    this.active = runtime
    this.prune()
  }

  /** Idle sessions nobody displays hold no value; keep memory bounded. */
  private prune(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.runtime === this.active || session.pending > 0) continue
      if (isBusy(session.runtime.snapshot())) continue
      this.drop(session)
      void session.runtime.dispose()
    }
  }

  /**
   * `openDraft` must never cancel a live draft: park it under its persisted
   * conversation (or a synthetic key while its first run is still creating it)
   * and hand the `draft` key to a fresh session.
   */
  private async retireDraft(): Promise<void> {
    const session = this.sessions.get(DRAFT_KEY)
    if (!session) return
    const snapshot = session.runtime.snapshot()
    if (isBusy(snapshot)) {
      const adopted = snapshot.conversation
      const key = adopted
        ? conversationKey(adopted.id)
        : `draft-${(this.backgroundSeq += 1)}`
      this.rekey(session, key)
      return
    }
    this.drop(session)
    await session.runtime.dispose()
  }

  private rekey(session: PooledSession, key: string): void {
    if (session.key === key) return
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key)
    session.key = key
    if (!this.sessions.has(key)) this.sessions.set(key, session)
  }

  private drop(session: PooledSession): void {
    session.closed = true
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key)
    session.off()
    if (this.active === session.runtime) this.active = null
  }
}
