// Konfigurasi Socket.IO
const socket = io();

// ==========================================
// KONSTANTA FRAME
// ==========================================
const START_BIT = "0";          // bit start
const END_BIT = "1";            // bit end
const FRAME_LEN = 10;           // 1 start + 7 data + 1 parity + 1 end
const MAX_FRAMES_MINI = 100;    // maks frame digambar di bubble chat
const LOCK_TEXT = "🔒 Pesan ter-encode";

// Variabel State Utama
let myUserId = "";
let myUserName = "";
let myUserAvatar = "";
let activeChatUserId = "";
let contacts = [];
let messagesHistory = [];
let pendingOpenText = null;   // pesan yang menunggu verifikasi kunci
let onlineUserIds = new Set(); // Menyimpan ID user yang sedang online

// Elemen DOM Utama
const loginScreen = document.getElementById("loginScreen");
const mainApp = document.getElementById("mainApp");
const contactList = document.getElementById("contactList");
const messagesContainer = document.getElementById("messages");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");

// Elemen DOM Modal Lihat Pesan
const simModal = document.getElementById("simModal");
const closeSimBtn = document.getElementById("closeSimBtn");

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function linkify(text) {
    return escapeHtml(text);
}

// ==========================================
// 1. LOGIKA SLIDING ANIMATED AUTH (LOGIN & REGISTER)
// ==========================================
const authContainer = document.getElementById('authContainer');
const toRegisterBtn = document.getElementById('toRegisterBtn');
const toLoginBtn = document.getElementById('toLoginBtn');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

toRegisterBtn?.addEventListener('click', () => authContainer?.classList.add("right-panel-active"));
toLoginBtn?.addEventListener('click', () => authContainer?.classList.remove("right-panel-active"));

loginForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmailInput').value.trim();
    const password = document.getElementById('loginPasswordInput').value;
    socket.emit("login_account", { email, password });
});

registerForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const user_name = document.getElementById('regNameInput').value.trim();
    const user_id = document.getElementById('regUserIdInput').value.trim();
    const email = document.getElementById('regEmailInput').value.trim();
    const password = document.getElementById('regPasswordInput').value;
    const confirmEl = document.getElementById('regPasswordConfirmInput');
    const access_key = document.getElementById('regKeyInput').value;

    // Validasi ulang password
    if (confirmEl && password !== confirmEl.value) {
        alert("⚠️ Password dan validasi ulang password tidak sama!");
        return;
    }

    socket.emit("register_account", { user_id, user_name, email, password, access_key });
});

socket.on("auth_response", (data) => {
    if (data.status === "error") {
        alert("⚠️ " + data.message);
    } else if (data.status === "success") {
        if (data.action === "register") {
            alert("✅ " + data.message);
            authContainer?.classList.remove("right-panel-active");
            registerForm?.reset();
        } else if (data.action === "login") {
            myUserId = data.user_id;
            myUserName = data.user_name;
            myUserAvatar = myUserName.charAt(0).toUpperCase();

            messagesHistory = [];
            contacts = [];
            activeChatUserId = "";

            if (data.history && data.history.length > 0) {
                data.history.forEach(msg => {
                    const sentByMe = msg.sender_id === myUserId;
                    const partnerId = sentByMe ? msg.receiver_id : msg.sender_id;
                    const partnerName = (sentByMe ? msg.receiver_name : msg.sender_name) || partnerId.split('_')[0];

                    let existingContact = contacts.find(c => c.id === partnerId);
                    if (!existingContact) {
                        contacts.push({
                            id: partnerId,
                            name: partnerName.charAt(0).toUpperCase() + partnerName.slice(1),
                            lastMsg: LOCK_TEXT
                        });
                    } else {
                        existingContact.lastMsg = LOCK_TEXT;
                    }

                    const timeFormatted = msg.created_at
                        ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : '';

                    messagesHistory.push({
                        sender_id: msg.sender_id,
                        sender_name: msg.sender_name,
                        receiver_id: msg.receiver_id,
                        message: msg.message,
                        time: timeFormatted
                    });
                });
            }

            if (loginScreen) {
                loginScreen.hidden = true;
                loginScreen.style.display = "none";
            }
            if (mainApp) mainApp.removeAttribute("hidden");

            document.getElementById("myName").textContent = myUserName;
            document.getElementById("myAvatar").textContent = myUserAvatar;
            document.getElementById("myIdDisplay").textContent = `ID: ${myUserId}`;

            if (simModal) simModal.hidden = true;

            // Masukkan akun sendiri ke daftar online lokal
            onlineUserIds.add(myUserId);

            // Beri tahu server kalau kita online & minta daftar user lain yang online
            socket.emit("register_online_user", myUserId);
            socket.emit("get_online_users");

            renderContacts();
            renderMessages();
            updateChatHeaderStatus();
        }
    }
});

