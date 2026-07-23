import { splitCopper } from "@/lib/wow-money";

// Wowhead-style money: numeric parts followed by the classic coin
// icons (public zamimg sprites, same source Wowhead pages use).
const COIN_ICONS = {
  gold: "https://wow.zamimg.com/images/icons/money-gold.gif",
  silver: "https://wow.zamimg.com/images/icons/money-silver.gif",
  copper: "https://wow.zamimg.com/images/icons/money-copper.gif"
} as const;

function CoinPart({ value, kind }: { value: number; kind: keyof typeof COIN_ICONS }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className={kind === "gold" ? "text-wow-gold" : kind === "silver" ? "text-wow-silver" : "text-wow-copper"}>
        {value.toLocaleString()}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny external sprite, no optimization needed */}
      <img src={COIN_ICONS[kind]} alt={kind} width={10} height={10} className="inline-block" />
    </span>
  );
}

export function Coins({ copper: totalCopper, muteZero = true }: { copper: number; muteZero?: boolean }) {
  const { gold, silver, copper } = splitCopper(totalCopper);
  const sign = totalCopper < 0 ? "-" : "";
  const showGold = gold > 0;
  const showSilver = silver > 0 || (!muteZero && showGold);
  const showCopper = copper > 0 || (!showGold && !showSilver);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {sign}
      {showGold && <CoinPart value={gold} kind="gold" />}
      {showSilver && <CoinPart value={silver} kind="silver" />}
      {showCopper && <CoinPart value={copper} kind="copper" />}
    </span>
  );
}
