import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { createClient } from '@supabase/supabase-js';

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
  title: `${campgroundName} - Reservations`,
  description: `Book your stay at ${campgroundName}.`,
};

async function getAccentColor() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data } = await supabase.from('settings').select('accent_color').eq('id', 1).single();
    return data?.accent_color || 'var(--accent-color)';
  } catch {
    return 'var(--accent-color)';
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const accentColor = await getAccentColor();
  
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      style={{ '--accent-color': accentColor } as React.CSSProperties}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
