"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Cable, FileText, Info } from "lucide-react";

const navItems = [
  { href: "/settings/providers", label: "模型提供商", icon: Cable },
  { href: "/settings/system-prompt", label: "系统提示词", icon: FileText },
  { href: "/settings/about", label: "关于", icon: Info },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="flex h-full">
      <nav
        className="flex w-44 shrink-0 flex-col gap-1 border-r px-3 py-6"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="mb-2 px-3 text-xs font-medium opacity-50">设置</span>
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active ? "bg-brand text-white" : "hover:bg-[var(--muted)]",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
