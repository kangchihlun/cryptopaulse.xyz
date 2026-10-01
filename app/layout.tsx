import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CryptoPulse Monitor",
  description: "Real-time perpetual market microstructure monitor for Perpl",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg font-mono antialiased">{children}</body>
    </html>
  );
}
