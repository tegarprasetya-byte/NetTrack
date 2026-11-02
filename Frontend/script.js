// Konfigurasi Socket.IO
const socket = io();

// ==========================================
// KONSTANTA FRAME & SINYAL
// ==========================================
const START_BIT = "0";          // bit start (selalu 0)
const END_BIT = "1";            // bit end (selalu 1)
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
let pendingOpenMessage = null; // objek pesan yang menunggu verifikasi kunci
let onlineUserIds = new Set();

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

// Mengamankan teks dari karakter HTML berbahaya (mencegah XSS)
function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function linkify(text) {
    return escapeHtml(text);
}

// ==========================================
// 1. ENCODING TRANSMISI (TEKS -> BINER -> NRZ-I)
// ==========================================

// Frame per karakter: Start(0) + Data 7-bit + Even Parity + End(1)
function buildFrames(str) {
    return Array.from(str).map(ch => {
        const code = ch.charCodeAt(0) & 0x7F;
        const data = code.toString(2).padStart(7, "0");
        const ones = (data.match(/1/g) || []).length;
        const parity = ones % 2 === 0 ? "0" : "1";
        return { ch, code, data, parity, bits: START_BIT + data + parity + END_BIT };
    });
}

// String bit -> array level sinyal NRZ-I (1 = High, 0 = Low)
function nrziEncode(bits) {
    let level = 1; // level awal = High
    const levels = [];
    for (const b of bits) {
        if (b === "1") level = level === 1 ? 0 : 1; // toggle jika bit '1'
        levels.push(level);                        // tetap jika bit '0'
    }
    return levels;
}

// Teks biasa -> 1 string biner utuh (10 bit per karakter)
function textToCombinedBinaryString(str) {
    return buildFrames(str).map(f => f.bits).join("");
}

// ==========================================
// 2. VALIDASI & DECODING (NRZ-I -> BINER -> TEKS ASLI)
// ==========================================

// Cek string bit sebelum di-decode.
// Return null kalau valid, atau teks alasan kalau tidak valid.
function validateBitString(bits) {
    if (!bits) return "Data kosong.";
    if (!/^[01]+$/.test(bits)) return "Data mengandung karakter selain 0 dan 1.";
    if (bits.length % FRAME_LEN !== 0) {
        return `Jumlah bit (${bits.length}) bukan kelipatan ${FRAME_LEN}.`;
    }

    for (let i = 0; i < bits.length; i += FRAME_LEN) {
        const frame = bits.slice(i, i + FRAME_LEN);
        const no = i / FRAME_LEN + 1;

        if (frame[0] !== START_BIT) {
            return `Frame ke-${no}: bit start harus 0 (ditemukan ${frame[0]}).`;
        }
        if (frame[FRAME_LEN - 1] !== END_BIT) {
            return `Frame ke-${no}: bit end harus 1 (ditemukan ${frame[FRAME_LEN - 1]}).`;
        }

        // even parity: parity = 1 kalau jumlah bit '1' di 7 bit data ganjil
        const ones = (frame.slice(1, 8).match(/1/g) || []).length;
        if (String(ones % 2) !== frame[8]) {
            return `Frame ke-${no}: parity salah.`;
        }
    }
    return null;
}

// Decoder NRZ-I: array level sinyal -> teks asli. Throw Error kalau data tidak valid.
function nrziDecode(levels) {
    if (!levels || levels.length === 0) throw new Error("Data kosong.");

    // Step A: rekonstruksi sinyal NRZ-I jadi string bit
    let prevLevel = 1; // level referensi awal = 1
    let bitString = "";
    for (let i = 0; i < levels.length; i++) {
        if (levels[i] !== prevLevel) {
            bitString += "1"; // ada perubahan level -> bit '1'
            prevLevel = levels[i];
        } else {
            bitString += "0"; // level tetap -> bit '0'
        }
    }

    // Step B: validasi (kelipatan 10, start 0, end 1, parity)
    const err = validateBitString(bitString);
    if (err) throw new Error(err);

    // Step C: bongkar frame 10-bit, ambil 7 bit data jadi karakter ASCII
    const framesBits = bitString.match(new RegExp(`.{${FRAME_LEN}}`, "g"));
    return framesBits
        .map(bitStr => String.fromCharCode(parseInt(bitStr.slice(1, 8), 2)))
        .join("");
}

