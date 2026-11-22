import { useEffect, useRef } from 'react'
import { IconCheck } from '../../components/Icons'
import { playReminderSoundOnce, type RingtonePlayback } from '../../reminders/ringtonePlayer'
import { REMINDER_SOUND_OPTIONS, type ReminderSoundId } from '../../reminders/ringtones'
import { toast } from '../../toast'

interface Props {
  value: ReminderSoundId
  onChange: (id: ReminderSoundId) => void
}

/** Radio-style ringtone list with a per-tone preview button. */
export default function ReminderSoundPicker({ value, onChange }: Props) {
  const playback = useRef<RingtonePlayback | null>(null)
  // Bumped on every preview and on unmount, so a late `resume()` cannot ring
  // after the user picked another tone or left the settings page.
  const session = useRef(0)

  useEffect(
    () => () => {
      session.current += 1
      playback.current?.stop()
    },
    [],
  )

  const preview = (id: ReminderSoundId) => {
    const current = ++session.current
    playback.current?.stop()
    playback.current = null
    void playReminderSoundOnce(id).then((handle) => {
      if (!handle) {
        if (current === session.current) toast('当前环境无法播放应用内铃声')
        return
      }
      if (current !== session.current) {
        handle.stop()
        return
      }
      playback.current = handle
    })
  }

  return (
    <div className="reminder-sound-list" role="radiogroup" aria-label="提醒铃声">
      {REMINDER_SOUND_OPTIONS.map((option) => {
        const selected = option.id === value
        return (
          <div key={option.id} className={`reminder-sound-item ${selected ? 'selected' : ''}`}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              className="reminder-sound-choice"
              onClick={() => onChange(option.id)}
            >
              <span className="reminder-sound-check" aria-hidden="true">
                {selected && <IconCheck size={13} />}
              </span>
              <span className="reminder-sound-copy">
                <span className="reminder-sound-name">{option.label}</span>
                <span className="reminder-sound-desc">{option.description}</span>
              </span>
            </button>
            <button
              type="button"
              className="reminder-sound-preview"
              onClick={() => preview(option.id)}
              aria-label={`试听${option.label}`}
            >
              试听
            </button>
          </div>
        )
      })}
    </div>
  )
}
