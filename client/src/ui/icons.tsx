/** Line icons used across the app (24px grid, stroke = currentColor). */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 22) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });

export const IconCalendar = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>);
export const IconBookmark = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 3h12v18l-6-4-6 4z" /></svg>);
export const IconCommunity = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M3 5h12v8H7l-4 3z" /><path d="M9 16h8l4 3V9h-3" /></svg>);
export const IconMessage = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 5h16v11H9l-5 4z" /></svg>);
export const IconGrid = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></svg>);
export const IconBack = ({ size, ...p }: P) => (<svg {...base(size)} strokeWidth={2.2} {...p}><path d="M15 5l-7 7 7 7" /></svg>);
export const IconChevron = ({ size = 18, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 6l6 6-6 6" /></svg>);
export const IconClose = ({ size = 18, ...p }: P) => (<svg {...base(size)} strokeWidth={2.2} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>);
export const IconClock = ({ size = 18, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
export const IconPin = ({ size = 18, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 21s-7-6.5-7-12a7 7 0 0114 0c0 5.5-7 12-7 12z" /><circle cx="12" cy="9" r="2.5" /></svg>);
export const IconBell = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 20a2 2 0 004 0" /></svg>);
export const IconSearch = ({ size = 18, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>);
export const IconCheck = ({ size = 22, ...p }: P) => (<svg {...base(size)} strokeWidth={2.6} {...p}><path d="M5 12l5 5 9-10" /></svg>);
export const IconPlus = ({ size = 18, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>);
export const IconQr = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v7h-4M14 18v3" /></svg>);
export const IconUser = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>);
export const IconPeople = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.5c3 0 5 1.8 5.5 4.5" /></svg>);
export const IconFood = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10M17 3c-2 0-3 2-3 5s1 4 3 4v9" /></svg>);
export const IconHelp = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4M12 17h.01" /></svg>);
export const IconHome = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 11l8-7 8 7v9H4z" /></svg>);
export const IconCard = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10h5M7 14h3" /></svg>);
export const IconFolder = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M3 7h6l2 2h10v10H3z" /></svg>);
export const IconStore = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6" /></svg>);
export const IconMap = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14M15 6v14" /></svg>);
export const IconAward = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="9" r="6" /><path d="M8.5 14L7 22l5-3 5 3-1.5-8" /></svg>);
export const IconBadge = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="5" y="3" width="14" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M8.5 17c.6-1.6 1.9-2.5 3.5-2.5s2.9.9 3.5 2.5" /></svg>);
export const IconInfo = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></svg>);
export const IconPoll = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M5 20V10M12 20V4M19 20v-7" /></svg>);
export const IconDownload = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 4v12M6 11l6 6 6-6M5 21h14" /></svg>);
export const IconLock = ({ size = 14, ...p }: P) => (<svg {...base(size)} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>);
export const IconMenu = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 6h16M4 12h16M4 18h16" /></svg>);
export const IconLeaf = ({ size = 26 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20C4 10 10 4 20 4c0 10-6 16-16 16z" fill="#e88a3a" /><path d="M4 20L14 10" stroke="#0F2A23" strokeWidth="1.6" /></svg>
);
