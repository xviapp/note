import './qingli-icon.css';

export function QingliIcon({ size = 20 }: { size?: number }) {
  return <span className="qingli-icon" style={{ width: size, height: size }} aria-hidden="true" />;
}
