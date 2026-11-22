//! Built-in reminder tones.
//!
//! Tones are synthesised by `ringtonePlayer` instead of shipping audio assets:
//! the list stays tiny, works offline on every platform, and never depends on
//! OS-specific ringtone files (which mobile platforms do not expose to apps).

export type ReminderSoundId = 'default' | 'crisp' | 'bell' | 'alarm'

/** One note inside a ringtone pattern. */
export interface ToneStep {
  /** Frequency in Hz. */
  freq: number
  /** Tone length in milliseconds. */
  ms: number
  /** Silence after the tone in milliseconds. */
  gapMs?: number
  /** Oscillator waveform; a pure sine by default. */
  wave?: 'sine' | 'triangle' | 'square' | 'sawtooth'
}

export interface ReminderSoundOption {
  id: ReminderSoundId
  label: string
  description: string
  /** One playback cycle; forced reminders repeat it until dismissed. */
  pattern: readonly ToneStep[]
}

export const DEFAULT_REMINDER_SOUND: ReminderSoundId = 'default'

export const REMINDER_SOUND_OPTIONS: readonly ReminderSoundOption[] = [
  {
    id: 'default',
    label: '默认铃声',
    description: '温和双音，日常提醒不刺耳',
    pattern: [
      { freq: 880, ms: 160, gapMs: 60 },
      { freq: 1174.66, ms: 240, gapMs: 480 },
    ],
  },
  {
    id: 'crisp',
    label: '清脆提示',
    description: '短促明亮，适合高频待办',
    pattern: [
      { freq: 1318.51, ms: 100, gapMs: 40 },
      { freq: 1567.98, ms: 100, gapMs: 40 },
      { freq: 2093, ms: 180, gapMs: 380 },
    ],
  },
  {
    id: 'bell',
    label: '经典钟声',
    description: '厚重钟鸣，远距离也易识别',
    pattern: [
      { freq: 523.25, ms: 650, gapMs: 40, wave: 'triangle' },
      { freq: 783.99, ms: 520, gapMs: 320, wave: 'triangle' },
    ],
  },
  {
    id: 'alarm',
    label: '紧急警报',
    description: '连续高低音，适合重要待办',
    pattern: [
      { freq: 880, ms: 160, gapMs: 80, wave: 'square' },
      { freq: 660, ms: 160, gapMs: 80, wave: 'square' },
      { freq: 880, ms: 160, gapMs: 80, wave: 'square' },
      { freq: 660, ms: 160, gapMs: 420, wave: 'square' },
    ],
  },
]

export function isReminderSoundId(value: unknown): value is ReminderSoundId {
  return REMINDER_SOUND_OPTIONS.some((option) => option.id === value)
}

/** Resolve an id to its option; unknown ids fall back to the default tone. */
export function reminderSoundOption(id: ReminderSoundId): ReminderSoundOption {
  return REMINDER_SOUND_OPTIONS.find((option) => option.id === id) ?? REMINDER_SOUND_OPTIONS[0]
}

export function reminderSoundLabel(id: ReminderSoundId): string {
  return reminderSoundOption(id).label
}
