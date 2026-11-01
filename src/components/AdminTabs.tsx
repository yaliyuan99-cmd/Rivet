import { useLocation } from 'react-router-dom';
import { TabLinks } from './ui.tsx';

const ITEMS = [
  { to: '/admin/credentials', label: 'Credentials' },
  { to: '/admin/adjudications', label: 'Adjudications' },
  { to: '/admin/models', label: 'Models' },
  { to: '/admin/checks', label: 'System checks' },
];

/** Shared by every Administration page. Added because the frames show each view but no index. */
export function AdminTabs() {
  const { pathname } = useLocation();
  return <TabLinks label="Administration views" items={ITEMS.map((item) => ({ ...item, current: pathname.startsWith(item.to) }))} />;
}
