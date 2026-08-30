import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "連薪總署｜投資資料工作站",
  description: "整合 CSV、圖片 OCR 與 SQLite 的個人投資資料分析工作站。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
