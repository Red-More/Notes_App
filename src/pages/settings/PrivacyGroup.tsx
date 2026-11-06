import { useState } from 'react'
import { IconEye } from '../../components/Icons'
import { SettingsExpandableRow, SettingsGroup, SettingsRow } from './SettingsPrimitives'
import PrivacySection from './PrivacySection'

export default function PrivacyGroup() {
  const [open, setOpen] = useState(false)

  return (
    <SettingsGroup id="settings-privacy" title="隐私与安全" hint="未标记路径按 S1（一般敏感）处理">
      <SettingsRow
        icon={<IconEye size={20} />}
        title="云端数据保护"
        subtitle="S0 拒绝 · S1 脱敏前拒绝 · S2 允许出境"
        value="已启用"
      />
      <SettingsExpandableRow
        icon={<IconEye size={20} />}
        title="分级规则与实体库"
        subtitle="按目录路径分级，请求发送前匹配敏感实体"
        value="配置"
        open={open}
        onToggle={() => setOpen((value) => !value)}
      >
        <PrivacySection />
      </SettingsExpandableRow>
    </SettingsGroup>
  )
}
