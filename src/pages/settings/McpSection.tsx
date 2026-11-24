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
  const [errorMap, setErrorMap] = useState<Record<string, string>>({})

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
      // A new address or token invalidates previous discovery errors.
      setErrorMap({})
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
      setErrorMap((prev) => {
        const next = { ...prev }
        delete next[server.id]
        return next
      })
      toast(`发现 ${tools.length} 个工具`)
    } catch (error) {
      const message = friendlyError(error)
      setErrorMap((prev) => ({ ...prev, [server.id]: message }))
      toast(message)
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await mcpApi.deleteServer(deleteTarget.id)
      setDeleteTarget(null)
      setErrorMap({})
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
          支持 HTTPS 远程服务器（Streamable HTTP 与 SSE）；不启动本地进程。启用后，服务器声明的工具会自动加入对话。
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
            <div key={server.id} className="mcp-card">
              <div className="mcp-card-fields">
                <div className="mcp-card-field">
                  <span className="mcp-card-label">名称</span>
                  <span className="mcp-card-value">
                    {server.label}
                    <span className="skill-tag">{server.enabled ? '启用' : '停用'}</span>
                  </span>
                </div>
                <div className="mcp-card-field">
                  <span className="mcp-card-label">服务器地址</span>
                  <span className="mcp-card-value mcp-card-url">{server.url}</span>
                </div>
                <div className="mcp-card-field">
                  <span className="mcp-card-label">访问令牌</span>
                  <span className="mcp-card-value">
                    {server.configured ? '已保存' : '未配置'}
                  </span>
                </div>
                {toolMap[server.id] && (
                  <div className="mcp-card-field">
                    <span className="mcp-card-label">工具</span>
                    <span className="mcp-card-value">
                      {toolMap[server.id].length > 0
                        ? toolMap[server.id].map((tool) => tool.name).join('、')
                        : '未发现工具'}
                    </span>
                  </div>
                )}
              </div>
              {errorMap[server.id] && (
                <div className="mcp-card-error">
                  <span className="mcp-card-error-text">{errorMap[server.id]}</span>
                  <button
                    type="button"
                    className="mcp-error-action"
                    onClick={() => openEdit(server)}
                  >
                    更新地址
                  </button>
                </div>
              )}
              <div className="mcp-card-actions">
                <button
                  type="button"
                  className="mcp-action"
                  disabled={busyId === server.id}
                  onClick={() => void inspect(server)}
                >
                  查看工具
                </button>
                <button
                  type="button"
                  className="mcp-action"
                  disabled={busyId === server.id}
                  onClick={() => void toggle(server)}
                >
                  {server.enabled ? '停用' : '启用'}
                </button>
                <button type="button" className="mcp-action" onClick={() => openEdit(server)}>
                  <IconEdit size={15} /> 编辑
                </button>
                <button
                  type="button"
                  className="mcp-action danger"
                  onClick={() => setDeleteTarget(server)}
                >
                  <IconTrash size={15} /> 删除
                </button>
              </div>
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
            <p className="settings-note">
              必须为 HTTPS 公网域名，不支持内网、回环与本地进程；支持 Streamable HTTP 与 SSE（/sse）。
            </p>
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
