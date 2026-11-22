//! Web Audio playback for reminder tones.
//!
//! Web Audio needs no permissions and still plays while the OS is in silent or
//! do-not-disturb mode (those policies gate the notification channel, not media
//! output). The context is created lazily and only after a user gesture on
//! platforms that enforce autoplay policies; callers get `null` instead of an
//! exception so reminders always fall back to the system notification.

import { reminderSoundOption, type ReminderSoundId, type ToneStep } from './ringtones'

/** Time between forced-ring cycles, so repetitions stay distinguishable. */
const CYCLE_GAP_MS = 700
/** Brief fade-in that avoids the click of an abrupt oscillator start. */
const ATTACK_S = 0.015
/** Give the context this long to resume before treating playback as blocked. */
const RESUME_TIMEOUT_MS = 800

export interface RingtonePlayback {
  stop: () => void
}

let context: AudioContext | null = null

function ensureContext(): AudioContext | null {
  if (context) return context
  try {
    context = new AudioContext()
    return context
  } catch {
    return null
  }
}

/** Resume a suspended context, but never wait forever for a blocked gesture. */
async function unlock(ctx: AudioContext): Promise<boolean> {
  const isRunning = () => ctx.state === 'running'
  if (isRunning()) return true
  try {
    await Promise.race([
      ctx.resume(),
      new Promise<void>((resolve) => window.setTimeout(resolve, RESUME_TIMEOUT_MS)),
    ])
  } catch {
    return false
  }
  return isRunning()
}

/** Harsh waveforms need a lower peak so overlapping notes do not clip. */
function peakGain(wave: ToneStep['wave']): number {
  switch (wave) {
    case 'square':
      return 0.18
    case 'sawtooth':
      return 0.16
    case 'triangle':
      return 0.5
    default:
      return 0.45
  }
}

/** Schedule one pattern; returns the time at which it finishes. */
function schedulePattern(
  ctx: AudioContext,
  pattern: readonly ToneStep[],
  startAt: number,
  live: Set<OscillatorNode>,
): number {
  let cursor = startAt
  for (const step of pattern) {
    const duration = step.ms / 1000
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = step.wave ?? 'sine'
    osc.frequency.setValueAtTime(step.freq, cursor)
    gain.gain.setValueAtTime(0.0001, cursor)
    gain.gain.exponentialRampToValueAtTime(peakGain(step.wave), cursor + ATTACK_S)
    gain.gain.exponentialRampToValueAtTime(0.0001, cursor + duration)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(cursor)
    osc.stop(cursor + duration + 0.02)
    live.add(osc)
    osc.onended = () => {
      live.delete(osc)
      gain.disconnect()
    }
    cursor += duration + (step.gapMs ?? 0) / 1000
  }
  return cursor
}

async function beginPlayback(id: ReminderSoundId, loop: boolean): Promise<RingtonePlayback | null> {
  const ctx = ensureContext()
  if (!ctx || !(await unlock(ctx))) return null

  const { pattern } = reminderSoundOption(id)
  const live = new Set<OscillatorNode>()
  let timer: number | undefined
  let stopped = false

  const cycle = () => {
    if (stopped) return
    const endsAt = schedulePattern(ctx, pattern, ctx.currentTime + 0.02, live)
    if (!loop) return
    const waitMs = Math.max(400, (endsAt - ctx.currentTime) * 1000 + CYCLE_GAP_MS)
    timer = window.setTimeout(cycle, waitMs)
  }
  cycle()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      for (const osc of live) {
        try {
          osc.stop()
        } catch {
          // Already ended; nothing to cancel.
        }
        osc.disconnect()
      }
      live.clear()
    },
  }
}

/** Play the selected tone once (regular reminders). */
export function playReminderSoundOnce(id: ReminderSoundId): Promise<RingtonePlayback | null> {
  return beginPlayback(id, false)
}

/** Repeat the selected tone until stopped (forced reminders). */
export function startForcedReminderSound(id: ReminderSoundId): Promise<RingtonePlayback | null> {
  return beginPlayback(id, true)
}
