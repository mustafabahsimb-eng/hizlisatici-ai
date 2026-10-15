"""Etsy fiyat hesabı: Etsy kesintilerinden sonra satış fiyatının en az %35'i net kâr kalsın.
Kesintiler (Mustafa, 15 Ekim 2026): işlem %6,5 (fiyat + kargo üzerinden), ödeme %3 + 0,25 $, ilan 0,20 $, olası Offsite Ads %15 (en kötü durum hep hesaba katılır).
Kargo fiyatın içinde ("ücretsiz kargo"; Etsy ABD'de 35 $ üstünü öne çıkarır).
  net = P - maliyet - P*(0.065 + 0.03 + 0.15) - 0.25 - 0.20  >=  0.35 * P
  =>  P >= (maliyet + 0.45) / (1 - 0.245 - 0.35)
Fiyat .99 ile biter (yukarı yuvarlanır)."""
import math

FEES = {"transaction": 0.065, "payment_pct": 0.03, "payment_fixed": 0.25, "listing": 0.20, "offsite_ads": 0.15}
MIN_MARGIN = 0.35

def min_price(cost: float, margin: float = MIN_MARGIN, fees: dict = FEES) -> float:
    pct = fees["transaction"] + fees["payment_pct"] + fees["offsite_ads"]
    return (cost + fees["payment_fixed"] + fees["listing"]) / (1 - pct - margin)

def charm(p: float) -> float:
    """Yukarı .99'a yuvarla (49.21 -> 49.99)."""
    return math.floor(p) + 0.99 if p - math.floor(p) <= 0.99 else math.ceil(p) + 0.99

def breakdown(price: float, cost: float, fees: dict = FEES, offsite: bool = True) -> dict:
    tx = price * fees["transaction"]; pay = price * fees["payment_pct"] + fees["payment_fixed"]
    ads = price * fees["offsite_ads"] if offsite else 0.0
    net = price - cost - tx - pay - fees["listing"] - ads
    return {"price": round(price, 2), "cost": round(cost, 2), "etsy_fees": round(tx + pay + fees["listing"] + ads, 2), "net": round(net, 2), "margin": round(net / price, 4)}

def price_for(cost: float) -> dict:
    p = charm(min_price(cost))
    return {"price": p, "with_ads": breakdown(p, cost, offsite=True), "without_ads": breakdown(p, cost, offsite=False)}

if __name__ == "__main__":
    for c in (24.02, 19.94, 39.78):
        print(c, price_for(c))
