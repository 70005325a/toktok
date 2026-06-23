/* ============================================================
   톡톡 메신저 — 실시간 클라이언트 (서버 SSE + POST)
   ============================================================ */

const $ = (id) => document.getElementById(id);

const AVATAR_EMOJIS = ["😀", "😎", "🐱", "🐶", "🦊", "🐻", "🐼", "🐨", "🦁", "🐯", "🦄", "🐸"];
const PICKER_EMOJIS = ["😀","😁","😂","🤣","😊","😍","😘","😎","🤔","😅","😭","😱","😡","👍","👎","👏","🙏","🔥","💯","🎉","❤️","💛","💔","✨","🍀","☕","🍻","🍔","🚀","💪","👋","🙆","🙅","😴","🥳"];
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👏"];
const COLORS = ["#f7b731","#fd9644","#fc5c65","#eb3b5a","#a55eea","#8854d0","#3867d6","#4b7bec","#2d98da","#0fb9b1","#20bf6b","#26de81"];

function colorOf(seed) { let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function isImg(a) { return typeof a === "string" && a.startsWith("data:"); }
function avatarInner(a) { return isImg(a) ? `<img class="av-img" src="${a}" alt="">` : (a || "🙂"); }
function avatarStyle(a, seed) { return isImg(a) ? "" : `background:${colorOf(seed)}`; }

// ── 상태 ────────────────────────────────────────────────────
let me = null;
let pickedAvatar = AVATAR_EMOJIS[0];
let openRoomId = null;
let currentTab = "friends";
let replyTarget = null, editingId = null, roomQuery = "", actionMsgId = null;
let es = null;

let roomsSummary = [];
let onlineList = [];
const roomCache = {};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "u" + Math.random().toString(36).slice(2) + Date.now());

const BG_PRESETS = { default: "", blue: "#9fb8cf", green: "#a7c4a0", pink: "#e7b6c2", cream: "#ece3cf", lavender: "#c3b6d9", mint: "#bfe3da", dark: "#2b3340" };
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
let blocked = new Set(lsGet("tt_blocked", []));
let blockedNames = lsGet("tt_blocked_names", {});
let muted = new Set(lsGet("tt_muted", []));
let seenMap = lsGet("tt_seen", {});
let bgMap = lsGet("tt_bg", {});
let unreadAnchor = 0;
const saveBlocked = () => { lsSet("tt_blocked", [...blocked]); lsSet("tt_blocked_names", blockedNames); };
const saveMuted = () => lsSet("tt_muted", [...muted]);

// ── 서버 통신 ───────────────────────────────────────────────
function api(action, extra = {}) {
  return fetch("/api", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, clientId: me.id, ...extra }) }).catch(() => {});
}
// 롱폴링: SSE 대신 /poll 을 반복 호출 (Cloudflare 등 프록시의 스트림 버퍼링 문제 회피)
let polling = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connectStream() {
  if (polling) return;
  polling = true;
  pollLoop();
}
async function pollLoop() {
  while (polling && me) {
    try {
      const r = await fetch(`/poll?clientId=${encodeURIComponent(me.id)}`, { cache: "no-store" });
      if (r.ok) { const j = await r.json(); (j.events || []).forEach(handleEvent); }
      else await sleep(1500);
    } catch { await sleep(1500); }
  }
}

// ── 테마 ────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("dark-switch").classList.toggle("on", t === "dark");
  document.querySelector('meta[name=theme-color]').setAttribute("content", t === "dark" ? "#161c22" : "#fee500");
}
applyTheme(localStorage.getItem("tt_theme") || "light");
$("dark-toggle").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem("tt_theme", next); applyTheme(next);
};

// ── 프로필 설정 ─────────────────────────────────────────────
function buildAvatarPicker() {
  const row = $("avatar-emoji-row"); row.innerHTML = "";
  AVATAR_EMOJIS.forEach((emo) => {
    const b = document.createElement("button");
    b.textContent = emo;
    if (emo === pickedAvatar) b.classList.add("sel");
    b.onclick = () => { pickedAvatar = emo; $("avatar-preview").innerHTML = avatarInner(emo); [...row.children].forEach((c) => c.classList.remove("sel")); b.classList.add("sel"); };
    row.appendChild(b);
  });
}
$("avatar-photo-btn").onclick = () => $("avatar-img-input").click();
$("avatar-img-input").addEventListener("change", (e) => readDataURL(e, 1_500_000, (data) => {
  pickedAvatar = data; $("avatar-preview").innerHTML = avatarInner(data);
  [...$("avatar-emoji-row").children].forEach((c) => c.classList.remove("sel"));
}));
function readDataURL(e, limit, cb) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > limit) { alert(`${Math.round(limit/1e6*10)/10}MB 이하만 가능해요.`); e.target.value = ""; return; }
  const r = new FileReader();
  r.onload = () => cb(r.result, file);
  r.readAsDataURL(file);
  e.target.value = "";
}

