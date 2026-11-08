import { api } from '../../api'
import { IconFolder, IconSearch } from '../../components/Icons'
import { toast } from '../../toast'
import { SettingsGroup, SettingsRow, SaveStatus } from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

export default function StorageSection() {
  const rebuild = useSettingSave()

  const rebuildIndex = () => {
    void rebuild.run(async () => {
      const count = await api.rebuildSearchIndex()
      toast(`已重建 ${count} 篇文档的检索索引`)
    })
  }

  return (
    <SettingsGroup id="settings-storage" title="存储与数据" hint="清理操作不可撤销，请谨慎执行">
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
