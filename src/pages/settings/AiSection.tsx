import { useState } from 'react'
import { IconChat, IconEdit, IconFolder, IconNote, IconSettings } from '../../components/Icons'
import { AddModelRow, ModelConfigSection } from './AgentSettingsSection'
import McpSection from './McpSection'
import { RulesSection, SystemPromptSection } from './PromptSettingsSection'
import SkillsSection from './SkillsSection'
import { SettingsExpandableRow, SettingsGroup } from './SettingsPrimitives'

type AiPanel = 'models' | 'rules' | 'prompt' | 'skills' | 'mcp'

export default function AiSection() {
  const [open, setOpen] = useState<AiPanel | null>(null)
  const [modelsVersion, setModelsVersion] = useState(0)

  const toggle = (panel: AiPanel) => setOpen((current) => (current === panel ? null : panel))

  return (
    <SettingsGroup
      id="settings-ai"
      title="AI 与能力"
      hint="按需展开；折叠时不加载模型与技能数据"
    >
      <SettingsExpandableRow
        icon={<IconChat size={20} />}
        title="模型配置"
        subtitle="选择与切换底层模型，编辑生成参数"
        value="配置"
        open={open === 'models'}
        onToggle={() => toggle('models')}
      >
        <div className="settings-embed">
          <ModelConfigSection version={modelsVersion} />
        </div>
      </SettingsExpandableRow>

      <AddModelRow onSaved={() => setModelsVersion((value) => value + 1)} />

      <SettingsExpandableRow
        icon={<IconNote size={20} />}
        title="规则配置"
        subtitle="分条目编写，兼容 Markdown 语法"
        value="配置"
        open={open === 'rules'}
        onToggle={() => toggle('rules')}
      >
        <div className="settings-embed">
          <RulesSection />
        </div>
      </SettingsExpandableRow>

      <SettingsExpandableRow
        icon={<IconEdit size={20} />}
        title="系统提示词"
        subtitle="自定义助手行为基调"
        value="配置"
        open={open === 'prompt'}
        onToggle={() => toggle('prompt')}
      >
        <div className="settings-embed">
          <SystemPromptSection />
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
