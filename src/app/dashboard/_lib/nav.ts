// Dashboard navigation. `tab`: shown in the mobile tab bar (max 5); the rest are under More.
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly tab: boolean;
}

export const NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Home", icon: "⌂", tab: true },
  { href: "/dashboard/deposits", label: "Deposits", icon: "↓", tab: true },
  { href: "/dashboard/loans", label: "Loans", icon: "≡", tab: true },
  { href: "/dashboard/ledger", label: "Ledger", icon: "⛓", tab: true },
  { href: "/dashboard/cash", label: "Cash in", icon: "+", tab: false },
  { href: "/dashboard/members", label: "Members", icon: "☺", tab: false },
  { href: "/dashboard/alerts", label: "Alerts", icon: "!", tab: false },
  { href: "/dashboard/more", label: "More", icon: "…", tab: true },
];

/** Items listed on the More page. */
export const MORE: readonly NavItem[] = NAV.filter((i) => !i.tab);
