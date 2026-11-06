import { useState } from 'react'
import { api } from '../../api'
import { IconFolder, IconImage, IconSearch } from '../../components/Icons'
import { toast } from '../../toast'
import MediaUsageSection from './MediaUsageSection'
import {
  SettingsExpandableRow,
  SettingsGroup,
  SettingsRow,
  SaveStatus,
} from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

export default function StorageSection() {
  const [mediaOpen, setMediaOpen] = useState(false)
  const rebuild = useSettingSave()

  const rebuildIndex = () => {
    void rebuild.run(async () => {
      const count = await api.rebuildSearchIndex()
      toast(`已重建 ${count} 篇文档的检索索引`)
    })
  }

  return (
    <SettingsGroup id="settings-storage" title="存储与数据" hint="清理操作不可撤销，请谨慎执行">
      <SettingsExpandableRow
        icon={<IconImage size={20} />}
        title="媒体缓存"
        subtitle="图片、视频与语音产物；可回收未引用文件"
        value="查看与清理"
        open={mediaOpen}
        onToggle={() => setMediaOpen((open) => !open)}
      >
        <div className="settings-embed">
          <MediaUsageSection />
        </div>
      </SettingsExpandableRow>

      <SettingsRow
        icon={<IconSearch size={20} />}
        title="重建检索索引"
        subtitle="全文搜索异常或结果缺失时使用"
        value={rebuild.state === 'saving' ? '重建中…' : '重建'}
        status={<SaveStatus state={rebuild.state} error={rebuild.error} />}
        chevron
        disabled={rebuild.state === 'saving'}
        onClick={rebuildIndex}
      />
      <SettingsRow
        icon={<IconFolder size={20} />}
        title="本地数据库"
        subtitle="SQLite 单库，随应用数据目录保存"
        value="life.db"
      />
    </SettingsGroup>
  )
}
