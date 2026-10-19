# POD ifadeleri için ABD marka kontrolü (USPTO resmi arama; Etsy / pazaryeri sitesi açılmaz)
# Giyim sınıfında (IC 025) yaşayan (kayıtlı ya da başvurusu süren) markaları listeler.
#   python tools/pod-noel/marka_kontrol.py                 -> durum.json'daki ürünlerin ifadeleri + varsayılan liste
#   python tools/pod-noel/marka_kontrol.py "ifade" ...     -> yalnız verilen ifadeler
# Sonuç: KAYITLI birebir eşleşme = ifadeyi başlık / etiketten kaldır (Printify güncelle, aynı ilan numarası), genel bir kelimeyse
#   (ör. "mama") açıklayıcı kullanım: kalır, izlenir. BAŞVURU = izle; kayda dönerse kaldır. Çıkış kodu: 0 temiz, 1 başvuru, 2 kayıtlı.
import json, os, sys, urllib.request

URL = "https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch"
DEFAULT = ["most likely to", "naughty list", "stay cozy", "mama", "bookish soul", "gingerbread season", "nap season", "cozy mode", "merry christmas"]


def search(phrase: str):
    body = {"query": {"bool": {"must": [{"match_phrase": {"WM": phrase}}]}}, "size": 100}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Origin": "https://tmsearch.uspto.gov", "User-Agent": "Mozilla/5.0"})
    return [h["source"] for h in json.loads(urllib.request.urlopen(req, timeout=30).read())["hits"]["hits"]]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    phrases = [a.lower() for a in sys.argv[1:]] or DEFAULT
    worst = 0
    for ph in phrases:
        live = [s for s in search(ph) if s.get("alive") and any("025" in str(c) for c in (s.get("internationalClass") or []))]
        exact = [s for s in live if str(s.get("wordmark", "")).replace('"', "").strip().lower() == ph]
        reg = [s for s in exact if str(s.get("statusDescription", "")).upper().startswith("REGISTERED") or s.get("registrationDate")]
        level = "KAYITLI" if reg else ("BAŞVURU" if exact else ("benzer" if live else "temiz"))
        worst = max(worst, 2 if reg else 1 if exact else 0)
        print(f"{level:8} {ph!r}: giyimde yaşayan {len(live)}, birebir {len(exact)}")
        for s in (exact or live)[:4]:
            print("         -", s.get("wordmark"), "|", str(s.get("statusDescription"))[:50], "|", str((s.get("ownerName") or [""])[0])[:45])
    sys.exit(worst)


if __name__ == "__main__":
    main()
