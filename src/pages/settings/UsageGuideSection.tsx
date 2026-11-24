import { useState } from 'react'
import { IconInfo } from '../../components/Icons'
import { TODO_FORMAT_RULES } from '../../agent/prompt'
import { SettingsExpandableRow, SettingsGroup } from './SettingsPrimitives'

/** User-facing help: instructions and format references only, never sent to the model. */
export default function UsageGuideSection() {
  const [todoFormatOpen, setTodoFormatOpen] = useState(false)

  return (
    <SettingsGroup id="settings-guide" title="使用说明" hint="面向用户的操作指引与格式参考">
      <SettingsExpandableRow
        icon={<IconInfo size={20} />}
        title="待办文件格式参考"
        subtitle="智能体写入待办时使用的文件与条目格式"
        value="查看"
        open={todoFormatOpen}
        onToggle={() => setTodoFormatOpen((open) => !open)}
      >
        <div className="guide-format">
          <pre className="guide-format-body">{TODO_FORMAT_RULES}</pre>
          <p className="settings-detail-note">
            此说明仅用于查阅，不会写入规则配置；只有规则配置中的条目才会发送给智能体。
          </p>
        </div>
      </SettingsExpandableRow>
    </SettingsGroup>
  )
}
