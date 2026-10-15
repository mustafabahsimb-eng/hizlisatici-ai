import json
from pathlib import Path
D = Path(__file__).parent
F = {p["n"]: p for p in json.loads((D/"filtered.json").read_text(encoding="utf-8"))}
SINGLE = {1: 273, 6: 279, 11: 333, 16: 248, 2: 5, 7: 302, 12: 245, 17: 264, 3: 24, 8: 66, 13: 175, 18: 107, 4: 251, 9: 246, 14: 259, 19: 169, 5: 13, 10: 115, 15: 352, 20: 88}
SETS = {21: 287, 22: 74, 23: 256, 24: 334, 25: 228}
OLD = [273, 123]  # 01 ve eski 06 aynı çekim
def used_ids():
    return {F[n]["id"] for n in list(SINGLE.values()) + list(SETS.values()) + OLD}
if __name__ == "__main__":
    for k, n in {**SINGLE, **SETS}.items(): print(k, n, F[n]["id"], F[n]["page"])
