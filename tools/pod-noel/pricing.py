"""Etsy fiyat kuralı (Mustafa, 16 Ekim 2026, son hâli): her satıştan net kâr EN AZ 10 $; Offsite Ads KAPALI (hesaba katılmaz).
Sweatshirt'ler yalnız ABD'ye, kargo ücretsiz (fiyatın içinde; Etsy ABD'de ücretsiz kargoyu öne çıkarır).
  Etsy kesintileri: işlem %6,5 + ödeme %3 + 0,25 $ + ilan 0,20 $
  net = P - P * 0.095 - 0.45 - C - S      (C = Printify ürün maliyeti, S = Printify ABD kargo)
  -> net >= 10 olan en düşük ,99 fiyat. Mağaza para birimi TL: fiyat TL'ye çevrilir, ,99 TL ile biter (TL fiyat USD karşılığının altına inmez)."""
import math

FEES = {"transaction": 0.065, "payment_pct": 0.03, "payment_fixed": 0.25, "listing": 0.20, "offsite_ads": 0.0}
MIN_NET = 10.0

def net(price: float, cost: float, ship: float, fees: dict = FEES) -> float:
    return price - price * (fees["transaction"] + fees["payment_pct"] + fees["offsite_ads"]) - fees["payment_fixed"] - fees["listing"] - cost - ship

def breakdown(price: float, cost: float, ship: float) -> dict:
    fee = price * (FEES["transaction"] + FEES["payment_pct"]) + FEES["payment_fixed"] + FEES["listing"]
    n = net(price, cost, ship)
    return {"price": round(price, 2), "cost": round(cost, 2), "ship": round(ship, 2), "etsy_fees": round(fee, 2), "net": round(n, 2), "margin": round(n / price, 4)}

def choose(cost: float, ship: float, min_net: float = MIN_NET) -> dict:
    p = math.floor((cost + ship + FEES["payment_fixed"] + FEES["listing"] + min_net) / (1 - FEES["transaction"] - FEES["payment_pct"])) + 0.99
    while net(p - 1, cost, ship) >= min_net: p -= 1          # en düşük ,99
    while net(p, cost, ship) < min_net: p += 1
    return breakdown(p, cost, ship)

def to_try(usd: float, rate: float) -> float:
    """TL fiyat, ,99 ile biter (USD karşılığının altına inmez)."""
    return math.ceil(usd * rate) + 0.99 if (usd * rate) % 1 > 0.99 else math.floor(usd * rate) + 0.99

if __name__ == "__main__":
    for c in (18.70, 21.50, 22.88): print(c, choose(c, 8.79), to_try(choose(c, 8.79)["price"], 49.39))