$("setup-start").onclick = () => {
  const nickname = $("setup-nickname").value.trim();
  if (!nickname) { $("setup-nickname").focus(); return; }
  me = { id: uid(), nickname: nickname.slice(0, 20), avatar: pickedAvatar, status: $("setup-status").value.trim().slice(0, 60) };
  startSession($("setup-code").value);
};
$("setup-nickname").addEventListener("keydown", (e) => { if (e.key === "Enter") $("setup-start").click(); });
$("setup-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("setup-start").click(); });

async function startSession(code) {
  const res = await api("register", { nickname: me.nickname, avatar: me.avatar, status: me.status, code: code || "" });
  let ok = true, err = "";
  try { const j = await res.json(); ok = j.ok !== false; err = j.error || ""; } catch {}
  if (!ok) { alert(err || "입장할 수 없습니다."); me = null; sessionStorage.removeItem("tt_me"); $("setup-code").classList.remove("hidden"); $("setup-code").focus(); return; }
  sessionStorage.setItem("tt_me", JSON.stringify(me));
  $("setup").classList.add("hidden"); $("app").classList.remove("hidden");
  renderMyProfile(); connectStream(); switchTab("friends");
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}
function renderMyProfile() {
  for (const a of ["mp-avatar", "mp-avatar2"]) { $(a).innerHTML = avatarInner(me.avatar); $(a).style.cssText = avatarStyle(me.avatar, me.id); }
  for (const n of ["mp-name", "mp-name2"]) $(n).textContent = me.nickname;
  for (const s of ["mp-status", "mp-status2"]) $(s).textContent = me.status || "상태메시지를 입력해보세요";
}

// ── 탭 ──────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => (btn.onclick = () => switchTab(btn.dataset.tab)));
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("tab-friends").classList.toggle("hidden", tab !== "friends");
  $("tab-chats").classList.toggle("hidden", tab !== "chats");
  $("tab-more").classList.toggle("hidden", tab !== "more");
  $("new-room-btn").classList.toggle("hidden", tab !== "chats");
  $("search-btn").classList.toggle("hidden", tab !== "chats");
  $("app-title").textContent = { friends: "친구", chats: "채팅", more: "더보기" }[tab];
  if (tab === "friends") renderFriends();
  if (tab === "chats") renderChatList();
}

// ── 친구 목록 ───────────────────────────────────────────────
function renderFriends() {
  const others = onlineList.filter((u) => u.id !== me.id && !blocked.has(u.id));
  $("friends-label").textContent = `친구 ${others.length}`;
  const list = $("friends-list"); list.innerHTML = "";
  if (!others.length) { list.innerHTML = `<li class="empty-note">아직 접속한 친구가 없어요.<br/>다른 PC/탭에서 같은 주소로 접속하면 친구로 나타납니다!</li>`; return; }
  others.sort((a, b) => a.nickname.localeCompare(b.nickname));
  for (const u of others) {
    const li = document.createElement("li");
    li.className = "friend-item";
    li.innerHTML = `<div class="fi-avatar" style="${avatarStyle(u.avatar, u.id)}">${avatarInner(u.avatar)}<span class="dot"></span></div>
      <div class="fi-info"><span class="fi-name">${esc(u.nickname)}</span><span class="fi-status">${esc(u.status || "")}</span></div>`;
    li.onclick = () => api("openDM", { otherId: u.id });
    list.appendChild(li);
  }
}

// ── 채팅방 목록 ─────────────────────────────────────────────
function renderChatList() {
  const list = $("chat-list"); list.innerHTML = "";
  let totalUnread = 0;
  const q = $("chat-search").value.trim().toLowerCase();
  let rows = roomsSummary.slice();
  rows.forEach((r) => (totalUnread += r.unread || 0));
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.lastText || "").toLowerCase().includes(q));
  rows.sort((a, b) => b.lastTs - a.lastTs);
  if (!rows.length) list.innerHTML = `<li class="empty-note">${q ? "검색 결과가 없어요." : "채팅방이 없어요."}</li>`;
  for (const r of rows) {
    const isDM = r.type === "dm";
    const av = isDM ? (r.avatar || "🙂") : "💬";
    const li = document.createElement("li");
    li.className = "chat-room-item";
    li.innerHTML = `<div class="cri-avatar" style="${isDM ? avatarStyle(av, r.id) : "background:#6c8aa6"}">${isDM ? avatarInner(av) : "💬"}</div>
      <div class="cri-body"><div class="cri-top"><span class="cri-name">${esc(r.name)}</span>
        ${isDM ? `<span class="cri-dm">1:1</span>` : (r.memberCount ? `<span class="cri-count">${r.memberCount}</span>` : "")}
        ${muted.has(r.id) ? `<span class="cri-mute">🔕</span>` : ""}</div>
        <div class="cri-last">${r.lastText ? esc(r.lastText) : "대화를 시작해보세요"}</div></div>
      <div class="cri-side"><span class="cri-time">${r.lastTs ? shortTime(r.lastTs) : ""}</span>
        ${r.unread ? `<span class="cri-unread">${r.unread > 99 ? "99+" : r.unread}</span>` : ""}</div>`;
    li.onclick = () => openRoom(r.id);
    list.appendChild(li);
  }
  const chatTab = document.querySelector('.tab-btn[data-tab="chats"]');
  let badge = chatTab.querySelector(".tab-badge");
  if (totalUnread > 0) { if (!badge) { badge = document.createElement("span"); badge.className = "tab-badge"; chatTab.appendChild(badge); } badge.textContent = totalUnread > 99 ? "99+" : totalUnread; }
  else if (badge) badge.remove();
}
$("search-btn").onclick = () => {
  const bar = $("chat-search-bar"); bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) $("chat-search").focus(); else { $("chat-search").value = ""; renderChatList(); }
};
$("chat-search").addEventListener("input", renderChatList);
$("new-room-btn").onclick = () => openModal("새 채팅방", "", (name) => { if (name.trim()) api("createRoom", { name: name.trim() }); });

