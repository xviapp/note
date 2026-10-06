export function Brand({ name = '页间' }: { name?: string }) {
  return (
    <div className="brand">
      <img
        className="brand-mark"
        src="/brand/day-128.png"
        width="44"
        height="44"
        alt=""
        draggable={false}
      />
      <span>{name}</span>
    </div>
  );
}
