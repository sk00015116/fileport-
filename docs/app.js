"use strict";
const C = window.FILEPORT, API = `${C.SUPABASE_URL}/functions/v1/api`;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB";
const fmtDate = (d) => new Date(d).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const remain = (d) => { const m = Math.round((new Date(d) - Date.now()) / 60000); return m < 1 ? "まもなく終了" : m < 60 ? `あと${m}分` : m < 1440 ? `あと${Math.round(m / 60)}時間` : `あと${Math.round(m / 1440)}日`; };
const link = (id) => `${location.origin}${location.pathname}?d=${id}`;
const store = { get: () => { try { return JSON.parse(localStorage.getItem("fp.hist") || "[]"); } catch { return []; } }, set: (v) => localStorage.setItem("fp.hist", JSON.stringify(v)) };
const state = { files: [], expiry: "24h", cfg: { maxFile: 52428800, maxFiles: 10, maxTotal: 104857600, exts: [], requireKey: false }, pw: "" };

async function api(action, body = {}) {
  let r;
  try { r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", apikey: C.SUPABASE_ANON_KEY }, body: JSON.stringify({ action, ...body }) }); }
  catch { throw new Error("サーバーに接続できません。通信環境を確認してください"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || "エラーが発生しました"), { code: j.error, status: r.status });
  return j;
}
let tt; function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("on"), 2600); }
async function copy(text) { try { await navigator.clipboard.writeText(text); } catch { const i = document.createElement("input"); i.value = text; document.body.append(i); i.select(); document.execCommand("copy"); i.remove(); } toast("コピーしました"); }
function show(v) {
  document.querySelectorAll(".view").forEach((e) => (e.hidden = e.id !== "v-" + v));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === v));
  if (v === "history") loadHistory();
}

// ---- theme ----
const root = document.documentElement;
if (localStorage.getItem("fp.theme")) root.dataset.theme = localStorage.getItem("fp.theme");
$("#theme").onclick = () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark"; localStorage.setItem("fp.theme", root.dataset.theme);
};
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));

// ---- file picking ----
function addFiles(list) {
  for (const f of list) {
    const ext = f.name.split(".").pop().toLowerCase();
    if (state.cfg.exts.length && !state.cfg.exts.includes(ext)) { toast(`${f.name}: 対応していない形式です`); continue; }
    if (f.size === 0) { toast(`${f.name}: 空のファイルです`); continue; }
    if (f.size > state.cfg.maxFile) { toast(`${f.name}: ${fmtSize(state.cfg.maxFile)}を超えています`); continue; }
    if (state.files.length >= state.cfg.maxFiles) { toast(`ファイルは${state.cfg.maxFiles}個までです`); break; }
    state.files.push(f);
  }
  renderList();
}
function renderList() {
  $("#list").innerHTML = state.files.map((f, i) => `<li><span class="ico">${esc(f.name.split(".").pop().slice(0, 4).toUpperCase())}</span><div><b>${esc(f.name)}</b><small>${fmtSize(f.size)}</small></div><button class="x" data-i="${i}" aria-label="${esc(f.name)}を外す">×</button></li>`).join("");
  const n = state.files.length, total = state.files.reduce((s, f) => s + f.size, 0);
  $("#opts").hidden = $("#go").hidden = !n;
  $("#go").textContent = `${n}個（${fmtSize(total)}）をアップロード`;
}
$("#pick").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
$("#list").onclick = (e) => { const b = e.target.closest(".x"); if (b) { state.files.splice(+b.dataset.i, 1); renderList(); } };
const drop = $("#drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));
$("#expiry").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; state.expiry = b.dataset.v; document.querySelectorAll("#expiry button").forEach((x) => x.classList.toggle("on", x === b)); };

// ---- upload ----
function put(url, file, type, onProgress) {
  return new Promise((ok, ng) => {
    const x = new XMLHttpRequest(); x.open("PUT", url);
    x.setRequestHeader("apikey", C.SUPABASE_ANON_KEY); x.setRequestHeader("Content-Type", type);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => (x.status < 300 ? ok() : ng(new Error(`アップロードに失敗しました (${x.status})`)));
    x.onerror = () => ng(new Error("通信エラーが発生しました"));
    x.send(file);
  });
}
function busy(on) { $("#go").disabled = on; $("#prog").hidden = !on; if (on) { $("#bar").style.width = "0%"; $("#pct").textContent = "0%"; } }
$("#go").onclick = async () => {
  const files = state.files, total = files.reduce((s, f) => s + f.size, 0);
  if (total > state.cfg.maxTotal) return toast(`合計${fmtSize(state.cfg.maxTotal)}までです`);
  busy(true); let created;
  try {
    created = await api("create", { files: files.map((f) => ({ name: f.name, size: f.size })), expiry: state.expiry, password: $("#pw").value, key: $("#key").value });
    const loaded = files.map(() => 0);
    const upd = () => { const p = Math.round(loaded.reduce((a, b) => a + b, 0) / total * 100); $("#bar").style.width = p + "%"; $("#pct").textContent = p + "%"; };
    for (let i = 0; i < files.length; i++) {
      const u = created.uploads[i];
      await put(`${C.SUPABASE_URL}/storage/v1/object/upload/sign/fileport/${u.path}?token=${encodeURIComponent(u.token)}`, files[i], u.contentType, (n) => { loaded[i] = n; upd(); });
      loaded[i] = files[i].size; upd();
    }
    const fin = await api("finish", { id: created.id, token: created.manageToken });
    store.set([{ id: created.id, token: created.manageToken }, ...store.get()].slice(0, 100));
    const url = link(created.id), q = qrcode(0, "M"); q.addData(url); q.make();
    $("#qr").src = q.createDataURL(6, 2); $("#url").value = url;
    $("#doneinfo").textContent = `${files.length}個のファイル · ${fmtSize(total)} · ${fmtDate(fin.expiresAt)}まで有効${$("#pw").value ? " · パスワード保護" : ""}`;
    state.files = []; $("#pw").value = ""; renderList(); show("done");
  } catch (e) {
    if (created) api("delete", { id: created.id, token: created.manageToken }).catch(() => {});
    toast(e.message);
  } finally { busy(false); }
};
$("#copy").onclick = () => copy($("#url").value);
$("#url").onfocus = (e) => e.target.select();
$("#again").onclick = () => show("send");

