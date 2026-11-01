import { useEffect, useState } from 'react'
import { privacyApi } from '../../api'
import type {
  PrivacyAuditEntry,
  PrivacyEntity,
  PrivacyEntityKind,
  PrivacyLabel,
  SensitivityLevel,
} from '../../types'
import { toast } from '../../toast'
import { friendlyError } from '../../utils'
import ChipRow from '../../components/ChipRow'

const LEVEL_OPTIONS: Array<{ key: SensitivityLevel; label: string }> = [
  { key: 0, label: 'S0 敏感' },
  { key: 1, label: 'S1 一般敏感' },
  { key: 2, label: 'S2 非敏感' },
]

const ENTITY_OPTIONS: Array<{ key: PrivacyEntityKind; label: string }> = [
  { key: 'person', label: '人名' },
  { key: 'organization', label: '机构' },
  { key: 'address', label: '地址' },
  { key: 'phone', label: '电话' },
  { key: 'email', label: '邮箱' },
  { key: 'account', label: '账号' },
]

function levelText(level: number): string {
  return LEVEL_OPTIONS.find((item) => item.key === level)?.label ?? `S${level}`
}

function kindText(kind: string): string {
  return ENTITY_OPTIONS.find((item) => item.key === kind)?.label ?? kind
}

/** Render audit kind counts (`{"phone":1}`) without exposing any value. */
function countsText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    const parts = Object.entries(parsed).map(([kind, count]) => `${kindText(kind)}×${count}`)
    return parts.length > 0 ? parts.join('、') : '无实体'
  } catch {
    return raw
  }
}

export default function PrivacySection() {
  const [labels, setLabels] = useState<PrivacyLabel[]>([])
  const [entities, setEntities] = useState<PrivacyEntity[]>([])
  const [audit, setAudit] = useState<PrivacyAuditEntry[]>([])
  const [newPath, setNewPath] = useState('/life')
  const [newLevel, setNewLevel] = useState<SensitivityLevel>(1)
  const [entityKind, setEntityKind] = useState<PrivacyEntityKind>('person')
  const [entityValue, setEntityValue] = useState('')
  const [busy, setBusy] = useState(false)

  const apply = ([nextLabels, nextEntities, nextAudit]: [
    PrivacyLabel[],
    PrivacyEntity[],
    PrivacyAuditEntry[],
  ]) => {
    setLabels(nextLabels)
    setEntities(nextEntities)
    setAudit(nextAudit)
  }

  const load = () =>
    Promise.all([privacyApi.labels(), privacyApi.entities(), privacyApi.audit(10)]).then(apply)

  const reload = async () => {
    try {
      await load()
    } catch (e) {
      console.error('读取隐私配置失败', e)
    }
  }

  useEffect(() => {
    load().catch((e) => console.error('读取隐私配置失败', e))
    // Load once on mount; later refreshes happen after each mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveLabel = async () => {
    const path = newPath.trim()
    if (!path) {
      toast('请填写路径')
      return
    }
    setBusy(true)
    try {
      await privacyApi.setLabel(path, newLevel)
      await reload()
      toast('分级已保存')
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const changeLevel = async (path: string, level: SensitivityLevel) => {
    try {
      await privacyApi.setLabel(path, level)
      await reload()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const removeLabel = async (path: string) => {
    try {
      await privacyApi.deleteLabel(path)
      await reload()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const addEntity = async () => {
    const value = entityValue.trim()
    if (!value) {
      toast('请填写实体内容')
      return
    }
    setBusy(true)
    try {
      await privacyApi.addEntity(entityKind, value)
      setEntityValue('')
      await reload()
      toast('实体已加入实体库')
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const removeEntity = async (alias: string) => {
    try {
      await privacyApi.deleteEntity(alias)
      await reload()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  return (
    <>
      <div className="settings-section-title">数据分级与出境保护</div>
      <div className="form-field">
        <p className="settings-note">
          云端请求发送前会在 Rust 侧判定数据等级：S0 一律拒绝，S1 在脱敏链路完成前也会拒绝，S2
          才允许出境。未标记路径按 S1 处理；内置路径可改级别但不可删除。
        </p>
      </div>

      <div className="form-field">
        <span className="form-label">分级规则</span>
        {labels.map((label) => (
          <div className="model-row" key={label.pathPrefix}>
            <div className="model-info">
              <div className="model-title">
                {label.pathPrefix}
                <span className="model-badge">{levelText(label.level)}</span>
                {label.source === 'default' && <span className="model-badge">内置</span>}
              </div>
              <div className="model-meta">最长前缀匹配</div>
            </div>
            <div className="model-actions">
              <select
                className="form-input"
                style={{ width: 'auto' }}
                value={label.level}
                aria-label={`${label.pathPrefix} 的分级`}
                onChange={(e) => void changeLevel(label.pathPrefix, Number(e.target.value) as SensitivityLevel)}
              >
                {LEVEL_OPTIONS.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
              {label.source !== 'default' && (
                <button
                  type="button"
                  className="restore-default danger"
                  onClick={() => void removeLabel(label.pathPrefix)}
                >
                  删除
                </button>
              )}
            </div>
          </div>
        ))}

        <div className="form-field">
          <span className="form-label">添加或覆盖规则</span>
          <input
            className="form-input"
            value={newPath}
            placeholder="/life/notes/公开"
            onChange={(e) => setNewPath(e.target.value)}
          />
          <ChipRow items={LEVEL_OPTIONS} value={newLevel} onChange={setNewLevel} />
          <button type="button" className="restore-default" disabled={busy} onClick={() => void saveLabel()}>
            保存分级
          </button>
        </div>
      </div>

      <div className="form-field">
        <span className="form-label">实体库（精确数据匹配）</span>
        <p className="settings-note">
          实体明文只写入系统密钥库，数据库仅保存加盐哈希与别名。出现在云端请求中的实体一旦命中，
          会按实体级别拦截。
        </p>
        <select
          className="form-input"
          value={entityKind}
          onChange={(e) => setEntityKind(e.target.value as PrivacyEntityKind)}
        >
          {ENTITY_OPTIONS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          className="form-input"
          value={entityValue}
          placeholder="例如：张三 / 13800138000"
          onChange={(e) => setEntityValue(e.target.value)}
        />
        <button type="button" className="restore-default" disabled={busy} onClick={() => void addEntity()}>
          加入实体库
        </button>

        {entities.map((entity) => (
          <div className="model-row" key={entity.alias}>
            <div className="model-info">
              <div className="model-title">
                {entity.alias}
                <span className="model-badge">{kindText(entity.kind)}</span>
              </div>
              <div className="model-meta">加入于 {entity.createdAt}</div>
            </div>
            <div className="model-actions">
              <button
                type="button"
                className="restore-default danger"
                onClick={() => void removeEntity(entity.alias)}
              >
                移除
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="form-field">
        <span className="form-label">最近出境判定</span>
        <p className="settings-note">只记录目标模型、判定结果与实体类型计数，不保存任何原文。</p>
        {audit.length === 0 && <p className="settings-note">暂无记录</p>}
        {audit.map((item) => (
          <div className="model-row" key={item.id}>
            <div className="model-info">
              <div className="model-title">
                {item.decision === 'allow' ? '已放行' : '已拦截'}
                <span className="model-badge">{item.target}</span>
              </div>
              <div className="model-meta">
                {item.createdAt} · {countsText(item.entityKinds)} · {item.bytes} 字节
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
