import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Huis Law IP",
  description: "Your entire case. Connected. Organized. Intelligent.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