// ── 채팅방 열기 ─────────────────────────────────────────────
function openRoom(roomId) {
  const wasOpen = !$("chatroom").classList.contains("hidden");
  openRoomId = roomId; roomQuery = "";
  $("room-search-bar").classList.add("hidden"); $("room-search-input").value = "";
  $("room-menu").classList.add("hidden");
  clearReply(); clearEdit();
  unreadAnchor = seenMap[roomId] || 0;
  applyRoomBg(roomId);
  $("menu-mute").textContent = muted.has(roomId) ? "🔔 알림 켜기" : "🔕 알림 끄기";
  const summary = roomsSummary.find((r) => r.id === roomId);
  $("chat-room-name").textContent = summary ? summary.name : "";
  if (roomCache[roomId]) renderRoom(true); else $("messages").innerHTML = "";
  renderPinnedBar();
  $("chatroom").classList.remove("hidden");
  if (!wasOpen) history.pushState({ tt: "room" }, "");  // 뒤로가기로 목록 복귀 가능하게
  api("open", { roomId });
  $("message-input").focus();
}
function applyRoomBg(roomId) {
  $("messages").style.background = BG_PRESETS[bgMap[roomId]] || "";
}
function renderPinnedBar() {
  const cache = roomCache[openRoomId];
  const bar = $("pinned-bar");
  const pin = cache && cache.pinned;
  if (pin) { $("pinned-text").textContent = pin.kind === "image" ? "📷 사진" : pin.kind === "file" ? "📄 파일" : pin.kind === "audio" ? "🎤 음성" : pin.text; bar.classList.remove("hidden"); bar.dataset.mid = pin.id; }
  else bar.classList.add("hidden");
}
$("pinned-bar").onclick = (e) => { if (e.target.id === "pinned-unpin") { api("pin", { roomId: openRoomId, messageId: $("pinned-bar").dataset.mid }); } else jumpToMessage($("pinned-bar").dataset.mid); };
// 채팅방 ← 버튼: 브라우저 뒤로가기와 동일하게 동작
$("chat-back").onclick = () => { history.back(); };

function closeRoomToList() {
  if (openRoomId) api("close", { roomId: openRoomId });
  $("chatroom").classList.add("hidden"); openRoomId = null;
  $("emoji-picker").classList.add("hidden"); $("room-menu").classList.add("hidden");
  renderChatList();
}

// 열린 팝업/오버레이를 닫음 (뒤로가기 시 이것부터)
function closeTopOverlay() {
  if (!$("image-viewer").classList.contains("hidden")) { $("image-viewer").classList.add("hidden"); $("iv-img").src = ""; return true; }
  let closed = false;
  for (const id of ["action-sheet", "forward-modal", "block-modal", "bg-modal", "modal", "react-bar"]) {
    if (!$(id).classList.contains("hidden")) { $(id).classList.add("hidden"); closed = true; }
  }
  if (!$("room-menu").classList.contains("hidden")) { $("room-menu").classList.add("hidden"); closed = true; }
  return closed;
}

// 폰/브라우저 뒤로가기 처리: 팝업→채팅방→(목록에선 앱 나가기)
window.addEventListener("popstate", () => {
  if (closeTopOverlay()) { if (openRoomId) history.pushState({ tt: "room" }, ""); return; }
  if (!$("chatroom").classList.contains("hidden")) { closeRoomToList(); return; }
});

