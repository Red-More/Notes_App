import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { dateStr, monthStr, shortTime } from '../../utils'
import type { Schedule } from '../../types'
import { ConfirmDialog, Modal, toast } from '../../components/ui'
import {
  IconBell,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from '../../components/Icons'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

interface ScheduleForm {
  title: string
  date: string
  startTime: string
  endTime: string
  note: string
  reminder: boolean
}

export default function SchedulePage() {
  const [viewMonth, setViewMonth] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => dateStr(new Date()))
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form, setForm] = useState<ScheduleForm | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Schedule | null>(null)

  const load = useCallback(async () => {
    try {
      setSchedules(await api.listSchedules(monthStr(viewMonth)))
    } catch (e) {
      console.error('加载日程失败', e)
    }
  }, [viewMonth])

  useEffect(() => {
    void load()
  }, [load])

  const changeMonth = (delta: number) => {
    setViewMonth((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1))
  }

  const goToday = () => {
    const now = new Date()
    setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1))
    setSelectedDate(dateStr(now))
  }

  // Calendar grid: leading empty cells + all days of the month.
  const days = useMemo(() => {
    const y = viewMonth.getFullYear()
    const m = viewMonth.getMonth()
    const firstWeekday = new Date(y, m, 1).getDay()
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    return Array.from({ length: firstWeekday + daysInMonth }, (_, i) =>
      i < firstWeekday ? null : dateStr(new Date(y, m, i - firstWeekday + 1)),
    )
  }, [viewMonth])

  const datesWithSchedules = useMemo(
    () => new Set(schedules.map((s) => s.date)),
    [schedules],
  )
  const today = dateStr(new Date())
  const daySchedules = schedules
    .filter((s) => s.date === selectedDate)
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))

  const openCreate = () => {
    setEditing(null)
    setForm({
      title: '',
      date: selectedDate,
      startTime: '',
      endTime: '',
      note: '',
      reminder: false,
    })
    setEditOpen(true)
  }

  const openEdit = (s: Schedule) => {
    setEditing(s)
    setForm({
      title: s.title,
      date: s.date,
      startTime: s.startTime ?? '',
      endTime: s.endTime ?? '',
      note: s.note ?? '',
      reminder: s.reminder === 1,
    })
    setEditOpen(true)
  }

  const handleSave = async () => {
    if (!form) return
    const title = form.title.trim()
    if (!title) {
      toast('请输入日程标题')
      return
    }
    if (!form.date) {
      toast('请选择日期')
      return
    }
    try {
      const params = {
        title,
        date: form.date,
        startTime: form.startTime || null,
        endTime: form.endTime || null,
        note: form.note.trim() || null,
        reminder: form.reminder,
      }
      if (editing) {
        await api.updateSchedule({ id: editing.id, ...params })
      } else {
        await api.createSchedule(params)
      }
      setEditOpen(false)
      toast(editing ? '已保存' : '日程已创建')
      // Follow the schedule if it was moved to another month.
      if (form.date.slice(0, 7) !== monthStr(viewMonth)) {
        setViewMonth(new Date(`${form.date.slice(0, 7)}-01T00:00:00`))
      }
      await load()
    } catch (e) {
      toast(String(e))
    }
  }

  const handleDelete = async () => {
    const target = deleteConfirm
    setDeleteConfirm(null)
    if (!target) return
    try {
      await api.deleteSchedule(target.id)
      toast('已删除')
      await load()
    } catch (e) {
      console.error(e)
      toast('删除失败')
    }
  }

  const monthLabel = `${viewMonth.getFullYear()}年${viewMonth.getMonth() + 1}月`

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">日程</h1>
      </div>

      <div style={{ padding: '0 14px' }}>
        <div className="cal-header">
          <button type="button" className="icon-btn" onClick={() => changeMonth(-1)} aria-label="上个月">
            <IconChevronLeft size={20} />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="cal-title">{monthLabel}</span>
            <button type="button" className="chip" onClick={goToday}>
              今天
            </button>
          </div>
          <button type="button" className="icon-btn" onClick={() => changeMonth(1)} aria-label="下个月">
            <IconChevronRight size={20} />
          </button>
        </div>

        <div className="cal-weekdays">
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="cal-grid">
          {days.map((d, i) =>
            d ? (
              <button
                key={d}
                type="button"
                className={`cal-cell ${d === today ? 'today' : ''} ${d === selectedDate ? 'selected' : ''}`}
                onClick={() => setSelectedDate(d)}
              >
                {Number(d.slice(8))}
                {datesWithSchedules.has(d) && <span className="cal-dot" />}
              </button>
            ) : (
              <span key={`empty-${i}`} className="cal-cell empty" />
            ),
          )}
        </div>
      </div>

      <div className="page-scroll" style={{ paddingTop: 18 }}>
        <div className="section-title">
          {selectedDate === today ? '今天' : selectedDate.slice(5).replace('-', '月')} ·{' '}
          {daySchedules.length} 个日程
        </div>
        {daySchedules.length === 0 ? (
          <div className="empty-state">
            <IconCalendar size={44} />
            <div>当日暂无日程，点击 + 添加</div>
          </div>
        ) : (
          daySchedules.map((s) => (
            <div key={s.id} className="schedule-card" onClick={() => openEdit(s)}>
              <div className="schedule-time">
                <span className="t">{shortTime(s.startTime) || '全天'}</span>
                {s.endTime && <span className="t2">至 {shortTime(s.endTime)}</span>}
              </div>
              <div className="schedule-main">
                <div className="schedule-title">
                  {s.title}
                  {s.reminder === 1 && (
                    <span className="bell" style={{ color: 'var(--accent)', marginLeft: 6 }}>
                      <IconBell size={13} />
                    </span>
                  )}
                </div>
                {s.note && <div className="schedule-note">{s.note}</div>}
              </div>
            </div>
          ))
        )}
      </div>

      <button type="button" className="fab" aria-label="新建日程" onClick={openCreate}>
        <IconPlus size={26} />
      </button>

      {deleteConfirm && (
        <ConfirmDialog
          title="删除日程"
          message={`确定删除"${deleteConfirm.title}"吗？`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {editOpen && form && (
        <Modal
          title={editing ? '编辑日程' : '新建日程'}
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
            <label className="form-label" htmlFor="schedule-title">
              标题
            </label>
            <input
              id="schedule-title"
              className="form-input"
              value={form.title}
              onChange={(e) => setForm((f) => (f ? { ...f, title: e.target.value } : f))}
              placeholder="日程安排"
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="schedule-date">
              日期
            </label>
            <input
              id="schedule-date"
              type="date"
              className="form-input"
              value={form.date}
              onChange={(e) => setForm((f) => (f ? { ...f, date: e.target.value } : f))}
            />
          </div>
          <div className="form-field" style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label className="form-label" htmlFor="schedule-start">
                开始时间
              </label>
              <input
                id="schedule-start"
                type="time"
                className="form-input"
                value={form.startTime}
                onChange={(e) => setForm((f) => (f ? { ...f, startTime: e.target.value } : f))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label className="form-label" htmlFor="schedule-end">
                结束时间
              </label>
              <input
                id="schedule-end"
                type="time"
                className="form-input"
                value={form.endTime}
                onChange={(e) => setForm((f) => (f ? { ...f, endTime: e.target.value } : f))}
              />
            </div>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="schedule-note">
              备注
            </label>
            <textarea
              id="schedule-note"
              className="form-textarea"
              value={form.note}
              onChange={(e) => setForm((f) => (f ? { ...f, note: e.target.value } : f))}
              placeholder="补充信息（可选）"
            />
          </div>
          <div className="form-field">
            <label
              className="form-label"
              htmlFor="schedule-reminder"
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <input
                id="schedule-reminder"
                type="checkbox"
                checked={form.reminder}
                onChange={(e) => setForm((f) => (f ? { ...f, reminder: e.target.checked } : f))}
                style={{ width: 17, height: 17, accentColor: '#ff7a1a' }}
              />
              开启提醒
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}
