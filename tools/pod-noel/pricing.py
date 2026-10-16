"""Etsy fiyat kuralı.
Güncel (Mustafa, 16 Ekim 2026 akşam): sweatshirt fiyatları ~%15-20 indirildi, hedef bant ~1.700-1.900 TL (PRICE_TRY, beden başına sabit TL).
  Koşul: kâr negatif OLMAZ. İki hesap: gerçek Etsy kesintisi (FEES) ve temkinli %17 (Mustafa'nın verdiği %15-17'nin üst ucu,
  ödeme / düzenleyici ücret / KDV payları dahil). Temkinli hesapta da net >= 0 değilse fiyat yazılmaz (price_try hata verir).
Önceki kural (aynı gün, sabah): her satıştan net EN AZ 10 $ (choose); bant fiyatı yoksa ya da mağaza USD ise hâlâ kullanılır.
Sweatshirt'ler yalnız ABD'ye, kargo ücretsiz (fiyatın içinde). Offsite Ads KAPALI (hesaba katılmaz).
  Etsy kesintileri: işlem %6,5 + ödeme %3 + 0,25 $ + ilan 0,20 $
  net = P - P * 0.095 - 0.45 - C - S      (C = Printify ürün maliyeti, S = Printify ABD kargo)"""
import math

FEES = {"transaction": 0.065, "payment_pct": 0.03, "payment_fixed": 0.25, "listing": 0.20, "offsite_ads": 0.0}
CONSERVATIVE_PCT = 0.17
MIN_NET = 10.0
PRICE_TRY = {"S": 1749.99, "M": 1749.99, "L": 1749.99, "XL": 1749.99, "2XL": 1899.99, "3XL": 1949.99}

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

def price_try(size: str, cost: float, ship: float, rate: float) -> dict:
    """Bant fiyatı (TL) + kâr dökümü (USD maliyet kur ile TL'ye çevrilir). Temkinli hesapta zarar varsa hata."""
    p = PRICE_TRY[size]; c = (cost + ship) * rate
    fee = p * (FEES["transaction"] + FEES["payment_pct"]) + (FEES["payment_fixed"] + FEES["listing"]) * rate
    n = p - fee - c; n_cons = p * (1 - CONSERVATIVE_PCT) - c
    if n_cons < 0: raise ValueError(f"{size}: {p} TL temkinli hesapta zararlı ({n_cons:.2f} TL)")
    return {"price": round(p / rate, 2), "price_local": p, "cost": round(cost, 2), "ship": round(ship, 2), "cost_try": round(c, 2), "etsy_fees_try": round(fee, 2),
            "net_try": round(n, 2), "net": round(n / rate, 2), "margin": round(n / p, 4), "net_conservative_try": round(n_cons, 2)}

def to_try(usd: float, rate: float) -> float:
    """TL fiyat, ,99 ile biter (USD karşılığının altına inmez)."""
    return math.ceil(usd * rate) + 0.99 if (usd * rate) % 1 > 0.99 else math.floor(usd * rate) + 0.99

if __name__ == "__main__":
    for s, c in (("M", 18.70), ("2XL", 21.50), ("3XL", 22.88)): print(s, price_try(s, c, 8.79, 49.53))
