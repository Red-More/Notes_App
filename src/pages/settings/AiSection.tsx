import { useState } from 'react'
import { IconChat, IconFolder, IconSettings } from '../../components/Icons'
import AgentSettingsSection from './AgentSettingsSection'
import McpSection from './McpSection'
import SkillsSection from './SkillsSection'
import { SettingsExpandableRow, SettingsGroup } from './SettingsPrimitives'

type AiPanel = 'agent' | 'skills' | 'mcp'

export default function AiSection() {
  const [open, setOpen] = useState<AiPanel | null>(null)

  const toggle = (panel: AiPanel) => setOpen((current) => (current === panel ? null : panel))

  return (
    <SettingsGroup
      id="settings-ai"
      title="AI 与能力"
      hint="按需展开；折叠时不加载模型与技能数据"
    >
      <SettingsExpandableRow
        icon={<IconChat size={20} />}
        title="AI 助理"
        subtitle="模型列表、API Key 与生成参数"
        value="配置"
        open={open === 'agent'}
        onToggle={() => toggle('agent')}
      >
        <div className="settings-embed">
          <AgentSettingsSection />
        </div>
      </SettingsExpandableRow>

      <SettingsExpandableRow
        icon={<IconSettings size={20} />}
        title="技能"
        subtitle="导入 .zip / .skill 扩展助手能力"
        value="管理"
        open={open === 'skills'}
        onToggle={() => toggle('skills')}
      >
        <div className="settings-embed">
          <SkillsSection />
        </div>
      </SettingsExpandableRow>

      <SettingsExpandableRow
        icon={<IconFolder size={20} />}
        title="远程 MCP"
        subtitle="连接 HTTPS 远程服务器并自动加入工具"
        value="管理"
        open={open === 'mcp'}
        onToggle={() => toggle('mcp')}
      >
        <div className="settings-embed">
          <McpSection />
        </div>
      </SettingsExpandableRow>
    </SettingsGroup>
  )
}
