import {
  ArrowLeft,
  Clock3,
  FolderOpen,
  HardDriveDownload,
  Menu,
  Plus,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { settingsTitles, type SettingsSection, type View } from '../navigation';
import { Brand } from './Brand';
import { ThemeSwitcher } from './ThemePicker';
import { Tree, type TreeProps } from './Tree';

const navItems = [
  { key: 'tree' as const, label: '全部笔记', icon: FolderOpen },
  { key: 'favorites' as const, label: '收藏', icon: Star },
  { key: 'recent' as const, label: '最近访问', icon: Clock3 },
  { key: 'offline' as const, label: '离线阅读', icon: HardDriveDownload },
  { key: 'trash' as const, label: '回收站', icon: Trash2 },
  { key: 'settings' as const, label: '设置', icon: Settings2 },
];

// The web sidebar: kept compact so the note tree gets most of its height.
export function Sidebar({
  name,
  view,
  onNew,
  onClose,
  onView,
  tree,
}: {
  name: string;
  view: View;
  onNew: () => void;
  onClose: () => void;
  onView: (view: View) => void;
  tree: TreeProps;
}) {
  return (
    <aside id="notebook-sidebar" className="sidebar" aria-label="主导航">
      <div className="sidebar-brand">
        <Brand name={name} />
        <div className="sidebar-brand-actions">
          <ThemeSwitcher />
          <button
            className="icon-button new-note-button"
            aria-label="新建笔记"
            title="新建笔记"
            onClick={onNew}
          >
            <Plus size={19} />
          </button>
          <button className="icon-button close-sidebar" aria-label="关闭侧栏" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
      </div>
      <nav className="main-nav" aria-label="页面">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={view === item.key ? 'active' : ''}
            aria-label={item.label}
            aria-current={view === item.key ? 'page' : undefined}
            title={item.label}
            onClick={() => onView(item.key)}
          >
            <item.icon size={18} />
          </button>
        ))}
      </nav>
      <div className="sidebar-tree">
        <Tree {...tree} />
      </div>
    </aside>
  );
}

const titles: Record<Exclude<View, 'settings'>, string> = {
  tree: '全部笔记',
  favorites: '收藏',
  recent: '最近访问',
  offline: '离线阅读',
  trash: '回收站',
};

// The header of every page except an open note, which has its own toolbar.
// It carries the page title; pages keep theirs for screen readers only.
export function AppHeader({
  view,
  section,
  showBack,
  showMenu,
  menuOpen,
  onBack,
  onMenu,
  onNew,
}: {
  view: View;
  section: SettingsSection | null;
  showBack: boolean;
  showMenu: boolean;
  menuOpen: boolean;
  onBack: () => void;
  onMenu: () => void;
  onNew?: () => void;
}) {
  return (
    <header className="app-header">
      <div className="header-location">
        {showBack && (
          <button className="icon-button page-back" aria-label="返回" onClick={onBack}>
            <ArrowLeft size={22} />
          </button>
        )}
        {showMenu && (
          <button
            className="icon-button mobile-menu"
            aria-label="打开笔记目录"
            aria-controls="notebook-sidebar"
            aria-expanded={menuOpen}
            onClick={onMenu}
          >
            <Menu size={21} />
          </button>
        )}
        <span className="header-title">
          {view === 'settings' ? (section ? settingsTitles[section] : '设置') : titles[view]}
        </span>
      </div>
      {onNew && (
        <button className="button compact header-new" onClick={onNew}>
          <Plus size={16} />
          新建
        </button>
      )}
    </header>
  );
}
