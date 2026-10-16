import { List, Rows3 } from 'lucide-react';
import { setListPreferences, useListPreferences, type ListSort } from '../list-preferences';
import { useOffline } from '../connectivity';

export function ListControls() {
  const value = useListPreferences();
  const offline = useOffline();
  return <div className="list-controls" aria-label="列表显示">
    <label>排序
      <select aria-label="列表排序" disabled={offline} title={offline ? '联网后可切换排序' : undefined} value={value.sort} onChange={(event) => setListPreferences({ sort: event.target.value as ListSort })}>
        <option value="default">默认顺序</option><option value="updated">最近更新</option><option value="title">标题顺序</option>
      </select>
    </label>
    <button className="text-button" aria-label="紧凑列表" aria-pressed={value.compact} onClick={() => setListPreferences({ compact: !value.compact })}>
      {value.compact ? <List size={16} /> : <Rows3 size={16} />}<span>紧凑</span>
    </button>
  </div>;
}
