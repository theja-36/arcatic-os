import type { Metadata, Viewport } from "next";
import { RegisterSW } from "@/components/mobile/RegisterSW";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arcatic Marketing OS",
  description: "Brand-aware marketing planning, creation, publishing and learning.",
  manifest: "/manifest.webmanifest",
  applicationName: "Arcatic",
  appleWebApp: { capable: true, title: "Arcatic", statusBarStyle: "default" },
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }] },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#0f766e" }, { media: "(prefers-color-scheme: dark)", color: "#121211" }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
