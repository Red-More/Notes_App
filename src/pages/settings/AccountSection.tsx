import { useState, useSyncExternalStore } from 'react'
import {
  MAX_DISPLAY_NAME_LENGTH,
  getAppPrefs,
  setAppPrefs,
  subscribeAppPrefs,
} from '../../appPrefs'
import { IconInfo } from '../../components/Icons'
import { Modal } from '../../components/ui'
import { SettingsGroup, SettingsRow, SaveStatus } from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

export default function AccountSection() {
  const prefs = useSyncExternalStore(subscribeAppPrefs, getAppPrefs, getAppPrefs)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(prefs.displayName)
  const save = useSettingSave()

  const openEditor = () => {
    setDraft(prefs.displayName)
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    void save.run(() => {
      setAppPrefs({ displayName: draft })
    })
  }

  const initial = Array.from(prefs.displayName)[0] ?? '用'

  return (
    <SettingsGroup id="settings-account" title="账号与资料" hint="本地账户，不提供云同步">
      <SettingsRow
        icon={initial}
        iconClass="settings-avatar"
        title="显示名称"
        subtitle={prefs.displayName}
        value="编辑"
        status={<SaveStatus state={save.state} error={save.error} />}
        chevron
        onClick={openEditor}
        ariaLabel="编辑显示名称"
      />
      <SettingsRow
        icon={<IconInfo size={20} />}
        title="数据归属"
        subtitle="笔记、日记、待办与人脉保存在本机 life.db"
        value="仅本机"
      />

      {editing && (
        <Modal
          title="编辑资料"
          onClose={() => setEditing(false)}
          footer={
            <>
              <button type="button" className="btn btn-plain" onClick={() => setEditing(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!draft.trim()}
                onClick={commit}
              >
                保存
              </button>
            </>
          }
        >
          <label className="form-field">
            <span className="form-label">显示名称</span>
            <input
              className="form-input settings-profile-input"
              value={draft}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              autoFocus
              placeholder="输入本机显示名称"
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <p className="settings-note">仅保存在本机，不会上传；最多 {MAX_DISPLAY_NAME_LENGTH} 个字符。</p>
        </Modal>
      )}
    </SettingsGroup>
  )
}
