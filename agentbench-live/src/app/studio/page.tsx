import { StudioShell } from "@/components/studio/studio-shell";
import { getServerContainer } from "@/server/container";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default async function StudioPage({ searchParams }: { searchParams: Promise<{ pack?: string }> }) {
  const { pack } = await searchParams;
  const api = getServerContainer();
  const saved = (await api.listBenchmarks()).filter(item => item.writable);
  const opened = pack && saved.some(item => item.id === pack) ? await api.readBenchmark(pack) : undefined;
  return <><nav className="saved-packs" aria-label="Saved benchmarks"><Link href="/studio">+ New benchmark</Link>{saved.map(item => <Link key={item.id} href={`/studio?pack=${encodeURIComponent(item.id)}`} aria-current={pack === item.id ? "page" : undefined}>{item.name}</Link>)}<span>Save your changes before switching packs.</span></nav><StudioShell key={pack ?? "new"} initialDraft={opened?.draft} initialRevision={opened?.revision} initialSnapshotDigest={opened?.snapshotDigest} /></>;
}
