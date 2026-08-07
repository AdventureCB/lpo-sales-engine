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
      <head>
        {/* Apply the saved theme before paint to avoid a flash of dark. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
      </head>
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