// ── 채팅방 렌더 ─────────────────────────────────────────────
function isAtBottom() { const b = $("messages"); return b.scrollHeight - b.scrollTop - b.clientHeight < 80; }
function renderRoom(force) {
  if (!openRoomId) return;
  const cache = roomCache[openRoomId];
  if (!cache) return;
  const isDM = cache.roomType === "dm";
  $("chat-room-name").textContent = cache.name;
  if (isDM) $("chat-room-members").textContent = peerStatusText(cache.peer);
  else $("chat-room-members").textContent = `참여 ${cache.memberCount || 0}명`;
  $("room-menu").querySelector('[data-act="rename"]').style.display = isDM ? "none" : "";

  const q = roomQuery.trim().toLowerCase();
  const counts = cache.counts || {};
  const box = $("messages");
  const atBottom = isAtBottom(); const prevTop = box.scrollTop;
  box.innerHTML = "";
  let lastDate = "", prevSender = null, prevMin = null, unreadPlaced = false;

  cache.messages.forEach((m, i) => {
    if (m.kind !== "system" && blocked.has(m.senderId)) return; // 차단한 사용자 메시지 숨김
    const d = new Date(m.ts);
    const dateStr = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    if (dateStr !== lastDate) { const dd = document.createElement("div"); dd.className = "date-divider"; dd.textContent = dateStr; box.appendChild(dd); lastDate = dateStr; prevSender = null; }
    if (m.kind === "system") { const s = document.createElement("div"); s.className = "system-msg"; s.textContent = m.text; box.appendChild(s); prevSender = null; return; }
    if (!unreadPlaced && !q && m.ts > unreadAnchor && m.senderId !== me.id && !m.deleted) {
      const ud = document.createElement("div"); ud.className = "unread-divider"; ud.textContent = "여기까지 읽음"; box.appendChild(ud); unreadPlaced = true; prevSender = null;
    }

    const isMe = m.senderId === me.id;
    const minute = Math.floor(m.ts / 60000);
    const grouped = m.senderId === prevSender && minute === prevMin && !m.replyTo;
    const next = cache.messages[i + 1];
    const showTime = !(next && next.senderId === m.senderId && Math.floor(next.ts / 60000) === minute && next.kind !== "system" && !next.replyTo);
    const unread = counts[m.id] || 0;
    const hit = q && m.kind === "text" && !m.deleted && m.text.toLowerCase().includes(q);

    let body;
    if (m.deleted) body = `<div class="bubble deleted">삭제된 메시지입니다</div>`;
    else if (m.kind === "image") body = `<div class="bubble" data-mid="${m.id}"><img src="${m.text}" alt="사진"/></div>`;
    else if (m.kind === "audio") body = `<div class="bubble" data-mid="${m.id}"><audio controls src="${m.text}"></audio></div>`;
    else if (m.kind === "file") body = `<div class="bubble" data-mid="${m.id}"><a href="${m.text}" download="${esc(m.fileName || "file")}" class="file-card"><span class="fc-icon">📄</span><span class="fc-info"><span class="fc-name">${esc(m.fileName || "파일")}</span><span class="fc-dl">탭하여 저장</span></span></a></div>`;
    else body = `<div class="bubble" data-mid="${m.id}">${renderText(m.text, q)}${m.edited ? '<span class="edited-tag">(수정됨)</span>' : ""}</div>`;

    const quote = m.replyTo ? `<div class="reply-quote" data-jump="${m.replyTo.id || ""}"><b>${esc(m.replyTo.nickname)}</b><span>${esc(m.replyTo.kind === "image" ? "📷 사진" : m.replyTo.kind === "file" ? "📄 파일" : m.replyTo.kind === "audio" ? "🎤 음성" : m.replyTo.text)}</span></div>` : "";
    const reactions = renderReactions(m);

    const li = document.createElement("li");
    li.id = "m_" + m.id;
    li.className = `msg ${isMe ? "me" : "other"}${grouped ? " grouped" : ""}${hit ? " hit" : ""}`;
    li.innerHTML = `<div class="msg-avatar" style="${isMe ? "" : avatarStyle(m.avatar, m.senderId)}">${isMe ? "" : avatarInner(m.avatar)}</div>
      <div class="msg-content">
        ${(!isMe && !grouped) ? `<span class="msg-name">${esc(m.nickname)}</span>` : ""}
        ${quote}
        <div class="msg-line">${body}<div class="msg-meta">${unread > 0 ? `<span class="msg-unread">${unread}</span>` : ""}${showTime ? `<span class="msg-time">${shortTime(m.ts)}</span>` : ""}</div></div>
        ${reactions}
      </div>`;
    box.appendChild(li);
    prevSender = m.senderId; prevMin = minute;
  });

  box.querySelectorAll(".bubble[data-mid]").forEach((b) => (b.onclick = (ev) => { if (["A", "AUDIO", "IMG"].includes(ev.target.tagName) || ev.target.closest("a") || ev.target.closest("audio")) return; openActionSheet(b.dataset.mid); }));
  box.querySelectorAll(".bubble img").forEach((img) => (img.onclick = (e) => { e.stopPropagation(); openImageViewer(img.getAttribute("src")); }));
  box.querySelectorAll(".reply-quote[data-jump]").forEach((qel) => (qel.onclick = () => jumpToMessage(qel.dataset.jump)));
  box.querySelectorAll(".reaction-chip").forEach((c) => (c.onclick = () => react(c.dataset.mid, c.dataset.emoji)));

  // 읽음 위치 저장 (다음 입장 시 '여기까지 읽음' 기준)
  const lastMsg = cache.messages[cache.messages.length - 1];
  if (lastMsg) { seenMap[openRoomId] = lastMsg.ts; lsSet("tt_seen", seenMap); }

  if (force || atBottom) { box.scrollTop = box.scrollHeight; hideScrollBtn(); }
  else box.scrollTop = prevTop;
}
function peerStatusText(peer) {
  if (!peer) return "1:1 채팅";
  if (peer.online) return "🟢 온라인";
  if (peer.lastSeen) return "마지막 접속 " + shortTime(peer.lastSeen);
  return "오프라인";
}
function openImageViewer(src) { $("iv-img").src = src; $("image-viewer").classList.remove("hidden"); }
$("image-viewer").onclick = () => { $("image-viewer").classList.add("hidden"); $("iv-img").src = ""; };
function renderReactions(m) {
  if (!m.reactions || !Object.keys(m.reactions).length) return "";
  const chips = Object.entries(m.reactions).map(([emo, users]) =>
    `<span class="reaction-chip${users.includes(me.id) ? " mine" : ""}" data-mid="${m.id}" data-emoji="${emo}">${emo} ${users.length}</span>`).join("");
  return `<div class="reactions">${chips}</div>`;
}
function jumpToMessage(id) {
  if (!id) return;
  const el = $("m_" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.querySelector(".bubble")?.classList.add("flash");
  setTimeout(() => el.querySelector(".bubble")?.classList.remove("flash"), 1200);
}

// 스크롤 버튼
$("messages").addEventListener("scroll", () => { if (isAtBottom()) hideScrollBtn(); else $("scroll-bottom").classList.remove("hidden"); });
$("scroll-bottom").onclick = () => { $("messages").scrollTop = $("messages").scrollHeight; hideScrollBtn(); };
function hideScrollBtn() { const b = $("scroll-bottom"); b.classList.add("hidden"); b.classList.remove("has-new"); b.textContent = "⬇ 맨 아래로"; }

// ── 메시지 전송 / 수정 ──────────────────────────────────────
$("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("message-input");
  const text = input.value.trim();
  if (!text || !openRoomId) return;
  if (editingId) { api("edit", { roomId: openRoomId, messageId: editingId, text }); clearEdit(); }
  else sendMessage(text, "text");
  input.value = ""; autoGrow(); input.focus();
});
function sendMessage(text, kind, extra = {}) {
  const payload = { roomId: openRoomId, text, kind, ...extra };
  if (replyTarget) { payload.replyTo = { id: replyTarget.id, nickname: replyTarget.nickname, text: (replyTarget.text || "").slice(0, 60), kind: replyTarget.kind }; clearReply(); }
  $("emoji-picker").classList.add("hidden");
  api("message", payload);
}
// 여러 줄 입력: Enter 전송, Shift+Enter 줄바꿈
const msgInput = $("message-input");
msgInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("message-form").requestSubmit(); } });
function autoGrow() { msgInput.style.height = "auto"; msgInput.style.height = Math.min(msgInput.scrollHeight, 96) + "px"; }
let typingThrottle = null;
msgInput.addEventListener("input", () => {
  autoGrow();
  if (!openRoomId || typingThrottle) return;
  api("typing", { roomId: openRoomId });
  typingThrottle = setTimeout(() => (typingThrottle = null), 1200);
});