// ==========================================
// 3. LOGIKA SLIDING ANIMATED AUTH (LOGIN & REGISTER)
// ==========================================
const authContainer = document.getElementById('authContainer');
const toRegisterBtn = document.getElementById('toRegisterBtn');
const toLoginBtn = document.getElementById('toLoginBtn');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

toRegisterBtn?.addEventListener('click', () => authContainer?.classList.add("right-panel-active"));
toLoginBtn?.addEventListener('click', () => authContainer?.classList.remove("right-panel-active"));

// Submit form login
loginForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawEmail = document.getElementById('loginEmailInput').value.trim();
    const rawPassword = document.getElementById('loginPasswordInput').value;

    const email = textToCombinedBinaryString(rawEmail);
    const password = textToCombinedBinaryString(rawPassword);

    socket.emit("login_account", { email, password });
});

// Submit form register
registerForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const user_name = document.getElementById('regNameInput').value.trim();
    const user_id = document.getElementById('regUserIdInput').value.trim();
    const rawEmail = document.getElementById('regEmailInput').value.trim();
    const rawPassword = document.getElementById('regPasswordInput').value;
    const confirmEl = document.getElementById('regPasswordConfirmInput');
    const rawAccessKey = document.getElementById('regKeyInput').value;

    if (confirmEl && rawPassword !== confirmEl.value) {
        alert("⚠️ Password dan validasi ulang password tidak sama!");
        return;
    }

    const email = textToCombinedBinaryString(rawEmail);
    const password = textToCombinedBinaryString(rawPassword);
    const access_key = textToCombinedBinaryString(rawAccessKey);

    socket.emit("register_account", { user_id, user_name, email, password, access_key });
});

// Respon Auth dari Server
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

                    // Simpan stream biner dari DB & hitung sinyal NRZ-I-nya
                    const binaryStr = String(msg.message || "");
                    messagesHistory.push({
                        sender_id: msg.sender_id,
                        sender_name: msg.sender_name,
                        receiver_id: msg.receiver_id,
                        binaryMessage: binaryStr,
                        nrziSignal: nrziEncode(binaryStr),
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

            onlineUserIds.add(myUserId);

            socket.emit("register_online_user", myUserId);
            socket.emit("get_online_users");

            renderContacts();
            renderMessages();
            updateChatHeaderStatus();
        }
    }
});

