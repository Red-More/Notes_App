import { useState } from 'react'
import type { ContactTagGroup } from '../contacts/contactBody'
import { IconClose, IconPlus } from './Icons'

interface Props {
  value: ContactTagGroup[]
  /** Known values per key, so presets and other contacts stay one tap away. */
  suggestions: Record<string, string[]>
  onChange: (next: ContactTagGroup[]) => void
}

/** Split typed values on any separator the body format accepts. */
function splitValues(raw: string): string[] {
  return raw
    .split(/[、,，]/)
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Inline "add value" chip; commits on Enter or when focus leaves. */
function TagValueInput({ onAdd }: { onAdd: (values: string[]) => void }) {
  const [text, setText] = useState('')
  const commit = () => {
    const values = splitValues(text)
    if (values.length > 0) onAdd(values)
    setText('')
  }
  return (
    <input
      className="tag-value-input"
      value={text}
      placeholder="+ 添加值"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      onBlur={commit}
    />
  )
}

/**
 * Key-value tag picker.
 *
 * Each key is one group with its own selection mode: single-select replaces the
 * value, multi-select toggles values on and off. Keys and values can both be
 * typed in, so the selector is not limited to the presets.
 */
export default function TagSelector({ value, suggestions, onChange }: Props) {
  const update = (index: number, patch: Partial<ContactTagGroup>) => {
    onChange(value.map((group, i) => (i === index ? { ...group, ...patch } : group)))
  }

  const optionsFor = (group: ContactTagGroup) => {
    const known = suggestions[group.key] ?? []
    return [...new Set([...known, ...group.values])]
  }

  const toggleValue = (index: number, option: string) => {
    const group = value[index]
    if (!group) return
    if (!group.multiple) {
      update(index, { values: group.values.includes(option) ? [] : [option] })
      return
    }
    const values = group.values.includes(option)
      ? group.values.filter((item) => item !== option)
      : [...group.values, option]
    update(index, { values })
  }

  const addValues = (index: number, added: string[]) => {
    const group = value[index]
    if (!group) return
    if (!group.multiple) {
      update(index, { values: [added[added.length - 1] ?? ''] })
      return
    }
    update(index, { values: [...new Set([...group.values, ...added])] })
  }

  const toggleMode = (index: number) => {
    const group = value[index]
    if (!group) return
    const multiple = !group.multiple
    update(index, {
      multiple,
      // A single-select key can only keep one of its values.
      values: multiple ? group.values : group.values.slice(0, 1),
    })
  }

  return (
    <div className="tag-selector">
      {value.map((group, index) => {
        const options = optionsFor(group)
        return (
          <div className="tag-group" key={index}>
            <div className="tag-group-head">
              <input
                className="tag-group-key"
                value={group.key}
                placeholder="标签名"
                aria-label="标签名"
                onChange={(e) => update(index, { key: e.target.value })}
                autoFocus={!group.key}
              />
              <button
                type="button"
                className={`tag-mode-btn ${group.multiple ? 'multi' : ''}`}
                aria-label={group.multiple ? '切换为单选' : '切换为多选'}
                onClick={() => toggleMode(index)}
              >
                {group.multiple ? '多选' : '单选'}
              </button>
              <button
                type="button"
                className="tag-group-remove"
                aria-label="删除标签组"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <IconClose size={14} />
              </button>
            </div>
            <div className="tag-chips">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`chip ${group.values.includes(option) ? 'active' : ''}`}
                  aria-pressed={group.values.includes(option)}
                  onClick={() => toggleValue(index, option)}
                >
                  {option}
                </button>
              ))}
              <TagValueInput onAdd={(added) => addValues(index, added)} />
            </div>
          </div>
        )
      })}
      <button
        type="button"
        className="tag-add-group"
        onClick={() => onChange([...value, { key: '', values: [], multiple: true }])}
      >
        <IconPlus size={15} />
        新建标签组
      </button>
    </div>
  )
}
