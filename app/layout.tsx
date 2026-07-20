import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LPO Sales Engine",
  description: "Lone Peak Overland internal sales tooling",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
