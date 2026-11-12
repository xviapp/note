import {
  ArrowLeft,
  Clock3,
  FolderOpen,
  HardDriveDownload,
  History,
  Menu,
  MessagesSquare,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  Star,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { openClips } from '../clips';
import { openAssistantThreads } from '../assistant-threads';
import { settingsTitles, type SettingsSection, type View } from '../navigation';
import { Brand } from './Brand';
import { ThemeSwitcher } from './ThemePicker';
import { Tree, type TreeProps } from './Tree';

const primaryNavItems = [
  { key: 'tree' as const, label: '全部笔记', icon: FolderOpen },
  { key: 'favorites' as const, label: '收藏', icon: Star },
  { key: 'recent' as const, label: '最近访问', icon: Clock3 },
];

const systemNavItems = [
  { key: 'offline' as const, label: '离线阅读', icon: HardDriveDownload },
  { key: 'trash' as const, label: '回收站', icon: Trash2 },
  { key: 'settings' as const, label: '设置', icon: Settings2 },
];

// The web sidebar: kept compact so the note tree gets most of its height.
export function Sidebar({
  name,
  view,
  onNew,
  onSearch,
  onClose,
  onCollapse,
  onView,
  tree,
}: {
  name: string;
  view: View;
  onNew: () => void;
  onSearch: () => void;
  onClose: () => void;
  onCollapse?: () => void;
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
          {onCollapse && (
            <button
              className="icon-button collapse-sidebar"
              aria-label="收起侧栏"
              title="收起侧栏（Ctrl+\）"
              onClick={onCollapse}
            >
              <PanelLeftClose size={18} />
            </button>
          )}
          <button className="icon-button close-sidebar" aria-label="关闭侧栏" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
      </div>
      {/* Search reads as a field of its own row, leaving the brand row two icons. */}
      <button
        className="sidebar-search"
        aria-label="搜索笔记"
        title="搜索笔记（按 ? 查看全部快捷键）"
        onClick={onSearch}
      >
        <Search size={16} aria-hidden="true" />
        <span>搜索笔记</span>
        <kbd aria-hidden="true">Ctrl K</kbd>
      </button>
      <nav className="main-nav main-nav-primary" aria-label="页面">
        {primaryNavItems.map((item) => (
          <button
            key={item.key}
            className={view === item.key ? 'active' : ''}
            aria-label={item.label}
            aria-current={view === item.key ? 'page' : undefined}
            title={item.label}
            onClick={() => onView(item.key)}
          >
            <item.icon size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-tree">
        <Tree {...tree} />
      </div>
      <nav className="main-nav main-nav-footer" aria-label="工具与系统">
        <div className="sidebar-tools-row">
          <button
            aria-label="随手记"
            title="随手记（Q）"
            onClick={() => {
              onClose();
              openClips();
            }}
          >
            <StickyNote size={15} />
            <span>随手记</span>
          </button>
          <button
            aria-label="青藜对话"
            title="青藜对话"
            onClick={() => {
              onClose();
              openAssistantThreads();
            }}
          >
            <MessagesSquare size={15} />
            <span>青藜对话</span>
          </button>
        </div>
        <div className="sidebar-system-row">
          {systemNavItems.map((item) => (
            <button
              key={item.key}
              className={view === item.key ? 'active' : ''}
              aria-label={item.label}
              aria-current={view === item.key ? 'page' : undefined}
              title={item.label}
              onClick={() => onView(item.key)}
            >
              <item.icon size={15} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
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
  onSearch,
  onSentHistory,
}: {
  view: View;
  section: SettingsSection | null;
  showBack: boolean;
  showMenu: boolean;
  menuOpen: boolean;
  onBack: () => void;
  onMenu: () => void;
  onNew?: () => void;
  onSearch: () => void;
  onSentHistory?: () => void;
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
            title="展开侧栏（Ctrl+\）"
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
      {view === 'settings' && section === 'outbox' && onSentHistory && (
        <button className="icon-button" aria-label="发送历史" title="发送历史" onClick={onSentHistory}>
          <History size={19} />
        </button>
      )}
      {view !== 'settings' && (
        <button
          className="icon-button header-search"
          aria-label="搜索笔记"
          title="搜索笔记（Ctrl+K）"
          onClick={onSearch}
        >
          <Search size={19} />
        </button>
      )}
      {view !== 'settings' && (
        <button
          className="icon-button header-clips"
          aria-label="随手记"
          title="随手记（Q）"
          onClick={openClips}
        >
          <StickyNote size={19} />
        </button>
      )}
      {onNew && (
        <button className="icon-button header-new" aria-label="新建" title="新建（N）" onClick={onNew}>
          <Plus size={20} aria-hidden="true" />
        </button>
      )}
    </header>
  );
}
