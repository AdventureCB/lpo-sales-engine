import type { Metadata } from "next";
import "./globals.css";
import { PhoneDock } from "./components/PhoneDock";

export const metadata: Metadata = {
  title: "LPO Sales Engine",
  description: "Lone Peak Overland internal sales tooling",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        {/* Root-mounted softphone: layouts never remount on navigation, so
            the ring modal, live call, and audio element survive any page
            change. */}
        <PhoneDock />
        {children}
      </body>
    </html>
  );
}
