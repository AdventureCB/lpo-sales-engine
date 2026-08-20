import type { Metadata } from "next";
import "./globals.css";
import { PhoneDock } from "./components/PhoneDock";
import { ActivityTracker } from "./components/ActivityTracker";
import { ErrorReporter } from "./components/ErrorReporter";
import { PageLock } from "./components/PageLock";

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
        {/* Renderless engagement tracker — same root-mount rule as the
            softphone so it survives navigation and sees every route. */}
        <ActivityTracker />
        {/* Renderless crash telemetry — WKWebView has no devtools, so this is
            how rep-side "Application error" screens become debuggable. */}
        <ErrorReporter />
        {/* Cross-window page exclusivity — two windows never edit one page. */}
        <PageLock />
        {children}
      </body>
    </html>
  );
}
