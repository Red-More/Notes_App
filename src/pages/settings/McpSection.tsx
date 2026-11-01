import { useCallback, useEffect, useState } from 'react'
import { mcpApi } from '../../api'
import type { McpServerInfo, McpToolInfo } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { IconEdit, IconPlus, IconTrash } from '../../components/Icons'
import { friendlyError } from '../../utils'
import { toast } from '../../toast'

interface Draft {
  id: string
  label: string
  url: string
  enabled: boolean
  token: string
}

const EMPTY_DRAFT: Draft = { id: '', label: '', url: '', enabled: true, token: '' }

/** 远程 MCP 管理：仅 HTTPS，工具由服务器声明后动态挂到对话 Agent。 */
export default function McpSection() {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<McpServerInfo | null>(null)
  const [toolMap, setToolMap] = useState<Record<string, McpToolInfo[]>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setServers(await mcpApi.servers())
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setDraft(EMPTY_DRAFT)
    setEditorOpen(true)
  }

  const openEdit = (server: McpServerInfo) => {
    setDraft({
      id: server.id,
      label: server.label,
      url: server.url,
      enabled: server.enabled,
      token: '',
    })
    setEditorOpen(true)
  }

  const save = async () => {
    const label = draft.label.trim()
    const url = draft.url.trim()
    if (!label || !url) {
      toast('请填写名称与服务器地址')
      return
    }
    setSaving(true)
    try {
      const token = draft.token.trim()
      await mcpApi.saveServer({
        id: draft.id || undefined,
        label,
        url,
        enabled: draft.enabled,
        // An empty token keeps the stored one during edits.
        ...(token ? { token } : {}),
      })
      toast(draft.id ? 'MCP 服务器已更新' : 'MCP 服务器已添加')
      setEditorOpen(false)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (server: McpServerInfo) => {
    setBusyId(server.id)
    try {
      await mcpApi.saveServer({
        id: server.id,
        label: server.label,
        url: server.url,
        enabled: !server.enabled,
      })
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setBusyId(null)
    }
  }

  const inspect = async (server: McpServerInfo) => {
    setBusyId(server.id)
    try {
      const tools = await mcpApi.toolsFor(server.id)
      setToolMap((prev) => ({ ...prev, [server.id]: tools }))
      toast(`发现 ${tools.length} 个工具`)
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await mcpApi.deleteServer(deleteTarget.id)
      setDeleteTarget(null)
      toast('MCP 服务器已删除')
      await load()
    } catch (error) {
      toast(friendlyError(error))
    }
  }

  return (
    <>
      <div className="settings-section-title">远程 MCP</div>
      <div className="form-field">
        <span className="form-label">
          已配置 {servers.length} 个 · 启用 {servers.filter((server) => server.enabled).length} 个
        </span>
        <p className="settings-note">
          仅支持 HTTPS 远程服务器（Streamable HTTP）；不启动本地进程。启用后，服务器声明的工具会自动加入对话。
        </p>
        <button type="button" className="btn" onClick={openCreate}>
          <IconPlus size={16} /> 添加 MCP 服务器
        </button>
        {loading ? (
          <p className="settings-note">加载中…</p>
        ) : servers.length === 0 ? (
          <p className="settings-note">还没有 MCP 服务器。</p>
        ) : (
          servers.map((server) => (
            <div key={server.id} className="skill-row">
              <div className="skill-info">
                <span className="skill-name">
                  {server.label}
                  <span className="skill-tag">{server.enabled ? '启用' : '停用'}</span>
                </span>
                <span className="skill-desc">{server.url}</span>
                <span className="skill-triggers">
                  {server.configured ? '令牌已保存' : '无令牌'}
                  {toolMap[server.id] ? ` · ${toolMap[server.id].length} 个工具` : ''}
                </span>
                {toolMap[server.id] && toolMap[server.id].length > 0 && (
                  <span className="skill-triggers">
                    {toolMap[server.id].map((tool) => tool.name).join('、')}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="查看工具"
                disabled={busyId === server.id}
                onClick={() => void inspect(server)}
              >
                …
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={server.enabled ? '停用' : '启用'}
                disabled={busyId === server.id}
                onClick={() => void toggle(server)}
              >
                {server.enabled ? '停' : '启'}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="编辑"
                onClick={() => openEdit(server)}
              >
                <IconEdit size={17} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="删除"
                onClick={() => setDeleteTarget(server)}
              >
                <IconTrash size={17} />
              </button>
            </div>
          ))
        )}
      </div>

      {editorOpen && (
        <Modal
          title={draft.id ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
          onClose={() => setEditorOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditorOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          }
        >
          <div className="form-field">
            <span className="form-label">显示名称</span>
            <input
              className="form-input"
              value={draft.label}
              placeholder="例如 团队知识库"
              onChange={(e) => setDraft((prev) => ({ ...prev, label: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <span className="form-label">服务器地址</span>
            <input
              className="form-input"
              value={draft.url}
              placeholder="https://mcp.example.com/mcp"
              autoCapitalize="off"
              onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))}
            />
            <p className="settings-note">必须为 HTTPS 公网域名，不支持内网、回环与本地进程。</p>
          </div>
          <div className="form-field">
            <span className="form-label">访问令牌（可选）</span>
            <input
              className="form-input"
              type="password"
              value={draft.token}
              placeholder={draft.id ? '留空保留已保存的令牌' : 'Bearer Token'}
              onChange={(e) => setDraft((prev) => ({ ...prev, token: e.target.value }))}
            />
            <p className="settings-note">令牌只写入 Rust 私有存储，不进入数据库与前端日志。</p>
          </div>
          <div className="form-field">
            <span className="form-label">启用</span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除 MCP 服务器"
          message={`确定删除「${deleteTarget.label}」吗？已保存的令牌会一并清除。`}
          confirmText="删除"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  )
}
