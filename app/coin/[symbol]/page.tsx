import Link from "next/link";
import CoinDetailClient from "@/components/CoinDetailClient";

export const dynamic = "force-dynamic";

export default function CoinDetailPage({ params }: { params: { symbol: string } }) {
  const coin = params.symbol.toUpperCase();
  return (
    <main className="max-w-7xl mx-auto px-4 py-6">
      <Link href="/" className="text-xs text-muted hover:text-white">
        ← Back to overview
      </Link>
      <h1 className="text-xl font-bold mt-2 mb-6">{coin} Depth Analysis</h1>
      <CoinDetailClient coin={coin} />
    </main>
  );
}
