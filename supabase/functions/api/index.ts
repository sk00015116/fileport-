// FilePort API (Supabase Edge Function). Service Role Key はここ(サーバー側)でのみ使用。
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "fileport";
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const UPLOAD_KEY = Deno.env.get("UPLOAD_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const MB = 1024 * 1024;
// ---- 制限値(ここを変えるだけで調整可能。無料枠: 1ファイル50MB・Storage合計1GB) ----
const LIM = { maxFile: 50 * MB, maxFiles: 10, maxTotal: 100 * MB, dayTransfers: 10, dayBytes: 300 * MB, maxDownloads: 100 };
const EXPIRY: Record<string, number> = { "1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000 };
const MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", zip: "application/zip", txt: "text/plain", csv: "text/csv",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };

class HttpError extends Error { constructor(public status: number, message: string, public code = "error") { super(message); } }
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const rand = (n: number) => { const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => A[x % A.length]).join(""); };
async function pbkdf(pw: string, salt: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, k, 256));
}
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const ID_RE = /^[A-Za-z0-9]{16}$/;

async function getT(id: unknown) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "リンクが見つかりません", "notfound");
  const { data } = await sb.from("transfers").select("*").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "リンクが見つかりません", "notfound");
  return data;
}
async function live(id: unknown) {
  const t = await getT(id);
  if (t.status !== "active") throw new HttpError(404, "リンクが見つかりません", "notfound");
  if (new Date(t.expires_at) < new Date()) throw new HttpError(410, "このリンクは有効期限が切れています", "expired");
  return t;
}
async function owner(t: { manage_hash: string }, token: unknown) {
  if (typeof token !== "string" || !same(await sha(token), t.manage_hash)) throw new HttpError(403, "操作する権限がありません");
}
async function unlock(t: any, pw: unknown) {
  if (t.lock_until && new Date(t.lock_until) > new Date()) throw new HttpError(429, "試行回数が多すぎます。しばらくしてからお試しください", "locked");
  if (typeof pw === "string" && pw && same(await pbkdf(pw, t.pw_salt), t.pw_hash)) {
    if (t.fail_count) await sb.from("transfers").update({ fail_count: 0 }).eq("id", t.id);
    return;
  }
  const f = t.fail_count + 1;
  await sb.from("transfers").update(f >= 5 ? { fail_count: 0, lock_until: new Date(Date.now() + 15 * 60000).toISOString() } : { fail_count: f }).eq("id", t.id);
  throw new HttpError(403, "パスワードが違います", "password");
}
async function purge(id: string) {
  const { data } = await sb.storage.from(BUCKET).list(id, { limit: 1000 });
  if (data?.length) await sb.storage.from(BUCKET).remove(data.map((o) => `${id}/${o.name}`));
  await sb.from("transfers").update({ status: "deleted" }).eq("id", id);
}

async function create(b: any, ip: string) {
  if (UPLOAD_KEY && b.key !== UPLOAD_KEY) throw new HttpError(401, "合言葉が正しくありません", "key");
  const files = b.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > LIM.maxFiles) throw new HttpError(400, `ファイルは1〜${LIM.maxFiles}個まで選べます`);
  const ttl = EXPIRY[b.expiry]; if (!ttl) throw new HttpError(400, "有効期限が不正です");
  const pw = typeof b.password === "string" ? b.password : "";
  if (pw && (pw.length < 4 || pw.length > 64)) throw new HttpError(400, "パスワードは4〜64文字で入力してください");
  let total = 0; const rows: { id: string; name: string; size: number; mime: string }[] = [];
  for (const f of files) {
    const name = String(f?.name ?? "").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200);
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const size = Number(f?.size);
    if (!MIME[ext]) throw new HttpError(400, `${name}: 対応していない形式です`);
    if (!Number.isInteger(size) || size <= 0 || size > LIM.maxFile) throw new HttpError(413, `${name}: 1ファイル${LIM.maxFile / MB}MBまでです`);
    total += size; rows.push({ id: rand(12), name, size, mime: MIME[ext] });
  }
  if (total > LIM.maxTotal) throw new HttpError(413, `合計${LIM.maxTotal / MB}MBまでです`);
  const since = new Date(Date.now() - 86400000).toISOString();
  const { data: recent } = await sb.from("transfers").select("total_size").eq("ip_hash", ip).gte("created_at", since);
  const used = (recent ?? []).reduce((s, r) => s + Number(r.total_size), 0);
  if ((recent?.length ?? 0) >= LIM.dayTransfers || used + total > LIM.dayBytes) throw new HttpError(429, "1日のアップロード上限に達しました。明日またお試しください", "quota");
  const id = rand(16), token = rand(32), expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const pw_salt = pw ? rand(16) : null, pw_hash = pw ? await pbkdf(pw, pw_salt!) : null;
  const e1 = (await sb.from("transfers").insert({ id, expires_at: expiresAt, total_size: total, pw_hash, pw_salt, manage_hash: await sha(token), ip_hash: ip })).error;
  const e2 = e1 ?? (await sb.from("files").insert(rows.map((r) => ({ ...r, transfer_id: id })))).error;
  if (e2) throw new Error(e2.message);
  const uploads = [];
  for (const r of rows) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(`${id}/${r.id}`);
    if (error || !data) throw new Error("upload url: " + error?.message);
    uploads.push({ path: data.path, token: data.token, contentType: r.mime });
  }
  return { id, manageToken: token, uploads, expiresAt };
}

