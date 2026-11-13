import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { IconEye, IconInfo, IconNote } from '../../components/Icons'
import { Modal } from '../../components/ui'
import { SettingsGroup, SettingsRow } from './SettingsPrimitives'

type LegalDoc = 'privacy' | 'terms'

export default function AboutSection() {
  const [version, setVersion] = useState('0.1.0')
  const [legal, setLegal] = useState<LegalDoc | null>(null)

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

      {legal && (
        <Modal
          title={legal === 'privacy' ? '隐私说明' : '用户协议（摘要）'}
          onClose={() => setLegal(null)}
        >
          {legal === 'privacy' ? <PrivacyStatement /> : <TermsStatement />}
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
