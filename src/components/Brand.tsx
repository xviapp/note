import { useTheme } from '../theme';

export function Brand({ name = '页间' }: { name?: string }) {
  const { theme } = useTheme();
  return (
    <div className="brand">
      <img
        className="brand-mark"
        src={`/brand/${theme === 'light' ? 'day' : 'night'}-128.png`}
        width="44"
        height="44"
        alt=""
        draggable={false}
      />
      <span>{name}</span>
    </div>
  );
}
