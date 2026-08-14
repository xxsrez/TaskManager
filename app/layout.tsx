import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Task Manager",
  description: "A focused, Linear-like task tracker for projects and releases.",
  openGraph: {
    title: "Task Manager",
    description: "Move tasks, projects, and releases forward in one focused workspace.",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Task Manager",
    description: "A focused workspace for tasks, projects, and releases.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