// ==========================================
// STATUS ONLINE / OFFLINE REALTIME
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
// 4. KONTAK
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
// 5. KIRIM & TERIMA PESAN
// ==========================================
function sendPlainText(plainText) {
    if (!activeChatUserId) { alert("Pilih kontak penerima terlebih dahulu!"); return false; }
    if (!/^[\x00-\x7F]+$/.test(plainText)) {
        alert("Pesan hanya boleh berisi karakter ASCII (tanpa emoji atau huruf spesial).");
        return false;
    }

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const binaryStr = textToCombinedBinaryString(plainText); // teks -> biner
    const nrziSignal = nrziEncode(binaryStr);                // biner -> sinyal NRZ-I

    const msgData = {
        sender_id: myUserId,
        sender_name: myUserName,
        receiver_id: activeChatUserId,
        message: binaryStr, // dikirim sebagai biner ke server/DB
        time: timeNow
    };

    messagesHistory.push({
        sender_id: myUserId,
        sender_name: myUserName,
        receiver_id: activeChatUserId,
        binaryMessage: binaryStr,
        nrziSignal: nrziSignal,
        time: timeNow
    });

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

// Menerima pesan realtime dari server
socket.on("receive_message", (data) => {
    if (data.sender_id === myUserId || data.receiver_id !== myUserId) return;

    const binaryStr = String(data.message || "");

    messagesHistory.push({
        sender_id: data.sender_id,
        sender_name: data.sender_name,
        receiver_id: data.receiver_id,
        binaryMessage: binaryStr,
        nrziSignal: nrziEncode(binaryStr),
        time: data.time || ''
    });

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
// 6. RENDER BUBBLE CHAT & CANVAS SINYAL
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
        const bitLen = (msg.binaryMessage || "").length;
        const totalFrames = Math.floor(bitLen / FRAME_LEN);
        const extra = totalFrames > MAX_FRAMES_MINI
            ? ` · ${MAX_FRAMES_MINI} frame pertama digambar`
            : "";

        const msgDiv = document.createElement("div");
        msgDiv.className = `message-item ${isSent ? "sent" : "received"}`;
        msgDiv.innerHTML = `
            <div class="message-bubble locked">
                <div class="lock-head">🔒 Pesan ter-encode · ${totalFrames} frame · ${bitLen} bit${extra}</div>
                <div class="signal-scroll mini"><canvas></canvas></div>
            </div>
            <button class="sim-btn" type="button">🔑 Masukkan kunci untuk melihat pesan</button>
            <span class="time">${escapeHtml(msg.time || '')}</span>
        `;

        drawSignalFromLevels(msgDiv.querySelector("canvas"), msg.nrziSignal, msg.binaryMessage);
        msgDiv.querySelector(".sim-btn").addEventListener("click", () => openMessage(msg));

        messagesContainer.appendChild(msgDiv);
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Buka pesan menggunakan kunci
function openMessage(msg) {
    const rawKey = prompt("🔑 Masukkan kunci kamu untuk membuka pesan ini:");
    if (rawKey === null) return;

    const keyBin = textToCombinedBinaryString(rawKey); // kunci di-encode ke biner

    pendingOpenMessage = msg;
    socket.emit("verify_key", { key: keyBin, owner_id: myUserId });
}

// Handler respon kunci dari server
socket.on("key_response", (data) => {
    if (data.ok && pendingOpenMessage !== null) {
        const msg = pendingOpenMessage;
        pendingOpenMessage = null;

        // Validasi data asli dari DB dulu (kelipatan 10, start 0, end 1, parity)
        const err = validateBitString(msg.binaryMessage);
        if (err) {
            alert("⚠️ Pesan tidak valid: " + err);
            return;
        }

        // Decode NRZ-I -> teks asli
        try {
            showMessageText(nrziDecode(msg.nrziSignal));
        } catch (e) {
            alert("⚠️ Pesan tidak valid: " + e.message);
        }
    } else {
        pendingOpenMessage = null;
        alert("❌ " + (data.message || "Kunci salah, pesan tidak bisa dibuka."));
    }
});

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
// 7. RENDERING CANVAS NRZ-I DARI LEVEL
// ==========================================
function drawSignalFromLevels(canvas, levels, bits) {
    if (!canvas || !levels || levels.length === 0) return;

    const bitW = 14;
    const LEFT = 10, RIGHT = 10, H = 100;
    const yHigh = 44, yLow = 86;
    const drawLen = Math.min(levels.length, MAX_FRAMES_MINI * FRAME_LEN);
    const cssW = Math.ceil(LEFT + drawLen * bitW + RIGHT);

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW * dpr > 16000) dpr = 1;

    canvas.width = cssW * dpr;
    canvas.height = H * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = H + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, H);

    const totalFrames = Math.min(Math.floor(levels.length / FRAME_LEN), MAX_FRAMES_MINI);

    // Garis pembatas frame
    for (let fi = 0; fi < totalFrames; fi++) {
        const fx = LEFT + fi * FRAME_LEN * bitW;
        ctx.strokeStyle = "rgba(255,255,255,0.30)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fx, 0);
        ctx.lineTo(fx, H);
        ctx.stroke();
    }

    const xEnd = LEFT + drawLen * bitW;
    ctx.strokeStyle = "rgba(255,255,255,0.30)";
    ctx.beginPath();
    ctx.moveTo(xEnd, 0);
    ctx.lineTo(xEnd, H);
    ctx.stroke();

    // Garis bantu level High/Low
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.setLineDash([4, 4]);
    [yHigh, yLow].forEach(y => {
        ctx.beginPath();
        ctx.moveTo(LEFT, y);
        ctx.lineTo(xEnd, y);
        ctx.stroke();
    });
    ctx.setLineDash([]);

    // Garis sinyal NRZ-I (hijau)
    ctx.strokeStyle = "#6bb08f";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();

    let curY = yHigh;
    let x = LEFT;
    ctx.moveTo(x - 6, curY);
    ctx.lineTo(x, curY);

    const limitLevels = levels.slice(0, drawLen);
    for (let i = 0; i < limitLevels.length; i++) {
        const ny = limitLevels[i] === 1 ? yHigh : yLow;
        if (ny !== curY) {
            ctx.lineTo(x, ny); // transisi vertikal
            curY = ny;
        }
        x += bitW;
        ctx.lineTo(x, curY);   // garis horizontal 1 bit
    }
    ctx.stroke();
}