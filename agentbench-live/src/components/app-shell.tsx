"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./app-shell.module.css";
export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const links = [{ name: "Benchmarks", href: "/" }, { name: "Studio", href: "/studio" }, { name: "Runs", href: "/#scoreboard" }, { name: "Providers", href: "/providers" }];
  return <><a className={styles.skip} href="#app-content">Skip to content</a><header className={styles.header}><Link className={styles.brand} href="/"><span>AB</span>AgentBench</Link><nav aria-label="Primary navigation">{links.map((link) => <Link key={link.name} href={link.href} aria-current={(link.href === "/" ? path === "/" : path.startsWith(link.href.split("?")[0])) ? "page" : undefined}>{link.name}</Link>)}</nav><span className={styles.local}>Local control plane</span></header><div id="app-content">{children}</div></>;
}
