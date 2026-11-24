import { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { IconEye, IconInfo, IconNote } from '../../components/Icons'
import { Modal } from '../../components/ui'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

type LegalDoc = 'privacy' | 'terms' | 'licenses'

interface LicenseEntry {
  name: string
  version: string
  license: string
  repository?: string
  textId?: string
  textKind?: 'file' | 'canonical'
}

interface LicensesData {
  generatedAt: string
  licenseTexts: Record<string, string>
  frontend: LicenseEntry[]
  backend: LicenseEntry[]
  assets: LicenseEntry[]
}

export default function AboutSection() {
  const [version, setVersion] = useState('0.1.0')
  const [legal, setLegal] = useState<LegalDoc | null>(null)
  const [licenses, setLicenses] = useState<LicensesData | null>(null)
  const licensesFetched = useRef(false)

  useEffect(() => {
    let cancelled = false
    void getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value)
      })
      .catch(() => {
        // Browser preview: keep the manifest fallback.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The notices JSON is ~2 MB, so it is fetched only when the dialog opens.
  // A ref (not the state) guards re-fetching, keeping the dependency array
  // free of `licenses` and avoiding a redundant effect run after loading.
  useEffect(() => {
    if (legal !== 'licenses' || licensesFetched.current) return
    let cancelled = false
    void fetch('/third-party-licenses.json')
      .then((res) => res.json())
      .then((data: LicensesData) => {
        if (!cancelled) {
          licensesFetched.current = true
          setLicenses(data)
        }
      })
      .catch(() => {
        // Generation script not run yet: the dialog shows a loading hint.
      })
    return () => {
      cancelled = true
    }
  }, [legal])

  return (
    <SettingsGroup id="settings-about" title="关于与协议">
      <SettingsRow
        icon={<IconInfo size={20} />}
        title="版本"
        subtitle="Notes · 本地优先的个人知识库"
        value={`v${version}`}
      />
      <SettingsRow
        icon={<IconNote size={20} />}
        title="检查更新"
        subtitle="当前版本不包含在线更新服务"
        value="未接入"
      />
      <SettingsRow
        icon={<IconEye size={20} />}
        title="隐私说明"
        subtitle="数据存储、云请求与通知权限"
        value="查看"
        chevron
        onClick={() => setLegal('privacy')}
      />
      <SettingsRow
        icon={<IconNote size={20} />}
        title="用户协议"
        subtitle="本地优先工具的使用约定（摘要）"
        value="查看"
        chevron
        onClick={() => setLegal('terms')}
      />
      <SettingsRow
        icon={<IconInfo size={20} />}
        title="开源许可"
        subtitle="含全部传递依赖的组件清单与许可证原文"
        value="查看"
        chevron
        onClick={() => setLegal('licenses')}
      />

      {legal && (
        <Modal
          title={
            legal === 'privacy'
              ? '隐私说明'
              : legal === 'terms'
                ? '用户协议（摘要）'
                : '开源许可'
          }
          onClose={() => setLegal(null)}
        >
          {legal === 'privacy' ? (
            <PrivacyStatement />
          ) : legal === 'terms' ? (
            <TermsStatement />
          ) : (
            <OpenSourceLicenses data={licenses} />
          )}
        </Modal>
      )}
    </SettingsGroup>
  )
}

function PrivacyStatement() {
  return (
    <div className="settings-legal">
      <p>
        Notes 采用本地优先设计。笔记、日记、待办、人脉与设置默认保存在本机
        <code>life.db</code>，不经过 Notes 服务器同步。
      </p>
      <p>
        仅当你主动使用云端 AI 功能时，相关请求才会发送到你配置的模型服务商；对话内容由该服务商按其条款处理。
      </p>
      <p>通知权限仅用于待办到期提醒，可随时在系统设置中关闭。</p>
    </div>
  )
}

function TermsStatement() {
  return (
    <div className="settings-legal">
      <p>本应用为本地优先的个人知识管理工具，按现状提供。</p>
      <p>你需自行负责数据备份；云端模型由你自行配置，其费用与合规义务由你承担。</p>
      <p>请勿使用本应用处理违法内容。继续使用即表示你理解并接受上述约定。</p>
    </div>
  )
}

function LicenseGroup({
  title,
  items,
  texts,
  query,
  expanded,
  onToggle,
}: {
  title: string
  items: LicenseEntry[]
  texts: Record<string, string>
  query: string
  expanded: string | null
  onToggle: (key: string | null) => void
}) {
  const visible = items.filter((item) => !query || item.name.toLowerCase().includes(query))
  if (visible.length === 0) return null
  return (
    <>
      <p className="section-title">
        {title}（{visible.length}
        {query ? ` / ${items.length}` : ''}）
      </p>
      <div className="license-list">
        {visible.map((item) => {
          const key = `${title}/${item.name}@${item.version}`
          const open = expanded === key
          const text = item.textId ? texts[item.textId] : ''
          return (
            <div key={key} className="license-item">
              <button
                type="button"
                className="license-toggle"
                onClick={() => onToggle(open ? null : key)}
                aria-expanded={open}
              >
                <span className="license-name">
                  {item.name}
                  {item.version ? ` · v${item.version}` : ''}
                </span>
                <span className="license-meta">
                  {item.license}
                  <span className="license-arrow">{open ? '▲' : '▼'}</span>
                </span>
              </button>
              {open &&
                (text ? (
                  <>
                    {item.textKind === 'canonical' && (
                      <p className="license-source-note">
                        上游包未附带许可文件，以下为 SPDX 标准文本。
                      </p>
                    )}
                    <pre className="license-text">{text}</pre>
                  </>
                ) : (
                  <p className="license-source-note">
                    未能获取许可证文本，
                    {item.repository ? (
                      <a href={item.repository} target="_blank" rel="noreferrer">
                        请查阅上游仓库
                      </a>
                    ) : (
                      '请查阅上游仓库'
                    )}
                    。
                  </p>
                ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

function OpenSourceLicenses({ data }: { data: LicensesData | null }) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!data) {
    return (
      <div className="settings-legal">
        <p>正在加载第三方组件清单…（若长期无响应，请先运行 pnpm gen:licenses）</p>
      </div>
    )
  }

  const query = filter.trim().toLowerCase()
  return (
    <div className="settings-legal">
      <p>
        本应用包含以下开源组件（含全部直接依赖与传递依赖），各组件的许可证原文已随应用一同分发。
        清单由 pnpm gen:licenses 从依赖树自动生成，生成于 {data.generatedAt}。
        共 {data.frontend.length} 个前端包、{data.backend.length} 个后端 crate。
        感谢各项目作者与贡献者。
      </p>
      <input
        className="license-filter"
        type="search"
        value={filter}
        placeholder="按名称过滤组件…"
        onChange={(e) => setFilter(e.target.value)}
      />
      <LicenseGroup
        title="前端依赖"
        items={data.frontend}
        texts={data.licenseTexts}
        query={query}
        expanded={expanded}
        onToggle={setExpanded}
      />
      <LicenseGroup
        title="后端依赖"
        items={data.backend}
        texts={data.licenseTexts}
        query={query}
        expanded={expanded}
        onToggle={setExpanded}
      />
      <LicenseGroup
        title="其他资产"
        items={data.assets}
        texts={data.licenseTexts}
        query={query}
        expanded={expanded}
        onToggle={setExpanded}
      />
      <p className="settings-note">
        许可证文本优先取自上游包内文件；上游未附带文件的，采用 SPDX
        标准文本并明确标注。各组件的完整版权信息以上游源码仓库为准。
      </p>
    </div>
  )
}
