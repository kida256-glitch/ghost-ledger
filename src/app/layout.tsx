import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const viewport = { themeColor: "#0b0d12", width: "device-width", initialScale: 1 };

export const metadata: Metadata = {
  title: "Ghost Ledger",
  description: "Tamper-evident ledger for savings groups",
  icons: { icon: "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Cpath d=%27M16 3C9.9 3 6 7.6 6 13.5V28l3.3-2.4L12.7 28l3.3-2.4 3.3 2.4 3.4-2.4L26 28V13.5C26 7.6 22.1 3 16 3Z%27 fill=%27%237cf5c4%27/%3E%3C/svg%3E" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
