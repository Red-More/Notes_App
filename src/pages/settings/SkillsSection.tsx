import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { skillApi } from '../../api'
import type { SkillDetail, SkillSummary } from '../../types'
import { parseTriggerInput } from '../../agent/skills'
import { ConfirmDialog, Modal } from '../../components/ui'
import { IconEdit, IconTrash } from '../../components/Icons'
import { friendlyError } from '../../utils'
import { toast } from '../../toast'

interface Draft {
  name: string
  description: string
  triggers: string
  body: string
}

interface PreviewState {
  skill: SkillSummary
  detail: SkillDetail | null
  html: string
}

const EMPTY_DRAFT: Draft = { name: '', description: '', triggers: '', body: '' }

function draftFromDetail(detail: SkillDetail): Draft {
  return {
    name: detail.name,
    description: detail.description,
    triggers: detail.triggers.join('、'),
    body: detail.body,
  }
}

/** Encode file bytes as base64 without spreading a huge array into one call. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** 技能管理：列表、预览、编辑、启停与卸载（M3-4）。 */
export default function SkillsSection() {
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [drafts, setDrafts] = useState<SkillSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SkillSummary | null>(null)
  const [draftDeleteTarget, setDraftDeleteTarget] = useState<SkillSummary | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [draftPreview, setDraftPreview] = useState<PreviewState | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Live normalization for the trigger input; errors block saving.
  const triggerParse = useMemo(() => parseTriggerInput(draft.triggers), [draft.triggers])
  const hasTriggerError = triggerParse.issues.some((issue) => issue.level === 'error')

  const load = useCallback(async () => {
    try {
      const [list, draftList] = await Promise.all([skillApi.list(), skillApi.draftList()])
      setSkills(list)
      setDrafts(draftList)
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const [list, draftList] = await Promise.all([skillApi.list(), skillApi.draftList()])
        if (cancelled) return
        setSkills(list)
        setDrafts(draftList)
      } catch (error) {
        if (!cancelled) toast(friendlyError(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = async (skill: SkillSummary) => {
    const next = !skill.enabled
    setTogglingId(skill.id)
    setSkills((prev) =>
      prev.map((item) => (item.id === skill.id ? { ...item, enabled: next } : item)),
    )
    try {
      await skillApi.setEnabled(skill.id, next)
    } catch (error) {
      setSkills((prev) =>
        prev.map((item) => (item.id === skill.id ? { ...item, enabled: !next } : item)),
      )
      toast(friendlyError(error))
    } finally {
      setTogglingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await skillApi.remove(deleteTarget.id)
      toast(`已卸载「${deleteTarget.name}」`)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setDeleteTarget(null)
    }
  }

  const importPackage = async (file: File) => {
    if (!/\.(zip|skill)$/i.test(file.name)) {
      toast('只支持 .zip 或 .skill 技能包')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      toast('技能包不能超过 2MB')
      return
    }
    setImporting(true)
    try {
      const buffer = await file.arrayBuffer()
      const summary = await skillApi.importPackage({
        filename: file.name,
        data: bytesToBase64(new Uint8Array(buffer)),
      })
      toast(`已载入技能「${summary.name}」`)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setImporting(false)
    }
  }

  const openPreview = async (skill: SkillSummary) => {
    setPreview({ skill, detail: null, html: '' })
    try {
      const detail = await skillApi.read(skill.id)
      const { renderMarkdownPreview } = await import('../../editor/markdown')
      setPreview({ skill, detail, html: renderMarkdownPreview(detail.body) })
    } catch (error) {
      setPreview(null)
      toast(friendlyError(error))
    }
  }

  const openDraftPreview = async (skill: SkillSummary) => {
    setDraftPreview({ skill, detail: null, html: '' })
    try {
      const detail = await skillApi.draftRead(skill.id)
      const { renderMarkdownPreview } = await import('../../editor/markdown')
      setDraftPreview({ skill, detail, html: renderMarkdownPreview(detail.body) })
    } catch (error) {
      setDraftPreview(null)
      toast(friendlyError(error))
    }
  }

  const promoteDraft = async (id: string) => {
    try {
      const summary = await skillApi.draftPromote(id)
      toast(`已载入技能「${summary.name}」`)
      setDraftPreview(null)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    }
  }

  const confirmDraftDelete = async () => {
    if (!draftDeleteTarget) return
    try {
      await skillApi.draftRemove(draftDeleteTarget.id)
      toast(`已丢弃草稿「${draftDeleteTarget.name}」`)
      setDraftPreview(null)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setDraftDeleteTarget(null)
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setEditorOpen(true)
  }

  const openEdit = async (id: string) => {
    try {
      const detail = await skillApi.read(id)
      setEditingId(detail.id)
      setDraft(draftFromDetail(detail))
      setEditorOpen(true)
    } catch (error) {
      toast(friendlyError(error))
    }
  }

  const submit = async () => {
    if (draft.name.trim() === '' || draft.description.trim() === '' || draft.body.trim() === '') {
      toast('名称、描述与正文不能为空')
      return
    }
    const firstError = triggerParse.issues.find((issue) => issue.level === 'error')
    if (firstError) {
      toast(firstError.message)
      return
    }
    setSaving(true)
    try {
      await skillApi.save({
        id: editingId ?? undefined,
        name: draft.name.trim(),
        description: draft.description.trim(),
        triggers: triggerParse.triggers,
        body: draft.body.trim(),
      })
      toast(editingId ? '技能已更新' : '技能已保存')
      setEditorOpen(false)
      setDraft(EMPTY_DRAFT)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setSaving(false)
    }
  }

  const enabledCount = skills.filter((skill) => skill.enabled).length

  return (
    <>
      <div className="settings-section-title">技能</div>
      <div className="form-field">
        <span className="form-label">
          已安装 {skills.length} 个 · 启用 {enabledCount} 个
        </span>
        <div
          className={`skill-import ${importing ? 'busy' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files?.[0]
            if (file) void importPackage(file)
          }}
        >
          <span className="skill-import-title">
            {importing ? '正在解析技能包…' : '拖拽或点击载入技能包'}
          </span>
          <span className="skill-import-desc">
            .zip 或 .skill，根目录需包含 SKILL.md（YAML frontmatter 写 name 与 description）
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.skill"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importPackage(file)
              e.target.value = ''
            }}
          />
        </div>
        {loading ? (
          <p className="settings-note">加载中…</p>
        ) : skills.length === 0 ? (
          <p className="settings-note">还没有技能，可以新建一个。</p>
        ) : (
          skills.map((skill) => (
            <div key={skill.id} className="skill-row">
              <button
                type="button"
                className="skill-info"
                onClick={() => void openPreview(skill)}
                aria-label={`预览 ${skill.name}`}
              >
                <span className="skill-name">
                  {skill.name}
                  {skill.builtin && <span className="skill-tag">内置</span>}
                </span>
                <span className="skill-desc">{skill.description}</span>
                <span className="skill-triggers">
                  触发：{skill.triggers.join('、') || '无'}
                </span>
              </button>
              <div className="skill-actions">
                <button
                  type="button"
                  role="switch"
                  aria-checked={skill.enabled}
                  aria-label={`${skill.name} 启用状态`}
                  className={`settings-switch ${skill.enabled ? 'on' : ''}`}
                  disabled={togglingId === skill.id}
                  onClick={() => void toggle(skill)}
                >
                  <span className="settings-switch-thumb" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`编辑 ${skill.name}`}
                  onClick={() => void openEdit(skill.id)}
                >
                  <IconEdit size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`卸载 ${skill.name}`}
                  onClick={() => setDeleteTarget(skill)}
                >
                  <IconTrash size={18} />
                </button>
              </div>
            </div>
          ))
        )}
        <p className="settings-note">
          技能只注入 Prompt，不会注册工具或执行代码；命中时由模型主动调用 load_skill 读取正文。
        </p>
        <button type="button" className="restore-default" onClick={openCreate}>
          新建技能
        </button>
      </div>

      {drafts.length > 0 && (
        <>
          <div className="settings-section-title">模型草稿</div>
          <div className="form-field">
            <span className="form-label">
              {drafts.length} 个待审核草稿 · 不会自动加载
            </span>
            {drafts.map((item) => (
              <div key={item.id} className="skill-row">
                <button
                  type="button"
                  className="skill-info"
                  onClick={() => void openDraftPreview(item)}
                  aria-label={`预览草稿 ${item.name}`}
                >
                  <span className="skill-name">
                    {item.name}
                    <span className="skill-tag">草稿</span>
                  </span>
                  <span className="skill-desc">{item.description}</span>
                  <span className="skill-triggers">
                    触发：{item.triggers.join('、') || '无'}
                  </span>
                </button>
                <div className="skill-actions">
                  <button
                    type="button"
                    className="restore-default"
                    onClick={() => void promoteDraft(item.id)}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`丢弃草稿 ${item.name}`}
                    onClick={() => setDraftDeleteTarget(item)}
                  >
                    <IconTrash size={18} />
                  </button>
                </div>
              </div>
            ))}
            <p className="settings-note">
              草稿位于 /life/agent/skills-drafts，模型可读写；载入后写入 /life/.agents/skills，草稿保留。
            </p>
          </div>
        </>
      )}

      {preview && (
        <Modal
          title={preview.skill.name}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const id = preview.skill.id
                  setPreview(null)
                  void openEdit(id)
                }}
              >
                编辑
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setPreview(null)}>
                关闭
              </button>
            </>
          }
        >
          <div className="form-field">
            <span className="settings-note">{preview.skill.description}</span>
            <span className="skill-triggers">
              触发：{preview.skill.triggers.join('、') || '无'}
            </span>
          </div>
          {preview.detail ? (
            <div
              className="md-preview skill-preview-body"
              // Local SKILL.md rendered with the same sanitized renderer as notes (html:false).
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          ) : (
            <p className="settings-note">加载中…</p>
          )}
        </Modal>
      )}

      {draftPreview && (
        <Modal
          title={`草稿：${draftPreview.skill.name}`}
          onClose={() => setDraftPreview(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-plain"
                onClick={() => setDraftDeleteTarget(draftPreview.skill)}
              >
                丢弃
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void promoteDraft(draftPreview.skill.id)}
              >
                载入为技能
              </button>
            </>
          }
        >
          <div className="form-field">
            <span className="settings-note">{draftPreview.skill.description}</span>
            <span className="skill-triggers">
              触发：{draftPreview.skill.triggers.join('、') || '无'}
            </span>
          </div>
          {draftPreview.detail ? (
            <div
              className="md-preview skill-preview-body"
              // Draft body is untrusted model output; render with html disabled.
              dangerouslySetInnerHTML={{ __html: draftPreview.html }}
            />
          ) : (
            <p className="settings-note">加载中…</p>
          )}
        </Modal>
      )}

      {editorOpen && (
        <Modal
          title={editingId ? '编辑技能' : '新建技能'}
          onClose={() => setEditorOpen(false)}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || hasTriggerError}
              onClick={() => void submit()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          }
        >
          <div className="form-field">
            <span className="form-label">名称</span>
            <input
              className="form-input"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="例如：周报助手"
            />
          </div>
          <div className="form-field">
            <span className="form-label">描述</span>
            <input
              className="form-input"
              value={draft.description}
              onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="一句话说明这个技能解决什么问题"
            />
          </div>
          <div className="form-field">
            <span className="form-label">触发词（逗号或顿号分隔）</span>
            <input
              className="form-input"
              value={draft.triggers}
              onChange={(e) => setDraft((prev) => ({ ...prev, triggers: e.target.value }))}
              placeholder="例如：写周报, 周报助手"
            />
            {triggerParse.triggers.length > 0 && (
              <div className="skill-trigger-preview">
                {triggerParse.triggers.map((trigger) => (
                  <span key={trigger} className="skill-trigger-chip">
                    {trigger}
                  </span>
                ))}
              </div>
            )}
            {triggerParse.issues.map((issue) => (
              <p
                key={`${issue.level}-${issue.message}`}
                className={`skill-trigger-issue ${issue.level}`}
              >
                {issue.message}
              </p>
            ))}
          </div>
          <div className="form-field">
            <span className="form-label">正文（工作流步骤）</span>
            <textarea
              className="form-input skill-body-input"
              rows={10}
              value={draft.body}
              onChange={(e) => setDraft((prev) => ({ ...prev, body: e.target.value }))}
              placeholder="描述步骤与输出格式；只能使用 fs_read / fs_write / fs_edit / fs_glob / fs_grep / load_skill。"
            />
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="卸载技能"
          message={`确定卸载「${deleteTarget.name}」吗？技能文件会被物理删除，内置技能不会自动恢复。`}
          confirmText="卸载"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {draftDeleteTarget && (
        <ConfirmDialog
          title="丢弃草稿"
          message={`确定丢弃草稿「${draftDeleteTarget.name}」吗？草稿文件会被删除，尚未载入的修改将丢失。`}
          confirmText="丢弃"
          danger
          onConfirm={() => void confirmDraftDelete()}
          onCancel={() => setDraftDeleteTarget(null)}
        />
      )}
    </>
  )
}
