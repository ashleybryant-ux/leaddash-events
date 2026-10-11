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
export const IconTicket = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M3 8a2 2 0 002-2h14a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4z" /><path d="M13 7v10" strokeDasharray="2 2" /></svg>);
export const IconPhone = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></svg>);
export const IconGear = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>);
export const IconMoney = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg>);
export const IconChart = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>);
export const IconStar = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>);
export const IconTools = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></svg>);
export const IconSignOut = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></svg>);
export const IconHouse = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></svg>);
export const IconChat = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 5h16v11H8l-4 4z" /></svg>);
export const IconMail = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>);
export const IconMic = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>);
export const IconImage = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3" y="5" width="18" height="15" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M21 17l-5-5-9 8" /></svg>);
export const IconHeart = ({ size = 16, filled, ...p }: P & { filled?: boolean }) => (<svg {...base(size)} fill={filled ? "currentColor" : "none"} {...p}><path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z" /></svg>);
