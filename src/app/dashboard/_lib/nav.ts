// Dashboard navigation. Later tasks add their pages here (tab: shown in the mobile tab bar).
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
  readonly tab: boolean;
}

export const NAV: readonly NavItem[] = [{ href: "/dashboard", label: "Home", icon: "⌂", tab: true }];