// ==========================================
// EVENT LISTENER STATUS ONLINE / OFFLINE REALTIME
// ==========================================
socket.on("online_users_list", (users) => {
    onlineUserIds = new Set(users);
    if (myUserId) onlineUserIds.add(myUserId);
    renderContacts();
    updateChatHeaderStatus();
});

socket.on("user_status_change", ({ userId, status }) => {
    if (status === "online") {
        onlineUserIds.add(userId);
    } else {
        onlineUserIds.delete(userId);
    }
    renderContacts();
    updateChatHeaderStatus();
});

function updateChatHeaderStatus() {
    const chatStatusElem = document.getElementById("chatStatus");
    if (!chatStatusElem || !activeChatUserId) return;

    const isOnline = onlineUserIds.has(activeChatUserId);
    chatStatusElem.textContent = isOnline ? "🟢 Online" : "⚪ Offline";
    chatStatusElem.style.color = isOnline ? "#22c55e" : "#94a3b8";
}

// ==========================================
// 2. ENCODING: FRAME & NRZ-I
// ==========================================
function buildFrames(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0) & 0x7F;
        const data = code.toString(2).padStart(7, "0");
        const ones = (data.match(/1/g) || []).length;
        const parity = ones % 2 === 0 ? "0" : "1";   // even parity
        return { ch, code, data, parity, bits: START_BIT + data + parity + END_BIT };
    });
}

function nrziEncode(bits) {
    let level = 1;
    const levels = [];
    for (const b of bits) {
        if (b === "1") level = level === 1 ? 0 : 1;
        levels.push(level);
    }
    return levels;
}

// ==========================================
// 3. KONTAK
// ==========================================
const addContactBtn = document.getElementById("addContactBtn");

addContactBtn?.addEventListener("click", () => {
    const targetId = prompt("Masukkan ID Teman (contoh: ryuu_wdkmp):");
    if (!targetId) return;

    const cleanTargetId = targetId.trim().toLowerCase();
    if (cleanTargetId === myUserId) {
        alert("Kamu tidak bisa menambahkan ID diri sendiri!");
        return;
    }

    let existingContact = contacts.find(c => c.id === cleanTargetId);
    if (!existingContact) {
        const namePart = cleanTargetId.split('_')[0];
        const formattedName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
        existingContact = { id: cleanTargetId, name: formattedName, lastMsg: "Ketuk untuk memulai chat" };
        contacts.push(existingContact);
    }

    renderContacts();
    selectContact(cleanTargetId);
});

function renderContacts() {
    if (!contactList) return;
    contactList.innerHTML = "";
    if (contacts.length === 0) {
        contactList.innerHTML = `<div style="padding: 15px; color: #94a3b8; font-size: 12px; text-align: center;">Belum ada kontak. Klik "Tambah Teman via ID".</div>`;
        return;
    }

    contacts.forEach(c => {
        const isOnline = onlineUserIds.has(c.id);
        const item = document.createElement("div");
        item.className = `contact-item ${c.id === activeChatUserId ? "active" : ""}`;
        item.onclick = () => selectContact(c.id);

        item.innerHTML = `
            <div class="avatar-wrapper" style="position: relative; display: inline-block;">
                <div class="avatar">${escapeHtml(c.name.charAt(0).toUpperCase())}</div>
                <span class="status-badge ${isOnline ? 'online' : 'offline'}"></span>
            </div>
            <div class="contact-info">
                <strong>${escapeHtml(c.name)}</strong>
                <p>${escapeHtml(c.lastMsg || "Ketuk untuk memulai chat")}</p>
            </div>
            ${c.unread ? '<span class="unread-dot" title="Pesan baru"></span>' : ''}
        `;
        contactList.appendChild(item);
    });
}

