// =========================================================
// Aynı işi tek kez yap (farklı fonksiyon çağrıları / işçiler arasında): prep_once tablosu
// İlk gelen işi yapar ve sonucu yazar; aynı anahtarla gelenler sonucu bekler (yoklama), bekleme süresi aşılırsa kendisi yapar.
// =========================================================
export async function once<T>(db: any, key: string, fn: () => Promise<T>, opts: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 90_000, staleMs = opts.staleMs ?? 120_000;
  const { data: got } = await db.from("prep_once").select("status, value, updated_at").eq("key", key).maybeSingle();
  if (got?.status === "done") return got.value as T;
  const claim = async () => {
    const { error } = await db.from("prep_once").insert({ key, status: "running" });
    return !error;
  };
  let mine = !got && await claim();
  if (!mine && got && Date.now() - new Date(got.updated_at).getTime() > staleMs) {
    await db.from("prep_once").delete().eq("key", key).eq("status", "running");
    mine = await claim();
  }
  if (mine) {
    try {
      const v = await fn();
      await db.from("prep_once").update({ status: "done", value: v as unknown, updated_at: new Date().toISOString() }).eq("key", key);
      return v;
    } catch (e) {
      await db.from("prep_once").delete().eq("key", key);
      throw e;
    }
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    const { data } = await db.from("prep_once").select("status, value").eq("key", key).maybeSingle();
    if (data?.status === "done") return data.value as T;
    if (!data) break; // ilk yapan hata aldı: kendimiz deneriz
  }
  return await fn();
}