// ── 액션시트 (답장/수정/복사/삭제/반응) ────────────────────
function buildReactionRow() {
  const row = $("as-reactions"); row.innerHTML = "";
  REACTION_EMOJIS.forEach((emo) => { const b = document.createElement("button"); b.textContent = emo; b.onclick = () => { react(actionMsgId, emo); $("action-sheet").classList.add("hidden"); }; row.appendChild(b); });
}
function openActionSheet(mid) {
  const cache = roomCache[openRoomId];
  const m = cache && cache.messages.find((x) => x.id === mid);
  if (!m || m.deleted) return;
  actionMsgId = mid;
  const mine = m.senderId === me.id;
  $("as-delete").style.display = mine ? "" : "none";
  $("as-edit").style.display = (mine && m.kind === "text") ? "" : "none";
  $("as-block").style.display = mine ? "none" : "";
  const cache2 = roomCache[openRoomId];
  $("as-pin").textContent = (cache2 && cache2.pinned && cache2.pinned.id === mid) ? "📌 공지 해제" : "📌 공지 고정";
  $("action-sheet").classList.remove("hidden");
}
$("action-sheet").addEventListener("click", (e) => {
  if (e.target.id === "action-sheet") return $("action-sheet").classList.add("hidden");
  const act = e.target.dataset.act;
  if (!act) return;
  const cache = roomCache[openRoomId];
  const m = cache && cache.messages.find((x) => x.id === actionMsgId);
  if (m) {
    if (act === "reply") setReply(m);
    if (act === "forward") openForward(m);
    if (act === "copy" && m.kind === "text") navigator.clipboard?.writeText(m.text).catch(() => {});
    if (act === "pin") api("pin", { roomId: openRoomId, messageId: m.id });
    if (act === "edit") setEdit(m);
    if (act === "block") blockUser(m.senderId, m.nickname);
    if (act === "delete") api("delete", { roomId: openRoomId, messageId: m.id });
  }
  $("action-sheet").classList.add("hidden");
});

// 전달
function openForward(m) {
  const list = $("forward-list"); list.innerHTML = "";
  const targets = roomsSummary.filter((r) => r.id !== openRoomId);
  if (!targets.length) { list.innerHTML = `<li class="picker-empty">전달할 다른 채팅방이 없어요.</li>`; }
  for (const r of targets) {
    const isDM = r.type === "dm"; const av = isDM ? (r.avatar || "🙂") : "💬";
    const li = document.createElement("li");
    li.innerHTML = `<span class="pk-av" style="${isDM ? avatarStyle(av, r.id) : "background:#6c8aa6"}">${isDM ? avatarInner(av) : "💬"}</span> ${esc(r.name)}`;
    li.onclick = () => {
      api("message", { roomId: r.id, text: m.text, kind: m.kind, fileName: m.fileName, duration: m.duration });
      $("forward-modal").classList.add("hidden");
    };
    list.appendChild(li);
  }
  $("forward-modal").classList.remove("hidden");
}
$("forward-cancel").onclick = () => $("forward-modal").classList.add("hidden");

