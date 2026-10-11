import { createContext, useContext, useState } from 'react'
import type { StudySpace } from '@shared/types'
import { useToast } from './components/Toast'

export type SpaceScope = string | null | undefined
export const StudySpaceContext = createContext<{ spaces: StudySpace[]; scope: SpaceScope }>({ spaces: [], scope: undefined })
export const useStudySpace = () => useContext(StudySpaceContext)

/** A visible, reversible assignment. Changing membership never changes source links. */
export function SpaceSelect({ entity, id, value, onChanged }: {
  entity: 'document' | 'note' | 'capture'
  id: string
  value: string | null
  onChanged?(value: string | null): void | Promise<void>
}): React.ReactElement {
  const { spaces } = useStudySpace()
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  return <select className="input input-sm space-select" aria-label="所属学习区" value={value ?? ''} disabled={saving}
    onChange={async (e) => {
      const next = e.target.value || null
      setSaving(true)
      try {
        await window.api.assignSpace(entity, id, next)
        await onChanged?.(next)
        toast.push(next ? '已移入学习区' : '已移到未分区', 'success')
      } catch (error) { toast.push(`移动失败：${error instanceof Error ? error.message : String(error)}`, 'error') }
      finally { setSaving(false) }
    }}>
    <option value="">未分区</option>
    {spaces.map((space) => <option value={space.id} key={space.id}>{space.name}</option>)}
  </select>
}
