import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useCollapsibleHeader, useDebouncedSearch, useElasticOverscroll } from '../../hooks'
import { friendlyError } from '../../utils'
import type { Contact } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import {
  IconBuilding,
  IconMail,
  IconPhone,
  IconSettings,
  IconUsers,
} from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'
import ChipRow from '../../components/ChipRow'
import TagSelector from '../../components/TagSelector'
import { contactNameError } from '../../contacts/contactFile'
import { DEFAULT_TAG_KEY, type ContactTagGroup } from '../../contacts/contactBody'

const PRESET_TAG_VALUES = ['默认', '客户', '朋友', '同事']

/** Default selection for a new contact: one single-select `类别` group. */
const DEFAULT_TAGS: ContactTagGroup[] = [
  { key: DEFAULT_TAG_KEY, values: ['默认'], multiple: false },
]

interface ContactForm {
  name: string
  phone: string
  email: string
  company: string
  notes: string
  tags: ContactTagGroup[]
}

const EMPTY_FORM: ContactForm = {
  name: '',
  phone: '',
  email: '',
  company: '',
  notes: '',
  tags: DEFAULT_TAGS,
}

export default function ContactPage({
  isActive,
  onOpenSettings,
}: {
  isActive: boolean
  onOpenSettings: () => void
}) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [tag, setTag] = useState('全部')
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Contact | null>(null)
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM)
  const [deleteConfirm, setDeleteConfirm] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)

  // Scroll-linked collapsing header (large title + search bar).
  const { largeTitleRef, searchWrapRef, scrollRef, contentShiftRef, scrollEl } =
    useCollapsibleHeader()
  // Same elastic overscroll as the notes page (no pull-to-refresh here).
  const { pullDist, springing } = useElasticOverscroll(scrollEl)

  const load = useCallback(async () => {
    try {
      setContacts(
        await api.listContacts({
          tag: tag === '全部' ? undefined : tag,
          search: query || undefined,
        }),
      )
    } catch (e) {
      console.error('加载联系人失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [tag, query])

  // Refresh data when the page becomes active again (stays mounted in the pager).
  const prevActiveRef = useRef(isActive)
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = isActive
    if (isActive && !wasActive) void load()
  }, [isActive, load])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const list = await api.listContacts({
          tag: tag === '全部' ? undefined : tag,
          search: query || undefined,
        })
        if (!cancelled) setContacts(list)
      } catch (e) {
        console.error('加载联系人失败', e)
        if (!cancelled) toast(friendlyError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [tag, query])

  const tags = [
    '全部',
    ...PRESET_TAG_VALUES,
    ...[
      ...new Set(contacts.flatMap((c) => c.tags.flatMap((group) => group.values))),
    ]
      .filter((value) => !PRESET_TAG_VALUES.includes(value))
      .sort(),
  ]

  // Known values per key: presets first, then whatever other contacts use.
  const tagSuggestions = useMemo(() => {
    const map: Record<string, string[]> = { [DEFAULT_TAG_KEY]: [...PRESET_TAG_VALUES] }
    for (const contact of contacts) {
      for (const group of contact.tags) {
        const list = map[group.key] ?? (map[group.key] = [])
        for (const value of group.values) {
          if (!list.includes(value)) list.push(value)
        }
      }
    }
    return map
  }, [contacts])

  /** Key the current filter value belongs to, so a new contact preselects it. */
  const groupKeyOf = (value: string): string => {
    for (const contact of contacts) {
      for (const group of contact.tags) {
        if (group.values.includes(value)) return group.key
      }
    }
    return DEFAULT_TAG_KEY
  }

  const openCreate = () => {
    const selected = tag === '全部' ? '默认' : tag
    setEditing(null)
    setForm({
      ...EMPTY_FORM,
      tags: [{ key: groupKeyOf(selected), values: [selected], multiple: false }],
    })
    setEditOpen(true)
  }

  const openEdit = (c: Contact) => {
    setEditing(c)
    setForm({
      name: c.name,
      phone: c.phone ?? '',
      email: c.email ?? '',
      company: c.company ?? '',
      notes: c.notes ?? '',
      tags: c.tags.map((group) => ({ ...group, values: [...group.values] })),
    })
    setEditOpen(true)
  }

  const handleSave = async () => {
    const name = form.name.trim()
    // The name becomes part of the file name: report an unusable character
    // instead of rewriting the user's name behind their back.
    const nameError = contactNameError(name)
    if (nameError) {
      toast(nameError)
      return
    }
    try {
      const params = {
        name,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        company: form.company.trim() || null,
        notes: form.notes.trim() || null,
        tags: form.tags,
      }
      if (editing) {
        await api.updateContact({ id: editing.id, ...params })
      } else {
        await api.createContact(params)
      }
      setEditOpen(false)
      toast(editing ? '已保存' : '联系人已创建')
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleDelete = async () => {
    const target = deleteConfirm
    setDeleteConfirm(null)
    if (!target) return
    try {
      await api.deleteContact(target.id)
      toast('已删除')
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="人脉"
        searchWrapRef={searchWrapRef}
        largeTitleRef={largeTitleRef}
        actions={[{ icon: <IconSettings size={22} />, label: '设置', onClick: onOpenSettings }]}
        search={{
          placeholder: '搜索姓名、电话、公司',
          value: searchInput,
          onChange: setSearchInput,
        }}
      />

      <ChipRow items={tags.map((t) => ({ key: t, label: t }))} value={tag} onChange={setTag} />

      <div className="page-scroll" ref={scrollRef}>
        <div className="scroll-shift" ref={contentShiftRef}>
          <div
            className={`scroll-content ${springing ? 'springing' : ''}`}
            style={pullDist ? { transform: `translateY(${pullDist}px)` } : undefined}
          >
            {loading && contacts.length === 0 ? (
              <div className="list-loading">加载中…</div>
            ) : contacts.length === 0 ? (
              <EmptyState
                icon={<IconUsers size={44} />}
                text={query || tag !== '全部' ? '没有匹配的联系人' : '还没有联系人，点击 + 添加'}
              />
            ) : (
              contacts.map((c) => {
                const tagValues = c.tags.flatMap((group) => group.values)
                return (
                  <div key={c.id} className="contact-row" onClick={() => openEdit(c)}>
                    <div className="avatar">{c.name.charAt(0)}</div>
                    <div className="contact-main">
                      <div className="contact-name">
                        {c.name}
                        {tagValues[0] && <span className="chip mini">{tagValues[0]}</span>}
                        {tagValues.length > 1 && (
                          <span className="chip mini">+{tagValues.length - 1}</span>
                        )}
                      </div>
                      <div className="contact-sub">
                        {[c.company, c.phone].filter(Boolean).join(' · ') || '暂无信息'}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      <FAB label="添加联系人" onClick={openCreate} />

      {deleteConfirm && (
        <ConfirmDialog
          title="删除联系人"
          message={`确定删除"${deleteConfirm.name}"吗？`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {editOpen && (
        <Modal
          title={editing ? '编辑联系人' : '添加联系人'}
          onClose={() => setEditOpen(false)}
          footer={
            <div style={{ display: 'flex', gap: 10 }}>
              {editing && (
                <button
                  type="button"
                  className="btn btn-danger"
                  style={{ flex: '0 0 96px' }}
                  onClick={() => {
                    setEditOpen(false)
                    setDeleteConfirm(editing)
                  }}
                >
                  删除
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={() => void handleSave()}>
                {editing ? '保存' : '创建'}
              </button>
            </div>
          }
        >
          <div className="contact-form">
            {/* 头像预览：用姓名首字生成，和列表里的头像保持一致 */}
            <div className="contact-form-hero">
              <div className="avatar large">{form.name.trim().charAt(0) || '新'}</div>
              <div className="contact-form-hero-text">
                <div className="contact-form-hero-name">{form.name.trim() || '新联系人'}</div>
                <div className="contact-form-hero-hint">
                  {[form.company.trim(), form.phone.trim()].filter(Boolean).join(' · ') ||
                    '填写姓名后即可保存'}
                </div>
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="contact-name">
                姓名（必填）
              </label>
              <input
                id="contact-name"
                className="form-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="联系人姓名"
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="contact-phone">
                电话
              </label>
              <div className="form-input-iconic">
                <IconPhone size={17} className="form-input-icon" />
                <input
                  id="contact-phone"
                  type="tel"
                  className="form-input"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="电话号码"
                />
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="contact-email">
                邮箱
              </label>
              <div className="form-input-iconic">
                <IconMail size={17} className="form-input-icon" />
                <input
                  id="contact-email"
                  type="email"
                  className="form-input"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="电子邮箱"
                />
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="contact-company">
                公司
              </label>
              <div className="form-input-iconic">
                <IconBuilding size={17} className="form-input-icon" />
                <input
                  id="contact-company"
                  className="form-input"
                  value={form.company}
                  onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  placeholder="公司 / 组织"
                />
              </div>
            </div>

            <div className="form-field">
              <span className="form-label">标签</span>
              <TagSelector
                value={form.tags}
                suggestions={tagSuggestions}
                onChange={(tags) => setForm((f) => ({ ...f, tags }))}
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="contact-notes">
                备注
              </label>
              <textarea
                id="contact-notes"
                className="form-textarea"
                rows={4}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="认识时间、场合等（可选）"
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