async function finish(b: any) {
  const t = await getT(b.id); await owner(t, b.token);
  if (t.status !== "pending") throw new HttpError(400, "この転送は確定済みです");
  const { data: fl } = await sb.from("files").select("id,size").eq("transfer_id", t.id);
  const { data: objs } = await sb.storage.from(BUCKET).list(t.id, { limit: 100 });
  const m = new Map((objs ?? []).map((o) => [o.name, Number(o.metadata?.size)]));
  const ok = (fl ?? []).length === (objs ?? []).length && (fl ?? []).every((f) => m.get(f.id) === Number(f.size));
  if (!ok) { await purge(t.id); throw new HttpError(400, "アップロードの検証に失敗しました。もう一度お試しください"); }
  await sb.from("transfers").update({ status: "active" }).eq("id", t.id);
  return { ok: true, expiresAt: t.expires_at };
}

async function info(b: any) {
  const t = await live(b.id);
  if (t.pw_hash) { if (!b.password) return { protected: true, expiresAt: t.expires_at }; await unlock(t, b.password); }
  const { data: files } = await sb.from("files").select("id,name,size").eq("transfer_id", t.id);
  return { protected: !!t.pw_hash, id: t.id, createdAt: t.created_at, expiresAt: t.expires_at, files };
}

async function download(b: any, ua: string) {
  const t = await live(b.id);
  if (t.pw_hash) await unlock(t, b.password);
  if (t.download_count >= LIM.maxDownloads) throw new HttpError(429, "ダウンロード回数の上限に達しました", "limit");
  const { data: f } = await sb.from("files").select("id,name").eq("id", String(b.fileId)).eq("transfer_id", t.id).maybeSingle();
  if (!f) throw new HttpError(404, "ファイルが見つかりません");
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(`${t.id}/${f.id}`, 60, { download: f.name });
  if (error || !data) throw new Error("sign: " + error?.message);
  await sb.from("downloads").insert({ transfer_id: t.id, file_id: f.id, ua: ua.slice(0, 200) });
  await sb.from("transfers").update({ download_count: t.download_count + 1 }).eq("id", t.id);
  return { url: data.signedUrl };
}

async function mine(b: any) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).filter((i: any) => typeof i?.id === "string" && ID_RE.test(i.id));
  if (!items.length) return { items: [] };
  const { data: ts } = await sb.from("transfers").select("*").in("id", items.map((i: any) => i.id));
  const ok = [];
  for (const t of ts ?? []) {
    const it = items.find((i: any) => i.id === t.id);
    if (it && t.status !== "pending" && typeof it.token === "string" && same(await sha(it.token), t.manage_hash)) ok.push(t);
  }
  if (!ok.length) return { items: [] };
  const ids = ok.map((t) => t.id);
  const [{ data: fs }, { data: ds }] = await Promise.all([
    sb.from("files").select("id,transfer_id,name,size").in("transfer_id", ids),
    sb.from("downloads").select("transfer_id,file_id,at").in("transfer_id", ids).order("at", { ascending: false }).limit(300),
  ]);
  const now = new Date();
  return { items: ok.map((t) => {
    const files = (fs ?? []).filter((f) => f.transfer_id === t.id);
    return {
      id: t.id, createdAt: t.created_at, expiresAt: t.expires_at, totalSize: Number(t.total_size), protected: !!t.pw_hash,
      status: t.status === "deleted" ? "deleted" : new Date(t.expires_at) < now ? "expired" : "active",
      downloadCount: t.download_count, files,
      downloads: (ds ?? []).filter((d) => d.transfer_id === t.id).slice(0, 10).map((d) => ({ at: d.at, name: files.find((f) => f.id === d.file_id)?.name ?? "" })),
    };
  }) };
}

async function remove(b: any) {
  const t = await getT(b.id); await owner(t, b.token);
  await purge(t.id); return { ok: true };
}

async function cleanup(req: Request) {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) throw new HttpError(401, "unauthorized");
  const now = new Date().toISOString(), stale = new Date(Date.now() - 2 * 3600e3).toISOString();
  const { data } = await sb.from("transfers").select("id").neq("status", "deleted")
    .or(`expires_at.lt.${now},and(status.eq.pending,created_at.lt.${stale})`).limit(200);
  for (const t of data ?? []) await purge(t.id);
  await sb.from("transfers").delete().eq("status", "deleted").lt("expires_at", new Date(Date.now() - 90 * 86400000).toISOString());
  return { purged: data?.length ?? 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const b = await req.json().catch(() => { throw new HttpError(400, "不正なリクエストです"); });
    const ip = await sha((req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown") + ":fileport");
    switch (b.action) {
      case "config": return json({ ...LIM, exts: Object.keys(MIME), requireKey: !!UPLOAD_KEY });
      case "create": return json(await create(b, ip));
      case "finish": return json(await finish(b));
      case "info": return json(await info(b));
      case "download": return json(await download(b, req.headers.get("user-agent") ?? ""));
      case "mine": return json(await mine(b));
      case "delete": return json(await remove(b));
      case "cleanup": return json(await cleanup(req));
      default: throw new HttpError(400, "不正なリクエストです");
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error(e); return json({ error: "server", message: "サーバーでエラーが発生しました" }, 500);
  }
});
