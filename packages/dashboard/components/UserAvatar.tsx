import { avatarColors } from '@/lib/avatar';

type Props = {
  name: string;
  avatarUrl?: string | null;
  size?: number;
};

export function UserAvatar({ name, avatarUrl, size = 28 }: Props) {
  const letter = (name?.[0] ?? '?').toUpperCase();
  const style = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const;

  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} style={{ ...style, objectFit: 'cover' }} />;
  }

  const { bg, fg } = avatarColors(name);
  return (
    <span
      style={{
        ...style,
        background: bg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: fg,
        fontSize: size * 0.42,
        fontWeight: 600,
        userSelect: 'none',
      }}
    >
      {letter}
    </span>
  );
}