function selectContact(userId) {
    activeChatUserId = userId;
    const targetContact = contacts.find(c => c.id === userId);
    if (targetContact) targetContact.unread = false;

    const chatNameElem = document.getElementById("chatName");
    const chatAvatarElem = document.getElementById("chatAvatar");

    if (chatNameElem) chatNameElem.textContent = targetContact ? `${targetContact.name} (${targetContact.id})` : userId;
    if (chatAvatarElem) chatAvatarElem.textContent = targetContact ? targetContact.name.charAt(0).toUpperCase() : "?";

    updateChatHeaderStatus();
    renderContacts();
    renderMessages();
}

// ==========================================
// 4. KIRIM & TERIMA PESAN
// ==========================================
function sendPlainText(plainText) {
    if (!activeChatUserId) { alert("Pilih kontak penerima terlebih dahulu!"); return false; }
    if (!/^[\x00-\x7F]+$/.test(plainText)) {
        alert("Pesan hanya boleh berisi karakter ASCII (tanpa emoji atau huruf spesial), karena tiap karakter dikirim sebagai 7 bit.");
        return false;
    }

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const msgData = {
        sender_id: myUserId,
        sender_name: myUserName,
        receiver_id: activeChatUserId,
        message: plainText,
        time: timeNow
    };

    messagesHistory.push(msgData);
    const contact = contacts.find(c => c.id === activeChatUserId);
    if (contact) contact.lastMsg = LOCK_TEXT;

    socket.emit("send_message", msgData);
    renderContacts();
    renderMessages();
    return true;
}

messageForm?.addEventListener("submit", function (e) {
    e.preventDefault();
    const rawMessage = messageInput.value.trim();
    if (!rawMessage) return;
    if (sendPlainText(rawMessage)) messageInput.value = "";
});

socket.on("receive_message", (data) => {
    if (data.sender_id === myUserId || data.receiver_id !== myUserId) return;

    messagesHistory.push(data);

    const isViewing = data.sender_id === activeChatUserId;

    let contact = contacts.find(c => c.id === data.sender_id);
    if (contact) {
        contact.lastMsg = LOCK_TEXT;
    } else {
        contact = { id: data.sender_id, name: data.sender_name, lastMsg: LOCK_TEXT };
        contacts.push(contact);
    }

    if (!isViewing) contact.unread = true;

    renderContacts();
    renderMessages();
});

socket.on("message_error", (data) => {
    alert("⚠️ " + data.message);
});

