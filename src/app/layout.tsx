import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "WoWderhoi AHelper",
  description: "面向魔兽世界经典版拍卖行交易者的短周期市场情报终端。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-terminal-bg font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}