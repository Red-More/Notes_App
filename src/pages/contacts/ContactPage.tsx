import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useCollapsibleSearch, useDebouncedSearch } from '../../hooks'
import { friendlyError } from '../../utils'
import type { Contact } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import { IconUsers } from '../../components/Icons'
import PageHeader from '../../components/PageHeader'
import FAB from '../../components/FAB'
import EmptyState from '../../components/EmptyState'
import ChipRow from '../../components/ChipRow'

const PRESET_TAGS = ['默认', '客户', '朋友', '同事']

interface ContactForm {
  name: string
  phone: string
  email: string
  company: string
  notes: string
  tag: string
}

const EMPTY_FORM: ContactForm = {
  name: '',
  phone: '',
  email: '',
  company: '',
  notes: '',
  tag: '默认',
}

export default function ContactPage({ isActive }: { isActive: boolean }) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [searchInput, setSearchInput, query] = useDebouncedSearch()
  const [tag, setTag] = useState('全部')
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Contact | null>(null)
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM)
  const [deleteConfirm, setDeleteConfirm] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)

  // Scroll-linked collapsing search bar (same behavior as the notes page).
  const { searchWrapRef, scrollRef } = useCollapsibleSearch()

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
    ...PRESET_TAGS,
    ...[...new Set(contacts.map((c) => c.tag))].filter((t) => !PRESET_TAGS.includes(t)).sort(),
  ]

  const openCreate = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, tag: tag === '全部' ? '默认' : tag })
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
      tag: c.tag,
    })
    setEditOpen(true)
  }

  const handleSave = async () => {
    const name = form.name.trim()
    if (!name) {
      toast('请输入联系人姓名')
      return
    }
    const customTag = form.tag.trim() || '默认'
    try {
      const params = {
        name,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        company: form.company.trim() || null,
        notes: form.notes.trim() || null,
        tag: customTag,
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
        search={{
          placeholder: '搜索姓名、电话、公司',
          value: searchInput,
          onChange: setSearchInput,
        }}
      />

      <ChipRow items={tags.map((t) => ({ key: t, label: t }))} value={tag} onChange={setTag} />

      <div className="page-scroll" ref={scrollRef}>
        <div className="scroll-content">
          {loading && contacts.length === 0 ? (
            <div className="list-loading">加载中…</div>
          ) : contacts.length === 0 ? (
            <EmptyState
              icon={<IconUsers size={44} />}
              text={query || tag !== '全部' ? '没有匹配的联系人' : '还没有联系人，点击 + 添加'}
            />
          ) : (
            contacts.map((c) => (
              <div key={c.id} className="contact-row" onClick={() => openEdit(c)}>
                <div className="avatar">{c.name.charAt(0)}</div>
                <div className="contact-main">
                  <div className="contact-name">
                    {c.name}
                    <span className="chip mini">{c.tag}</span>
                  </div>
                  <div className="contact-sub">
                    {[c.company, c.phone].filter(Boolean).join(' · ') || '暂无信息'}
                  </div>
                </div>
              </div>
            ))
          )}
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
            <span className="form-label">标签</span>
            <ChipRow
              className="modal"
              items={[...new Set([...PRESET_TAGS, form.tag])].map((t) => ({ key: t, label: t }))}
              value={form.tag}
              onChange={(t) => setForm((f) => ({ ...f, tag: t }))}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="contact-phone">
              电话
            </label>
            <input
              id="contact-phone"
              type="tel"
              className="form-input"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="电话号码"
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="contact-company">
              公司
            </label>
            <input
              id="contact-company"
              className="form-input"
              value={form.company}
              onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
              placeholder="公司 / 组织"
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="contact-email">
              邮箱
            </label>
            <input
              id="contact-email"
              type="email"
              className="form-input"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="电子邮箱"
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="contact-notes">
              备注
            </label>
            <textarea
              id="contact-notes"
              className="form-textarea"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="认识时间、场合等（可选）"
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
