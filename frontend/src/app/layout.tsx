import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Outreach", template: "%s | Riyad Tech Outreach" },
  description: "Internal outreach tool for Riyad Tech.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#eef2f5",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
