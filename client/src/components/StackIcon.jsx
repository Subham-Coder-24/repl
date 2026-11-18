import { Atom, FileCode, Globe, Hexagon, Triangle } from 'lucide-react';

const ICONS = {
  react: { Icon: Atom, color: '#61dafb' },
  nextjs: { Icon: Triangle, color: '#ffffff' },
  python: { Icon: FileCode, color: '#ffd43b' },
  node: { Icon: Hexagon, color: '#8cc84b' },
  html: { Icon: Globe, color: '#f16529' },
};

export default function StackIcon({ stack, size = 18 }) {
  const { Icon, color } = ICONS[stack] || { Icon: FileCode, color: '#aaa' };
  return <Icon size={size} color={color} />;
}
