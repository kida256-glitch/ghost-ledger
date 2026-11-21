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
  { href: "/dashboard/cash", label: "Cash in", icon: "+", tab: false },
  { href: "/dashboard/more", label: "More", icon: "…", tab: true },
];

/** Items listed on the More page (and in the desktop rail via NAV). */
export const MORE: readonly NavItem[] = [{ href: "/dashboard/cash", label: "Record cash in", icon: "+", tab: false }];
