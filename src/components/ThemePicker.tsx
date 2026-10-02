import { Monitor, Moon, Sparkles, Sun } from 'lucide-react';
import { setTheme, themeOptions, useTheme, type ThemePreference } from '../theme';

const icons = { system: Monitor, light: Sun, dark: Moon, starry: Sparkles };

export function ThemeSwitcher() {
  const { preference } = useTheme();
  const Icon = icons[preference];
  const label = themeOptions.find((option) => option.value === preference)!.label;
  return (
    <label className="theme-switcher" title={`主题：${label}`}>
      <Icon size={18} aria-hidden="true" />
      <select
        aria-label="主题"
        value={preference}
        onChange={(event) => setTheme(event.target.value as ThemePreference)}
      >
        {themeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ThemeChoices() {
  const { preference } = useTheme();
  return (
    <fieldset className="theme-choices">
      <legend className="sr-only">主题</legend>
      {themeOptions.map((option) => {
        const Icon = icons[option.value];
        return (
          <label key={option.value} className={preference === option.value ? 'selected' : ''}>
            <span className="theme-swatch" data-palette={option.value} aria-hidden="true">
              <span />
            </span>
            <span className="theme-choice-label">
              <Icon size={15} aria-hidden="true" />
              {option.label}
            </span>
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={preference === option.value}
              onChange={() => setTheme(option.value)}
            />
          </label>
        );
      })}
    </fieldset>
  );
}