// ==========================================
// 5. RENDER BUBBLE (SINYAL NRZ-I)
// ==========================================
function renderMessages() {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = "";

    const activeMessages = messagesHistory.filter(
        m => (m.sender_id === myUserId && m.receiver_id === activeChatUserId) ||
             (m.sender_id === activeChatUserId && m.receiver_id === myUserId)
    );

    activeMessages.forEach((msg) => {
        const isSent = msg.sender_id === myUserId;
        const frames = buildFrames(msg.message || "");
        const extra = frames.length > MAX_FRAMES_MINI
            ? ` · ${MAX_FRAMES_MINI} frame pertama digambar`
            : "";

        const msgDiv = document.createElement("div");
        msgDiv.className = `message-item ${isSent ? "sent" : "received"}`;
        msgDiv.innerHTML = `
            <div class="message-bubble locked">
                <div class="lock-head">🔒 Pesan ter-encode · ${frames.length} frame · ${frames.length * FRAME_LEN} bit${extra}</div>
                <div class="signal-scroll mini"><canvas></canvas></div>
                <div class="signal-legend">
                    <span class="lg-s">S</span> Start ·
                    <span class="lg-d">DATA</span> 7 bit ·
                    <span class="lg-p">P</span> Parity even ·
                    <span class="lg-e">E</span> End
                </div>
            </div>
            <button class="sim-btn" type="button">🔑 Masukkan kunci ${isSent ? "kamu" : escapeHtml(msg.sender_name)} untuk melihat pesan</button>
            <span class="time">${escapeHtml(msg.time || '')}</span>
        `;

        drawSignal(msgDiv.querySelector("canvas"), frames);
        msgDiv.querySelector(".sim-btn").addEventListener("click", () => openMessage(msg));

        messagesContainer.appendChild(msgDiv);
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function openMessage(msg) {
    const isMine = msg.sender_id === myUserId;
    const who = isMine ? "akunmu" : `${msg.sender_name} (${msg.sender_id})`;

    const key = prompt(`🔑 Masukkan kunci ${who} untuk membuka pesan ini:`);
    if (key === null) return;

    pendingOpenText = msg.message;
    socket.emit("verify_key", { key, owner_id: msg.sender_id });
}

socket.on("key_response", (data) => {
    if (data.ok && pendingOpenText !== null) {
        const text = pendingOpenText;
        pendingOpenText = null;
        showMessageText(text);
    } else {
        pendingOpenText = null;
        alert("❌ " + (data.message || "Kunci salah, pesan tidak bisa dibuka."));
    }
});

// ==========================================
// 6. TAMPILKAN TEKS PESAN
// ==========================================
function showMessageText(text) {
    if (!simModal) return;
    const displayElem = document.getElementById("simCurrentTextDisplay");
    if (displayElem) displayElem.innerHTML = linkify(text);
    simModal.hidden = false;
    simModal.style.display = "flex";
}

closeSimBtn?.addEventListener("click", () => {
    if (simModal) {
        simModal.hidden = true;
        simModal.style.display = "none";
    }
});

// ==========================================
// 7. GAMBAR SINYAL NRZ-I
// ==========================================
function drawSignal(canvas, frames) {
    if (!canvas) return;

    const shown = frames.slice(0, MAX_FRAMES_MINI);
    const bits = shown.map(f => f.bits).join("");
    const levels = nrziEncode(bits);

    const bitW = 14;
    const LEFT = 10, RIGHT = 10, H = 100;
    const yTag = 13;
    const yHigh = 44, yLow = 86;
    const cssW = Math.ceil(LEFT + bits.length * bitW + RIGHT);

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW * dpr > 16000) dpr = 1;

    canvas.width = cssW * dpr;
    canvas.height = H * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = H + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, H);
    if (!bits) return;

    const fields = [
        { from: 0, len: 1, tag: "S",          color: "#d6aa5c", tint: "rgba(214,170,92,0.10)" },
        { from: 1, len: 7, tag: "DATA 7 bit", color: "#94a3b8", tint: null },
        { from: 8, len: 1, tag: "P",          color: "#9d8fd0", tint: "rgba(157,143,208,0.12)" },
        { from: 9, len: 1, tag: "E",          color: "#d6aa5c", tint: "rgba(214,170,92,0.10)" }
    ];

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    shown.forEach((f, fi) => {
        const fx = LEFT + fi * FRAME_LEN * bitW;

        fields.forEach(fd => {
            const x0 = fx + fd.from * bitW;
            const w = fd.len * bitW;

            if (fd.tint) {
                ctx.fillStyle = fd.tint;
                ctx.fillRect(x0, 0, w, H);
            }

            ctx.fillStyle = fd.color;
            ctx.font = "700 10px 'JetBrains Mono', monospace";
            ctx.fillText(fd.tag, x0 + w / 2, yTag);

            if (fd.from > 0) {
                ctx.strokeStyle = "rgba(255,255,255,0.14)";
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(x0, 0);
                ctx.lineTo(x0, H);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        });

        ctx.strokeStyle = "rgba(255,255,255,0.30)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fx, 0);
        ctx.lineTo(fx, H);
        ctx.stroke();
    });

    const xEnd = LEFT + bits.length * bitW;
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    ctx.beginPath();
    ctx.moveTo(xEnd, 0);
    ctx.lineTo(xEnd, H);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([4, 4]);
    [yHigh, yLow].forEach(y => {
        ctx.beginPath();
        ctx.moveTo(LEFT, y);
        ctx.lineTo(xEnd, y);
        ctx.stroke();
    });
    ctx.setLineDash([]);

    ctx.strokeStyle = "#6bb08f";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    let curY = yHigh;
    let x = LEFT;
    ctx.moveTo(x - 6, curY);
    ctx.lineTo(x, curY);

    for (let i = 0; i < levels.length; i++) {
        const ny = levels[i] === 1 ? yHigh : yLow;
        if (ny !== curY) {
            ctx.lineTo(x, ny);
            curY = ny;
        }
        x += bitW;
        ctx.lineTo(x, curY);
    }
    ctx.stroke();
}