// ---- history ----
async function loadHistory() {
  const items = store.get(), box = $("#hist");
  if (!items.length) { box.innerHTML = '<p class="empty">まだ履歴がありません。ファイルを送ると、ここに表示されます。</p>'; return; }
  box.innerHTML = '<p class="empty">読み込み中…</p>';
  try {
    const { items: rows } = await api("mine", { items });
    if (!rows.length) { box.innerHTML = '<p class="empty">履歴はありません</p>'; return; }
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    box.innerHTML = rows.map((r) => {
      const on = r.status === "active", label = on ? remain(r.expiresAt) : r.status === "expired" ? "期限切れ" : "削除済み";
      return `<article class="card item ${on ? "" : "off"}" data-id="${r.id}">
        <b>${r.files.length}個のファイル · ${fmtSize(r.totalSize)}</b>
        <ul>${r.files.map((f) => `<li>${esc(f.name)} <small>${fmtSize(f.size)}</small></li>`).join("")}</ul>
        <div class="meta">${fmtDate(r.createdAt)} にアップロード · ${label} · ダウンロード ${r.downloadCount}回${r.protected ? " · パスワード付き" : ""}</div>
        <details><summary>ダウンロード履歴</summary>${r.downloads.length ? r.downloads.map((d) => `<div>${fmtDate(d.at)} — ${esc(d.name)}</div>`).join("") : "<div>まだありません</div>"}</details>
        <div class="acts">${on ? '<button data-act="copy">リンクをコピー</button>' : ""}${on ? '<button data-act="del" class="danger">削除</button>' : '<button data-act="hide">履歴から消す</button>'}</div></article>`;
    }).join("");
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
$("#hist").onclick = async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest(".item").dataset.id, it = store.get().find((x) => x.id === id);
  if (b.dataset.act === "copy") copy(link(id));
  if (b.dataset.act === "hide") { store.set(store.get().filter((x) => x.id !== id)); loadHistory(); }
  if (b.dataset.act === "del" && confirm("このリンクとファイルを削除します。元に戻せません。")) {
    try { await api("delete", { id, token: it.token }); toast("削除しました"); loadHistory(); } catch (er) { toast(er.message); }
  }
};

// ---- download page ----
async function initGet(id) {
  document.querySelector("#tabs").hidden = true; show("get");
  const box = $("#getbox");
  const render = (info) => {
    box.innerHTML = `<div class="dl" style="border:0"><div><b>${info.files.length}個のファイル</b><small>${fmtDate(info.createdAt)} にアップロード · ${remain(info.expiresAt)}</small></div></div>` +
      info.files.map((f) => `<div class="dl"><div>${esc(f.name)}<small>${fmtSize(f.size)}</small></div><button data-f="${f.id}">保存</button></div>`).join("") +
      (info.files.length > 1 ? '<button class="primary" id="all">すべて保存</button><div style="height:12px"></div>' : "");
    const get = async (fid) => { const { url } = await api("download", { id, fileId: fid, password: state.pw }); const a = document.createElement("a"); a.href = url; document.body.append(a); a.click(); a.remove(); };
    box.onclick = async (e) => {
      try {
        if (e.target.dataset.f) await get(e.target.dataset.f);
        if (e.target.id === "all") for (const f of info.files) { await get(f.id); await new Promise((r) => setTimeout(r, 900)); }
      } catch (er) { toast(er.message); }
    };
  };
  const ask = (msg) => {
    box.innerHTML = `<form class="pwform"><h2>パスワードが必要です</h2>${msg ? `<p class="sub" style="margin:0">${esc(msg)}</p>` : ""}<input type="password" id="gpw" placeholder="パスワード" autocomplete="off" required><button class="primary" style="margin:0">開く</button></form>`;
    box.onclick = null; $("#gpw").focus();
    box.querySelector("form").onsubmit = async (e) => {
      e.preventDefault(); state.pw = $("#gpw").value;
      try { render(await api("info", { id, password: state.pw })); } catch (er) { ask(er.message); }
    };
  };
  try { const info = await api("info", { id }); info.protected && !info.files ? ask() : render(info); }
  catch (e) { box.innerHTML = `<div class="empty"><h2>開けませんでした</h2><p>${esc(e.message)}</p></div>`; }
}

// ---- init ----
(async function () {
  try { state.cfg = await api("config"); } catch (e) { toast(e.message); }
  $("#limits").textContent = `1ファイル ${fmtSize(state.cfg.maxFile)} まで · 最大${state.cfg.maxFiles}個 · 合計 ${fmtSize(state.cfg.maxTotal)}`;
  $("#keyrow").hidden = !state.cfg.requireKey;
  const d = new URLSearchParams(location.search).get("d");
  d ? initGet(d) : show("send");
})();
