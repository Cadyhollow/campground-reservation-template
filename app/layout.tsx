import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AccentColorProvider from "./components/AccentColorProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const campgroundName = process.env.NEXT_PUBLIC_CAMPGROUND_NAME || "Campground";

export const metadata: Metadata = {
  title: `${process.env.NEXT_PUBLIC_CAMPGROUND_NAME || "Campground"} - Reservations`,
  description: `Book your stay at ${process.env.NEXT_PUBLIC_CAMPGROUND_NAME || "Campground"}.`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AccentColorProvider />
        {children}
      </body>
    </html>
  );
}