// 차단
function blockUser(id, name) {
  if (id === me.id) return;
  blocked.add(id); blockedNames[id] = name || "사용자"; saveBlocked();
  renderRoom(); if (currentTab === "friends") renderFriends();
}
function unblockUser(id) { blocked.delete(id); delete blockedNames[id]; saveBlocked(); renderBlockList(); renderRoom(); if (currentTab === "friends") renderFriends(); }
function renderBlockList() {
  const list = $("block-list"); list.innerHTML = "";
  if (!blocked.size) { list.innerHTML = `<li class="picker-empty">차단한 사용자가 없어요.</li>`; return; }
  for (const id of blocked) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="pk-av" style="background:${colorOf(id)}">🚫</span> ${esc(blockedNames[id] || "사용자")} <button class="pk-unblock">차단 해제</button>`;
    li.querySelector(".pk-unblock").onclick = () => unblockUser(id);
    list.appendChild(li);
  }
}
$("open-blocklist").onclick = () => { renderBlockList(); $("block-modal").classList.remove("hidden"); };
$("block-close").onclick = () => $("block-modal").classList.add("hidden");
function react(mid, emoji) { api("react", { roomId: openRoomId, messageId: mid, emoji }); }

function setReply(m) {
  clearEdit(); replyTarget = m;
  $("rb-name").textContent = m.nickname + "에게 답장";
  $("rb-text").textContent = m.kind === "image" ? "📷 사진" : m.kind === "file" ? "📄 파일" : m.kind === "audio" ? "🎤 음성" : m.text;
  $("reply-banner").classList.remove("hidden"); $("message-input").focus();
}
function clearReply() { replyTarget = null; $("reply-banner").classList.add("hidden"); }
$("rb-cancel").onclick = clearReply;

function setEdit(m) {
  clearReply(); editingId = m.id;
  $("eb-text").textContent = m.text;
  $("edit-banner").classList.remove("hidden");
  msgInput.value = m.text; autoGrow(); msgInput.focus();
}
function clearEdit() { editingId = null; $("edit-banner").classList.add("hidden"); }
$("eb-cancel").onclick = () => { clearEdit(); msgInput.value = ""; autoGrow(); };

// ── 방 내 검색 ──────────────────────────────────────────────
$("room-search-btn").onclick = () => {
  const bar = $("room-search-bar"); bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) $("room-search-input").focus(); else { roomQuery = ""; renderRoom(); }
};
$("room-search-close").onclick = () => { $("room-search-bar").classList.add("hidden"); roomQuery = ""; renderRoom(); };
$("room-search-input").addEventListener("input", (e) => { roomQuery = e.target.value; renderRoom(); });

// ── 방 메뉴 (이름변경/참여자) ──────────────────────────────
$("room-menu-btn").onclick = (e) => { e.stopPropagation(); $("room-menu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest("#room-menu") && e.target.id !== "room-menu-btn") $("room-menu").classList.add("hidden"); });
$("room-menu").addEventListener("click", (e) => {
  const act = e.target.dataset.act; if (!act) return;
  $("room-menu").classList.add("hidden");
  if (act === "rename") openModal("채팅방 이름 변경", $("chat-room-name").textContent, (name) => { if (name.trim()) api("renameRoom", { roomId: openRoomId, name: name.trim() }); });
  if (act === "members") {
    const names = onlineList.filter((u) => !blocked.has(u.id)).map((u) => "• " + u.nickname).join("\n") || "(접속자 없음)";
    alert("현재 접속 중\n\n" + names);
  }
  if (act === "mute") {
    if (muted.has(openRoomId)) muted.delete(openRoomId); else muted.add(openRoomId);
    saveMuted(); $("menu-mute").textContent = muted.has(openRoomId) ? "🔔 알림 켜기" : "🔕 알림 끄기";
    if (currentTab === "chats") renderChatList();
  }
  if (act === "bg") openBgModal();
  if (act === "delete") {
    if (confirm("이 채팅방을 삭제할까요?\n(모든 참여자에게서 사라지고 대화 내용도 지워집니다)")) api("deleteRoom", { roomId: openRoomId });
  }
});

// 배경 변경
function openBgModal() {
  const wrap = $("bg-swatches"); wrap.innerHTML = "";
  const cur = bgMap[openRoomId] || "default";
  Object.entries(BG_PRESETS).forEach(([key, color]) => {
    const b = document.createElement("button");
    b.style.background = color || "var(--chat-bg)";
    if (key === cur) b.classList.add("sel");
    b.onclick = () => { bgMap[openRoomId] = key; lsSet("tt_bg", bgMap); applyRoomBg(openRoomId); $("bg-modal").classList.add("hidden"); };
    wrap.appendChild(b);
  });
  $("bg-modal").classList.remove("hidden");
}
$("bg-close").onclick = () => $("bg-modal").classList.add("hidden");

// ── 이모지 / 이미지 / 파일 ──────────────────────────────────
const picker = $("emoji-picker");
PICKER_EMOJIS.forEach((emo) => { const b = document.createElement("button"); b.textContent = emo; b.type = "button"; b.onclick = () => { msgInput.value += emo; autoGrow(); msgInput.focus(); }; picker.appendChild(b); });
$("emoji-btn").onclick = () => picker.classList.toggle("hidden");
$("img-btn").onclick = () => $("img-input").click();
$("img-input").addEventListener("change", (e) => readDataURL(e, 2_000_000, (data) => sendMessage(data, "image")));
$("file-btn").onclick = () => $("file-input").click();
$("file-input").addEventListener("change", (e) => readDataURL(e, 5_000_000, (data, file) => sendMessage(data, "file", { fileName: file.name })));

// ── 음성 메시지 (녹음) ──────────────────────────────────────
let mediaRecorder = null, recChunks = [], recStart = 0, recTimer = null, recStream = null;
$("voice-btn").onclick = async () => {
  if (!navigator.mediaDevices?.getUserMedia) { alert("이 브라우저는 음성 녹음을 지원하지 않아요."); return; }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { alert("마이크 권한이 필요해요."); return; }
  recChunks = [];
  mediaRecorder = new MediaRecorder(recStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recStream.getTracks().forEach((t) => t.stop());
    if (mediaRecorder._cancelled) return;
    const blob = new Blob(recChunks, { type: "audio/webm" });
    if (blob.size > 6_000_000) { alert("녹음이 너무 길어요."); return; }
    const dur = Math.round((Date.now() - recStart) / 1000);
    const r = new FileReader();
    r.onload = () => sendMessage(r.result, "audio", { duration: dur });
    r.readAsDataURL(blob);
  };
  mediaRecorder.start();
  recStart = Date.now();
  $("recording-bar").classList.remove("hidden");
  recTimer = setInterval(() => { const s = Math.floor((Date.now() - recStart) / 1000); $("rec-time").textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; }, 500);
};
$("rec-stop").onclick = () => { if (mediaRecorder && mediaRecorder.state !== "inactive") { mediaRecorder._cancelled = false; mediaRecorder.stop(); } endRec(); };
$("rec-cancel").onclick = () => { if (mediaRecorder && mediaRecorder.state !== "inactive") { mediaRecorder._cancelled = true; mediaRecorder.stop(); } endRec(); };
function endRec() { clearInterval(recTimer); $("recording-bar").classList.add("hidden"); $("rec-time").textContent = "0:00"; }

// ── 드래그&드롭 / 붙여넣기 업로드 ──────────────────────────
function sendFileObject(file) {
  if (!openRoomId || !file) return;
  const limit = file.type.startsWith("image/") ? 2_000_000 : 5_000_000;
  if (file.size > limit) { alert("파일이 너무 커요."); return; }
  const r = new FileReader();
  r.onload = () => file.type.startsWith("image/") ? sendMessage(r.result, "image") : sendMessage(r.result, "file", { fileName: file.name });
  r.readAsDataURL(file);
}
const chatScreen = $("chatroom");
["dragenter", "dragover"].forEach((ev) => chatScreen.addEventListener(ev, (e) => { e.preventDefault(); }));
chatScreen.addEventListener("drop", (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) sendFileObject(f); });
msgInput.addEventListener("paste", (e) => { for (const it of e.clipboardData.items) { if (it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) { e.preventDefault(); sendFileObject(f); } } } });

// ── 더보기 ──────────────────────────────────────────────────
$("edit-profile").onclick = () => openModal("닉네임 변경", me.nickname, (name) => { if (name.trim()) { me.nickname = name.trim().slice(0, 20); sessionStorage.setItem("tt_me", JSON.stringify(me)); renderMyProfile(); api("updateProfile", { nickname: me.nickname }); } });
$("change-photo").onclick = () => avatarImg2.click();
const avatarImg2 = document.createElement("input");
avatarImg2.type = "file"; avatarImg2.accept = "image/*"; avatarImg2.hidden = true; document.body.appendChild(avatarImg2);
avatarImg2.addEventListener("change", (e) => readDataURL(e, 1_500_000, (data) => { me.avatar = data; sessionStorage.setItem("tt_me", JSON.stringify(me)); renderMyProfile(); api("updateProfile", { avatar: data }); }));
$("logout").onclick = () => { sessionStorage.removeItem("tt_me"); location.reload(); };

// ── 모달 ────────────────────────────────────────────────────
let modalCb = null;
function openModal(title, value, cb) { $("modal-title").textContent = title; $("modal-input").value = value; modalCb = cb; $("modal").classList.remove("hidden"); $("modal-input").focus(); }
$("modal-cancel").onclick = () => $("modal").classList.add("hidden");
$("modal-ok").onclick = () => { const v = $("modal-input").value; $("modal").classList.add("hidden"); if (modalCb) modalCb(v); };
$("modal-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("modal-ok").click(); });

// ── 타이핑 / 알림 ──────────────────────────────────────────
let typingClear = null;
function showTyping(nickname) { $("typing-indicator").textContent = `${nickname} 님이 입력 중...`; clearTimeout(typingClear); typingClear = setTimeout(() => ($("typing-indicator").textContent = ""), 1600); }

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.value = 0.06;
    o.start(); o.stop(audioCtx.currentTime + 0.12);
  } catch {}
}
function notify(title, body) {
  beep();
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    try { new Notification(title, { body, icon: "icon.svg" }); } catch {}
  }
}

// ── 서버 이벤트 처리 ────────────────────────────────────────
function handleEvent(d) {
  switch (d.type) {
    case "rooms":
      roomsSummary = d.rooms || [];
      if (currentTab === "chats") renderChatList();
      if (openRoomId) { const s = roomsSummary.find((r) => r.id === openRoomId); if (s) $("chat-room-name").textContent = s.name; }
      break;
    case "online":
      onlineList = d.users || [];
      if (currentTab === "friends") renderFriends();
      break;
    case "history":
      roomCache[d.roomId] = { name: d.name, roomType: d.roomType, messages: d.messages || [], counts: d.counts || {}, memberCount: d.memberCount || 0, pinned: d.pinned || null, peer: d.peer || null };
      if (openRoomId === d.roomId) { renderRoom(true); renderPinnedBar(); }
      break;
    case "pinned": {
      const c = roomCache[d.roomId];
      if (c) c.pinned = d.message || null;
      if (openRoomId === d.roomId) renderPinnedBar();
      break;
    }
    case "message":
      if (d.message) {
        const c = roomCache[d.roomId];
        if (c) { c.messages.push(d.message); if (c.messages.length > 400) c.messages.shift(); }
        const mine = d.message.senderId === me.id;
        const mentioned = me && d.message.kind === "text" && d.message.text && d.message.text.includes("@" + me.nickname);
        if (openRoomId === d.roomId) {
          const wasBottom = isAtBottom();
          renderRoom(mine);
          if (!mine && !wasBottom) { const b = $("scroll-bottom"); b.classList.remove("hidden"); b.classList.add("has-new"); b.textContent = "⬇ 새 메시지"; }
          api("read", { roomId: d.roomId });
        }
        const blockedSender = blocked.has(d.message.senderId);
        const isMuted = muted.has(d.roomId);
        if (!mine && !blockedSender && !isMuted && (document.hidden || openRoomId !== d.roomId || mentioned)) {
          const preview = d.message.kind === "image" ? "📷 사진" : d.message.kind === "file" ? "📄 파일" : d.message.kind === "audio" ? "🎤 음성 메시지" : d.message.text;
          notify((mentioned ? "📣 " : "") + d.message.nickname, preview);
        }
      }
      break;
    case "update": {
      const c = roomCache[d.roomId];
      if (c && d.message) { const idx = c.messages.findIndex((x) => x.id === d.message.id); if (idx >= 0) c.messages[idx] = d.message; }
      if (openRoomId === d.roomId) renderRoom();
      break;
    }
    case "deleted": {
      const c = roomCache[d.roomId];
      if (c) { const m = c.messages.find((x) => x.id === d.messageId); if (m) { m.deleted = true; m.text = ""; m.kind = "text"; } }
      if (openRoomId === d.roomId) renderRoom();
      break;
    }
    case "read": {
      const c = roomCache[d.roomId];
      if (c) { c.counts = d.counts || {}; if (openRoomId === d.roomId) renderRoom(); }
      break;
    }
    case "roomCreated": openRoom(d.roomId); break;
    case "roomDeleted":
      delete roomCache[d.roomId];
      if (openRoomId === d.roomId) { openRoomId = null; $("chatroom").classList.add("hidden"); $("room-menu").classList.add("hidden"); $("emoji-picker").classList.add("hidden"); }
      if (currentTab === "chats") renderChatList();
      break;
    case "roomRenamed": if (openRoomId === d.roomId) $("chat-room-name").textContent = d.name; break;
    case "typing": if (openRoomId === d.roomId) showTyping(d.nickname); break;
  }
}

// ── 텍스트 렌더 (검색 강조 / 링크 / 멘션) ──────────────────
function shortTime(ts) { const d = new Date(ts); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, "0"); const ampm = h < 12 ? "오전" : "오후"; h = h % 12 || 12; return `${ampm} ${h}:${m}`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function highlight(text, q) {
  const e = esc(text); if (!q) return e;
  const idx = text.toLowerCase().indexOf(q); if (idx < 0) return e;
  return esc(text.slice(0, idx)) + "<mark>" + esc(text.slice(idx, idx + q.length)) + "</mark>" + esc(text.slice(idx + q.length));
}
function renderText(text, q) {
  if (q) return highlight(text, q);
  let html = esc(text);
  html = html.replace(/(https?:\/\/[^\s]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  html = html.replace(/(^|\s)(@[\w가-힣]{1,20})/g, (mt, pre, name) => `${pre}<span class="mention">${name}</span>`);
  return html;
}

// ── PWA (새 버전이 뜨면 자동 새로고침) ─────────────────────
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (refreshing) return; refreshing = true; location.reload(); });
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {}));
}

// ── 시작 ────────────────────────────────────────────────────
buildAvatarPicker(); buildReactionRow();
$("avatar-preview").innerHTML = avatarInner(pickedAvatar);
fetch("/config").then((r) => r.json()).then((c) => { if (c.requireCode) $("setup-code").classList.remove("hidden"); }).catch(() => {});
const saved = sessionStorage.getItem("tt_me");
if (saved) { try { me = JSON.parse(saved); startSession(""); } catch { sessionStorage.removeItem("tt_me"); } }
