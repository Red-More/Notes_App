import { useEffect, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { IconEye, IconInfo, IconNote } from '../../components/Icons'
import { Modal } from '../../components/ui'
import { renderMarkdownPreview } from '../../editor/markdown'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'
import privacySource from '../../../docs/PRIVACY.md?raw'
import termsSource from '../../../docs/TERMS.md?raw'

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
        title="隐私政策"
        subtitle="不收集数据；本地存储与第三方模型说明"
        value="查看"
        chevron
        onClick={() => setLegal('privacy')}
      />
      <SettingsRow
        icon={<IconNote size={20} />}
        title="用户协议"
        subtitle="MIT 开源授权与使用约定"
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
              ? '隐私政策'
              : legal === 'terms'
                ? '用户协议'
                : '开源许可'
          }
          onClose={() => setLegal(null)}
        >
          {legal === 'privacy' ? (
            <LegalDocument source={privacySource} />
          ) : legal === 'terms' ? (
            <LegalDocument source={termsSource} />
          ) : (
            <OpenSourceLicenses data={licenses} />
          )}
        </Modal>
      )}
    </SettingsGroup>
  )
}

// The full policy texts live in docs/*.md (single source of truth shared with
// the website) and are rendered through the sanitized markdown pipeline.
function LegalDocument({ source }: { source: string }) {
  return (
    <div
      className="settings-legal settings-legal-doc"
      dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(source) }}
    />
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
