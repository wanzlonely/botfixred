import { Telegraf, Markup } from 'telegraf';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
import P from "pino";
import fs from 'fs';
import nodemailer from 'nodemailer';
import axios from 'axios';
import path from 'path';
import XLSX from 'xlsx';

const CONFIG = {
    botToken: '8250992727:AAG2XlCefa-XZPLw9KlaexgnPI0bx-nZ6uE',
    ownerId: '7732520601',
    groupLink: 'https://t.me/stockwalzy',
    groupId: '-1003325663954',
    botImage: 'https://files.catbox.moe/kjfe0d.jpg',
    dbPath: './database',
    trialDuration: 86400000, 
    batchSize: 10,
    delayPerBatch: 3000,
    maxEmails: 10,
    maxCountPerEmail: 15, 
    maxSessions: 5,
    UPSTASH_REDIS_REST_URL: "https://rare-muskrat-25165.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "AWJNAAIncDIxMDc4MWQ4ZTk2MGI0ODhjYmI3MjUzZGI3NThiZGMyYXAyMjUxNjU"
};

const APPEAL_TEXTS = {
    spam: [
        "Subjek: Peninjauan Sistem - Kesalahan Deteksi\n\nHalo Tim WhatsApp,\n\nNomor saya {nomor} telah diblokir karena dianggap melakukan spam. Saya yakin ini adalah kesalahan sistem. Mohon tinjau riwayat chat dan pulihkan akun saya.",
        "Subjek: Keamanan Akun\n\nHalo,\n\nSaya tidak bisa login ke nomor {nomor}. Saya curiga akun saya diretas. Mohon bantu saya mengamankan dan memulihkan nomor ini."
    ],
    permanen: [
        "Subjek: Permohonan Maaf & Pemulihan Akun\n\nKepada Tim WhatsApp,\n\nSaya menyadari nomor {nomor} telah diblokir permanen. Saya memohon maaf jika ada pelanggaran yang tidak disengaja. Saya berjanji akan mematuhi aturan kedepannya.",
        "Subjek: Banding Pemblokiran\n\nYth Admin,\n\nMohon kebijaksanaannya untuk meninjau kembali nomor {nomor}. Pemblokiran ini sangat merugikan aktivitas harian saya."
    ]
};

class Database {
    constructor() {
        if (!fs.existsSync(CONFIG.dbPath)) fs.mkdirSync(CONFIG.dbPath, { recursive: true });
        this.paths = {
            users: path.join(CONFIG.dbPath, 'users.json'),
            emails: path.join(CONFIG.dbPath, 'emails.json'),
            admins: path.join(CONFIG.dbPath, 'admins.json'),
            templates: path.join(CONFIG.dbPath, 'templates.json'),
            stats: path.join(CONFIG.dbPath, 'stats.json')
        };
        this.init();
    }

    init() {
        const defaults = {
            users: {},
            emails: [], 
            admins: [String(CONFIG.ownerId)],
            templates: { 
                fixred: { subject: "Masalah Login", body: "Halo Tim WhatsApp, nomor saya {nomor} mengalami masalah 'Hubungi Kami'. Mohon diperbaiki." } 
            },
            stats: { checked: 0, fixed: 0 }
        };
        for (const [key, p] of Object.entries(this.paths)) {
            if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(defaults[key], null, 2));
        }
    }

    get(key) { try { return JSON.parse(fs.readFileSync(this.paths[key], 'utf8')); } catch { return null; } }
    set(key, data) { fs.writeFileSync(this.paths[key], JSON.stringify(data, null, 2)); }

    get users() { return this.get('users') || {}; }
    get templates() { return this.get('templates'); }
    set templates(v) { this.set('templates', v); }
    get stats() { return this.get('stats') || { checked: 0, fixed: 0 }; }
    get emails() { return this.get('emails') || []; }
    set emails(v) { this.set('emails', v); }


    updateUser(id, data) {
        const u = this.users;
        const uid = String(id);
        
        let defaultExpired = 0;
        if (uid === CONFIG.ownerId) defaultExpired = 9999999999999; 

        if (!u[uid]) {
            u[uid] = { 
                id: uid, username: 'User', joined: Date.now(), 
                expired: defaultExpired, sessions: []
            };
        }
        
        if (uid === CONFIG.ownerId) data.expired = 9999999999999;

        u[uid] = { ...u[uid], ...data };
        this.set('users', u);
        return u[uid];
    }
    
    addEmail(email, pass) {
        let ePool = this.emails;
        if (ePool.length >= CONFIG.maxEmails) return "LIMIT_REACHED";
        if (ePool.find(e => e.email === email)) return "EXISTS";
        
        ePool.push({ email, pass, count: 0, added: Date.now() });
        this.emails = ePool;
        return "SUCCESS";
    }

    removeEmail(index) {
        let ePool = this.emails;
        if (ePool.length <= index) return false;
        ePool.splice(index, 1);
        this.emails = ePool;
        return true;
    }

    updateStats(key, val) { const s = this.stats; s[key] += val; this.set('stats', s); }
}

const db = new Database();
const bot = new Telegraf(CONFIG.botToken, { handlerTimeout: 9000000 });
const userSessions = new Map();
const sessionStatus = new Map(); 
const userStates = new Map();
const tempStorage = new Map();

// --- SISTEM ANTRIAN GLOBAL UNTUK CEK BIO ---
const checkQueue = [];
let isProcessingCheck = false;

async function runNextCheck() {
    if (isProcessingCheck || checkQueue.length === 0) return;

    isProcessingCheck = true;
    const { ctx, nums, uid } = checkQueue.shift();
    const role = (uid === CONFIG.ownerId) ? 'owner' : 'user';
    const mainKb = role === 'owner' ? MENUS.owner : MENUS.user;
    
    // Beri notifikasi ke user bahwa antriannya sedang diproses
    try {
        await ctx.reply(`⏳ Permintaan Cek Bio Anda (Total: ${nums.length} nomor) sedang diproses. Mohon tunggu hingga laporan dikirim.`);
    } catch (e) {
        console.error('Gagal mengirim notif proses antrian:', e.message);
    }
    
    try {
        await processBatchCheck(ctx, nums, uid);
        await ctx.reply('✅ Cek Bio Selesai! Laporan telah dikirim.', { reply_markup: mainKb });
    } catch (error) {
        await ctx.reply(`❌ Antrian Cek Bio gagal: ${error.message}`, { reply_markup: mainKb });
    } finally {
        isProcessingCheck = false;
        runNextCheck(); // Panggil lagi untuk memproses antrian berikutnya
    }
}
// ----------------------------------------

const MENUS = {
    owner: {
        keyboard: [
            [{ text: '🛠️ Perbaiki WA' }, { text: '🔍 Cek Nomor' }],
            [{ text: '⚙️ Pengaturan' }, { text: '👤 Profil Saya' }],
            [{ text: '👑 Panel Owner' }, { text: '📂 Konversi File' }],
            [{ text: '❓ Bantuan' }]
        ],
        resize_keyboard: true
    },
    user: {
        keyboard: [
            [{ text: '🛠️ Perbaiki WA' }, { text: '🔍 Cek Nomor' }],
            [{ text: '⚙️ Pengaturan' }, { text: '👤 Profil Saya' }],
            [{ text: '📂 Konversi File' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true
    },
    settings: {
        keyboard: [
            [{ text: '📧 Tambah Email Pool' }, { text: '📋 Lihat Email Pool' }],
            [{ text: '🗑️ Hapus Email Pool' }],
            [{ text: '📱 Tambah WA' }, { text: '📋 List WA' }, { text: '❌ Hapus WA' }],
            [{ text: '🔙 Kembali' }]
        ],
        resize_keyboard: true
    },
    ownerPanel: {
        keyboard: [
            [{ text: '➕ Tambah Durasi' }, { text: '📝 Set Template' }],
            [{ text: '👥 Daftar User' }, { text: '📢 Broadcast' }],
            [{ text: '🔙 Kembali' }]
        ],
        resize_keyboard: true
    },
    fixMenu: {
        keyboard: [
            [{ text: '🔧 Fix Masalah Login' }, { text: '🔓 Banding (Spam/Perm)' }],
            [{ text: '🔙 Kembali' }]
        ],
        resize_keyboard: true
    },
    unbanType: {
        keyboard: [
            [{ text: '🚫 Banding Spam' }, { text: '⛔ Banding Permanen' }],
            [{ text: '🔙 Kembali' }]
        ],
        resize_keyboard: true
    },
    cancel: {
        keyboard: [[{ text: '🔙 Kembali' }]],
        resize_keyboard: true
    },
    verify: {
        inline_keyboard: [
            [{ text: '🚀 JOIN GRUP RESMI', url: CONFIG.groupLink }],
            [{ text: '🔄 SAYA SUDAH JOIN', callback_data: 'verify_join' }]
        ]
    }
};

const Validator = {
    email: (text) => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(text.trim()),
    appPass: (text) => text.replace(/\s/g,'').length === 16,
    number: (text) => /^\d{10,15}$/.test(text.replace(/\D/g, '')),
    days: (text) => /^\d+$/.test(text.trim()) && parseInt(text) > 0
};

function formatTimeLeft(expiredTime) {
    if (expiredTime > 9000000000000) return "♾️ UNLIMITED (Owner)";
    const diff = expiredTime - Date.now();
    if (diff <= 0) return "🔴 EXPIRED";
    const d = Math.floor(diff / (1000 * 60 * 60 * 24));
    return `${d} Hari Lagi`;
}

function formatDate(ms) { 
    if(!ms) return "Invalid";
    if (ms > 9000000000000) return "Unlimited";
    return new Date(ms).toLocaleDateString('id-ID'); 
}

function formatTimestamp(timestamp) {
    if (!timestamp || timestamp === 0) return 'Tidak Diketahui/Default';
    const ms = String(timestamp).length === 10 ? timestamp * 1000 : timestamp;
    return new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); 
}

function maskEmail(email) {
    const parts = email.split('@');
    if (parts.length !== 2) return 'xxxx';
    const [local, domain] = parts;
    const maskedLocal = local.substring(0, 2) + 'x'.repeat(local.length - 2);
    return maskedLocal + '@' + domain;
}

const FileHandler = {
    async process(buffer, fileName) {
        const ext = fileName.toLowerCase().split('.').pop();
        if (ext === 'txt') return buffer.toString('utf8').split(/[\r\n]+/).filter(n => n.trim().length > 5);
        if (ext === 'xlsx') {
            const wb = XLSX.read(buffer, { type: 'buffer' });
            const nums = [];
            wb.SheetNames.forEach(n => {
                const d = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 });
                d.flat().forEach(v => {
                    if (typeof v === 'number' || (typeof v === 'string' && v.trim().length > 5)) nums.push(String(v).replace(/\D/g, ''));
                });
            });
            return nums.filter(n => n.length > 5);
        }
        return [];
    }
};

const WAManager = {
    async startSession(userId, sessionId) {
        const uid = String(userId);
        const sessionKey = `${uid}_${sessionId}`;
        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${sessionId}`);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })) },
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: true
        });

        if (!userSessions.has(uid)) userSessions.set(uid, new Map());
        userSessions.get(uid).set(sessionId, sock);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === "open") {
                const lastStatus = sessionStatus.get(sessionKey);
                if (lastStatus !== 'open') { 
                    sessionStatus.set(sessionKey, 'open');
                    try { 
                        await bot.telegram.sendMessage(uid, `✅ <b>WhatsApp Terhubung!</b>\nSesi ${sessionId} siap digunakan.`, {parse_mode:'HTML'}); 
                    } catch {}
                }
            } else if (connection === "close") {
                sessionStatus.set(sessionKey, 'close');
                if (userSessions.has(uid)) userSessions.get(uid).delete(sessionId);
                
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut && code !== 401) {
                    this.startSession(userId, sessionId);
                } else {
                    const u = db.users[uid];
                    if (u.sessions) {
                        u.sessions = u.sessions.filter(s => s !== sessionId);
                        db.updateUser(uid, { sessions: u.sessions });
                    }
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);
        return sock;
    },

    async requestPairing(userId, phoneNumber) {
        const uid = String(userId);
        const u = db.users[uid];
        
        let newSessionId = 1;
        if (u.sessions && u.sessions.length > 0) {
            for (let i = 1; i <= CONFIG.maxSessions; i++) {
                if (!u.sessions.includes(i)) { newSessionId = i; break; }
            }
            if (u.sessions.length >= CONFIG.maxSessions) throw new Error("Max 5 Koneksi!");
        }

        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${newSessionId}`);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

        const sock = await this.startSession(userId, newSessionId);
        await delay(5000); 

        try {
            const num = phoneNumber.replace(/\D/g, '');
            const code = await sock.requestPairingCode(num);
            let currentSessions = u.sessions || [];
            if (!currentSessions.includes(newSessionId)) {
                currentSessions.push(newSessionId);
                db.updateUser(uid, { sessions: currentSessions });
            }
            return code;
        } catch (e) {
            throw new Error("Gagal meminta kode. Pastikan nomor benar.");
        }
    },

    async deleteSession(userId, sessionId) {
        const uid = String(userId);
        const u = db.users[uid];
        if (userSessions.has(uid)) {
            const sock = userSessions.get(uid).get(sessionId);
            if (sock) sock.end();
            userSessions.get(uid).delete(sessionId);
        }
        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${sessionId}`);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        
        if (u.sessions) {
            u.sessions = u.sessions.filter(s => s !== sessionId);
            db.updateUser(uid, { sessions: u.sessions });
        }
    },

    async loadAll() {
        const users = db.users;
        for (const [uid, u] of Object.entries(users)) {
            if (u.sessions && u.sessions.length > 0) {
                for (const sessionId of u.sessions) {
                    await this.startSession(uid, sessionId);
                    await delay(1000);
                }
            }
        }
    }
};

const EmailEngine = {
    async send(subject, bodyText) {
        let ePool = db.emails;
        if (ePool.length === 0) throw new Error("Email Pool kosong. Hubungi Owner.");

        let availableIndex = ePool.findIndex(e => e.count < CONFIG.maxCountPerEmail);
        
        if (availableIndex === -1) {
            ePool = ePool.map(e => ({ ...e, count: 0 }));
            db.emails = ePool; 
            availableIndex = 0; 
        }

        const emailData = ePool[availableIndex];

        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com', port: 465, secure: true,
            auth: { user: emailData.email, pass: emailData.pass },
            tls: { rejectUnauthorized: false }
        });

        try {
            await transporter.sendMail({ from: emailData.email, to: 'support@support.whatsapp.com', subject: subject, text: bodyText });
            
            ePool[availableIndex].count += 1;
            db.emails = ePool; 
            
            return maskEmail(emailData.email); 
        } catch (error) {
            if (error.responseCode === 535) {
                throw new Error(`Login Gagal: ${maskEmail(emailData.email)} - App Password Salah!`);
            }
            throw error;
        }
    }
};

async function isGroupMember(ctx, uid) {
    if (CONFIG.groupId === '0') return true;
    if (uid === CONFIG.ownerId) return true;
    try {
        const member = await ctx.telegram.getChatMember(CONFIG.groupId, uid);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) { return false; }
}

const checkAuth = async (ctx, enforceGroup = true) => {
    const uid = String(ctx.from.id);
    let user = db.users[uid];
    
    const currentName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'User');
    if (!user) {
        user = { id: uid, username: currentName, joined: Date.now(), expired: 0 };
        if(uid === CONFIG.ownerId) user.expired = 9999999999999;
        db.updateUser(uid, user);
    } else if (user.username !== currentName) {
        db.updateUser(uid, { username: currentName });
    }

    const isOwner = uid === CONFIG.ownerId;
    const role = isOwner ? 'owner' : 'user';

    if (role === 'user' && enforceGroup) {
        const isMember = await isGroupMember(ctx, uid);
        if (!isMember) {
            await ctx.replyWithPhoto(CONFIG.botImage, {
                caption: `🔒 <b>VERIFIKASI DIBUTUHKAN</b>\n\nAnda wajib bergabung ke grup resmi untuk menggunakan bot ini.\n\n👇 <i>Silakan klik tombol di bawah setelah join:</i>`,
                parse_mode: 'HTML',
                reply_markup: MENUS.verify
            });
            return false;
        }
        if (Date.now() > user.expired) {
            await ctx.reply(`⏳ <b>MASA AKTIF HABIS</b>\nID: <code>${uid}</code>\nHubungi Owner.`, {parse_mode:'HTML'});
            return false;
        }
    }
    return role;
};

bot.command('start', async (ctx) => {
    const role = await checkAuth(ctx, true);
    if (!role) return;
    const uid = String(ctx.from.id);
    userStates.delete(uid);
    await showDashboard(ctx, uid, role);
});

bot.action('verify_join', async (ctx) => {
    const uid = String(ctx.from.id);
    const isMember = await isGroupMember(ctx, uid);
    if (isMember) {
        await ctx.deleteMessage();
        await ctx.reply('✅ <b>Verifikasi Berhasil!</b>', {parse_mode:'HTML'});
        const role = (uid === CONFIG.ownerId) ? 'owner' : 'user';
        await showDashboard(ctx, uid, role);
    } else {
        await ctx.answerCbQuery('❌ Masih belum join!', { show_alert: true });
    }
});

async function showDashboard(ctx, uid, role) {
    const u = db.users[uid] || {};
    const daysLeft = formatTimeLeft(u.expired);
    const waCount = u.sessions ? u.sessions.length : 0;
    const emailCount = db.emails ? db.emails.length : 0;

    const caption = 
`<b>◎ 𝗪𝗔𝗟𝗭𝗬 𝗖𝗢𝗡𝗧𝗥𝗢𝗟 𝗖𝗘𝗡𝗧𝗘𝗥 ⁷⁶</b>
──────────────────────
👋 Halo, <b>${u.username || 'User'}</b>
Here is your realtime status.

╭── 📡 <b>System Status</b>
│ 📱 <b>WhatsApp:</b> ${waCount}/5 Terhubung
│ 📧 <b>Email Pool:</b> ${emailCount}/${CONFIG.maxEmails} Ready
╰─────────────────
╭── 👤 <b>Account Info</b>
│ 🆔 <code>${uid}</code>
│ ⏳ <b>${daysLeft}</b>
╰─────────────────

👇 <b>Select Operation Module</b>`;

    await ctx.replyWithPhoto(CONFIG.botImage, {
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: role === 'owner' ? MENUS.owner : MENUS.user
    });
}

bot.on('text', async (ctx) => {
    const uid = String(ctx.from.id);
    const text = ctx.message.text;
    const state = userStates.get(uid);
    const role = await checkAuth(ctx, true);
    if (!role) return;

    const mainKb = (role === 'owner') ? MENUS.owner : MENUS.user;
    const isOwner = uid === CONFIG.ownerId;

    if (text === '🔙 Kembali' || text === '🔙 Cancel') {
        userStates.delete(uid);
        if (text === '🔙 Kembali') return showDashboard(ctx, uid, role);
        return ctx.reply('Aksi dibatalkan.', { reply_markup: isOwner ? MENUS.owner : MENUS.user });
    }

    if (state) {
        try {
            if (isOwner && state === 'SETUP_EMAIL_ADDR') {
                if (!Validator.email(text)) {
                    ctx.reply('❌ <b>FORMAT SALAH!</b>\nHarus <code>@gmail.com</code>', {parse_mode:'HTML', reply_markup: MENUS.cancel});
                } else {
                    tempStorage.set(uid, { email: text.trim() });
                    userStates.set(uid, 'SETUP_EMAIL_PASS');
                    ctx.reply('🔑 <b>LANGKAH 2/2:</b>\nSalin App Password Google Anda (16 digit).', {parse_mode:'HTML', reply_markup: MENUS.cancel});
                }
            }
            else if (isOwner && state === 'SETUP_EMAIL_PASS') {
                const pass = text.replace(/\s+/g, '');
                if (!Validator.appPass(pass)) {
                    ctx.reply('❌ <b>PASSWORD SALAH!</b>\nHarus 16 karakter.', {parse_mode:'HTML', reply_markup: MENUS.cancel});
                } else {
                    const email = tempStorage.get(uid).email;
                    const res = db.addEmail(email, pass);
                    if(res === 'SUCCESS') ctx.reply(`✅ Email <code>${maskEmail(email)}</code> ditambahkan ke Pool.`, {parse_mode:'HTML', reply_markup: MENUS.settings});
                    else if(res === 'LIMIT_REACHED') ctx.reply(`❌ Slot Pool Penuh (Max ${CONFIG.maxEmails}).`, {reply_markup: MENUS.settings});
                    else ctx.reply('❌ Email sudah ada di Pool.', {reply_markup: MENUS.settings});
                    userStates.delete(uid);
                }
            }
            else if (isOwner && state === 'DEL_EMAIL_INDEX') {
                const idx = parseInt(text) - 1;
                const res = db.removeEmail(idx);
                if(res) ctx.reply('✅ Email Pool dihapus.', {reply_markup: MENUS.settings});
                else ctx.reply('❌ Nomor urut salah.', {reply_markup: MENUS.settings});
                userStates.delete(uid);
            }
            else if (state === 'DEL_WA_INDEX') {
                const sessId = parseInt(text);
                await WAManager.deleteSession(uid, sessId);
                ctx.reply(`✅ Sesi ${sessId} dihapus.`, {reply_markup: MENUS.settings});
                userStates.delete(uid);
            }
            else if (state === 'ADD_WA_NUM') {
                const num = text.replace(/\D/g, '');
                if (!Validator.number(num)) {
                    ctx.reply('❌ Nomor salah. Contoh: 628xxx', {reply_markup: MENUS.cancel});
                } else {
                    ctx.reply('⏳ Meminta Kode Pairing... (Tunggu 5 detik)', {parse_mode:'HTML'});
                    try {
                        const code = await WAManager.requestPairing(uid, num);
                        ctx.reply(`🔐 <b>KODE PAIRING:</b>\n<code>${code}</code>\n\nMasukkan di WhatsApp.`, {parse_mode:'HTML', reply_markup: MENUS.settings});
                    } catch(e) { ctx.reply(`❌ Gagal: ${e.message}`, {reply_markup: MENUS.settings}); }
                    userStates.delete(uid);
                }
            }
            else if (state === 'FIX_RED_INPUT' || state === 'UNBAN_INPUT') {
                const num = text.replace(/\D/g, '');
                if (!Validator.number(num)) return ctx.reply('❌ Nomor Salah.', {reply_markup: MENUS.cancel});
                
                let subject, body;
                if(state === 'FIX_RED_INPUT') {
                    const t = db.templates.fixred || {};
                    subject = t.subject || "Help"; body = (t.body || "{nomor}").replace('{nomor}', num);
                } else {
                    const type = tempStorage.get(uid).type;
                    const t = APPEAL_TEXTS[type][0];
                    const [s, ...b] = t.split('\n\n');
                    subject = s.replace('Subjek: ', ''); body = b.join('\n\n').replace('{nomor}', num);
                }
                
                await sendAutoEmail(ctx, uid, num, subject, body);
            }
            else if (isOwner && state === 'ADD_TIME_ID') {
                tempStorage.set(uid, { target: text.trim() });
                userStates.set(uid, 'ADD_TIME_DAYS');
                ctx.reply('📅 Masukkan jumlah hari:', {reply_markup: MENUS.cancel});
            }
            else if (isOwner && state === 'ADD_TIME_DAYS') {
                if (!Validator.days(text)) {
                    ctx.reply('❌ Harus Angka.', {reply_markup: MENUS.cancel});
                } else {
                    const target = tempStorage.get(uid).target;
                    const days = parseInt(text);
                    const tUser = db.updateUser(target, {});
                    const newExp = tUser.expired > Date.now() ? tUser.expired + (days*86400000) : Date.now() + (days*86400000);
                    db.updateUser(target, { expired: newExp });
                    ctx.reply(`✅ Sukses tambah ${days} hari.`, {reply_markup: MENUS.ownerPanel});
                    userStates.delete(uid);
                }
            }
            else if (isOwner && state === 'SET_FIXRED_SUBJ') {
                tempStorage.set(uid, { subj: text });
                userStates.set(uid, 'SET_FIXRED_BODY');
                ctx.reply('📝 Kirim Isi Pesan:', {reply_markup: MENUS.cancel});
            }
            else if (isOwner && state === 'SET_FIXRED_BODY') {
                const subj = tempStorage.get(uid).subj;
                const t = db.templates || {};
                t.fixred = { subject: subj, body: text };
                db.templates = t;
                ctx.reply('✅ Template Update.', {reply_markup: MENUS.ownerPanel});
                userStates.delete(uid);
            }
            else if (isOwner && state === 'BROADCAST_MSG') {
                const users = Object.keys(db.users);
                ctx.reply(`⏳ Mengirim ke ${users.length} user...`);
                for (const u of users) { try { await bot.telegram.copyMessage(u, ctx.chat.id, ctx.message.message_id); await delay(100); } catch {} }
                ctx.reply('✅ Broadcast Selesai.', {reply_markup: MENUS.ownerPanel});
                userStates.delete(uid);
            }
            else if (state === 'CHECK_BIO') {
                const nums = text.split(/[\s,\n]+/).filter(n=>n.length>5);
                const socks = userSessions.get(uid);
                if(!socks || socks.size === 0) return ctx.reply('❌ Belum ada WA terkoneksi.', {reply_markup: MENUS.user});
                
                // --- QUEUE LOGIC START ---
                checkQueue.push({ ctx, nums, uid });
                userStates.delete(uid); 
                
                if (isProcessingCheck) {
                    return ctx.reply(`⏳ Permintaan Cek Bio Anda masuk antrian ke-${checkQueue.length}. Harap tunggu.`);
                }
                
                runNextCheck(); // Panggil fungsi pemrosesan antrian
                return; 
                // --- QUEUE LOGIC END ---
            }

        } catch (error) {
            ctx.reply(`❌ Error: ${error.message}`, {reply_markup: mainKb});
            userStates.delete(uid);
        }
        return;
    }

    switch (text) {
        case '👑 Panel Owner':
            if (role !== 'owner') return;
            ctx.reply('<b>👑 MENU OWNER</b>', {parse_mode:'HTML', reply_markup: MENUS.ownerPanel});
            break;
        case '👥 Daftar User':
            if (role !== 'owner') return;
            const uList = Object.values(db.users).map((u,i) => {
                const exp = u.expired > 9000000000000 ? 'Unlimited' : (u.expired > Date.now() ? formatDate(u.expired) : 'Expired');
                return `${i+1}. 🆔 ${u.id} 👤 ${u.username} (${exp})`;
            }).join('\n');
            ctx.reply(`👥 <b>LIST USER:</b>\n\n${uList}`, {parse_mode:'HTML'});
            break;
        case '➕ Tambah Durasi':
            if (role !== 'owner') return;
            userStates.set(uid, 'ADD_TIME_ID');
            ctx.reply('🆔 Kirim ID User:', {reply_markup: MENUS.cancel});
            break;
        case '📝 Set Template':
            if (role !== 'owner') return;
            userStates.set(uid, 'SET_FIXRED_SUBJ');
            ctx.reply('📝 Kirim Judul:', {reply_markup: MENUS.cancel});
            break;
        case '📢 Broadcast':
            if (role !== 'owner') return;
            userStates.set(uid, 'BROADCAST_MSG');
            ctx.reply('📢 Kirim pesan:', {reply_markup: MENUS.cancel});
            break;

        case '⚙️ Pengaturan':
            ctx.reply('⚙️ <b>PENGATURAN</b>', {parse_mode:'HTML', reply_markup: MENUS.settings});
            break;
        
        case '📧 Tambah Email Pool':
            if (role !== 'owner') return;
            userStates.set(uid, 'SETUP_EMAIL_ADDR');
            ctx.reply('📧 Masukkan Gmail Anda:', {reply_markup: MENUS.cancel});
            break;
        case '📋 Lihat Email Pool':
            if (role !== 'owner') return;
            const emails = db.emails || [];
            if(emails.length === 0) return ctx.reply('⚠️ Email Pool kosong.', {reply_markup: MENUS.settings});
            const eMsg = emails.map((e,i) => 
                `${i+1}. <code>${maskEmail(e.email)}</code> (${e.count}/${CONFIG.maxCountPerEmail})`
            ).join('\n');
            ctx.reply(`📧 <b>EMAIL POOL (${emails.length}/${CONFIG.maxEmails}):</b>\n\n${eMsg}`, {parse_mode:'HTML'});
            break;
        case '🗑️ Hapus Email Pool':
            if (role !== 'owner') return;
            const ems = db.emails || [];
            if(ems.length === 0) return ctx.reply('⚠️ Email Pool kosong.', {reply_markup: MENUS.settings});
            const delMsg = ems.map((e,i) => `${i+1}. ${maskEmail(e.email)}`).join('\n');
            userStates.set(uid, 'DEL_EMAIL_INDEX');
            ctx.reply(`🗑️ <b>KIRIM NOMOR URUT YG DIHAPUS:</b>\n\n${delMsg}`, {parse_mode:'HTML', reply_markup: MENUS.cancel});
            break;
            
        case '📱 Tambah WA':
            userStates.set(uid, 'ADD_WA_NUM');
            ctx.reply('📱 Masukkan Nomor HP (628xxx):', {reply_markup: MENUS.cancel});
            break;
        case '📋 List WA':
            const sess = db.users[uid].sessions || [];
            if(sess.length === 0) return ctx.reply('⚠️ Belum ada WA.', {reply_markup: MENUS.settings});
            const wMsg = sess.map(s => `Sesi ${s}: Aktif`).join('\n');
            ctx.reply(`📱 <b>KONEKSI WA (${sess.length}/5):</b>\n\n${wMsg}`, {parse_mode:'HTML'});
            break;
        case '❌ Hapus WA':
            const sDel = db.users[uid].sessions || [];
            if(sDel.length === 0) return ctx.reply('⚠️ Kosong.', {reply_markup: MENUS.settings});
            userStates.set(uid, 'DEL_WA_INDEX');
            ctx.reply(`❌ Kirim Angka Sesi (Contoh: 1) untuk dihapus:`, {reply_markup: MENUS.cancel});
            break;

        case '🛠️ Perbaiki WA':
            if (db.emails.length === 0) return ctx.reply('⚠️ Email Pool kosong. Hubungi Owner untuk menambahkan email.', {reply_markup: mainKb});
            ctx.reply('🔧 <b>Pilih Masalah:</b>', {parse_mode:'HTML', reply_markup: MENUS.fixMenu});
            break;
        case '🔧 Fix Masalah Login':
            userStates.set(uid, 'FIX_RED_INPUT');
            ctx.reply('🔧 Kirim Nomor WA:', {reply_markup: MENUS.cancel});
            break;
        case '🔓 Banding (Spam/Perm)':
            ctx.reply('🔓 Pilih Jenis:', {parse_mode:'HTML', reply_markup: MENUS.unbanType});
            break;
        case '🚫 Banding Spam':
            tempStorage.set(uid, { type: 'spam' });
            userStates.set(uid, 'UNBAN_INPUT');
            ctx.reply('🚫 Kirim Nomor:', {reply_markup: MENUS.cancel});
            break;
        case '⛔ Banding Permanen':
            tempStorage.set(uid, { type: 'permanen' });
            userStates.set(uid, 'UNBAN_INPUT');
            ctx.reply('⛔ Kirim Nomor:', {reply_markup: MENUS.cancel});
            break;

        case '🔍 Cek Nomor':
            if (!userSessions.has(uid) || userSessions.get(uid).size === 0) return ctx.reply('⚠️ Connect WA dulu.', {reply_markup: MENUS.settings});
            userStates.set(uid, 'CHECK_BIO');
            ctx.reply('✍️ Kirim Nomor:', {reply_markup: MENUS.cancel});
            break;

        case '👤 Profil Saya':
            await showDashboard(ctx, uid, role);
            break;
            
        case '📂 Konversi File':
             userStates.set(uid, 'CONVERT_XLSX');
             ctx.reply('📂 Kirim file .xlsx atau .txt untuk dikonversi menjadi list nomor.', {reply_markup: MENUS.cancel});
             break;
             
        case '❓ Bantuan':
            const guide = `📖 <b>PANDUAN LENGKAP</b>\n\n1. <b>Email Pool:</b> Disediakan oleh Owner, otomatis rotasi setiap ${CONFIG.maxCountPerEmail} pesan.\n2. <b>Multi-WA:</b> Bisa tambah sampai 5 nomor WA.\n3. <b>FixRed:</b> Untuk masalah nomor "Hubungi Kami".\n4. <b>Cek Nomor:</b> Semua permintaan Cek Bio diantrikan. Bot akan memberitahu saat giliran Anda diproses.\n5. <b>Konversi File:</b> Ubah Excel jadi Text.`;
            ctx.reply(guide, {parse_mode:'HTML', reply_markup: role === 'owner' ? MENUS.owner : MENUS.user});
            break;
    }
});

async function sendAutoEmail(ctx, uid, num, subject, body) {
    const mainKb = (uid === CONFIG.ownerId) ? MENUS.owner : MENUS.user;
    ctx.reply('⏳ <b>Mengirim...</b>', {parse_mode:'HTML'});
    
    try {
        const used = await EmailEngine.send(subject, body.replace('{nomor}', num));
        db.updateStats('fixed', 1);
        ctx.reply(`✅ <b>TERKIRIM!</b>\n🎯 ${num}\n📧 Dikirim via Pool Email: <code>${used}</code>`, {parse_mode:'HTML', reply_markup: mainKb});
    } catch(e) {
        ctx.reply(`❌ ${e.message}`, {reply_markup: mainKb});
    }
    userStates.delete(uid);
}

bot.on('document', async (ctx) => {
    const uid = String(ctx.from.id);
    const state = userStates.get(uid);
    const mainKb = (uid === CONFIG.ownerId) ? MENUS.owner : MENUS.user;
    
    if (state === 'CHECK_BIO') {
        const socks = userSessions.get(uid);
        if (!socks || socks.size === 0) return ctx.reply('❌ WA Disconnected.', {reply_markup: MENUS.settings});
        
        try {
            const link = await bot.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(link.href, { responseType: 'arraybuffer' });
            const nums = await FileHandler.process(res.data, ctx.message.document.file_name);
            
            // --- QUEUE LOGIC START ---
            checkQueue.push({ ctx, nums, uid });
            userStates.delete(uid); 
            
            if (isProcessingCheck) {
                return ctx.reply(`⏳ Permintaan Cek Bio Anda masuk antrian ke-${checkQueue.length}. Harap tunggu.`);
            }
            
            runNextCheck();
            return; 
            // --- QUEUE LOGIC END ---

        } catch (e) { ctx.reply('Error file.'); }
    } else if (state === 'CONVERT_XLSX') {
        try {
            const link = await bot.telegram.getFileLink(ctx.message.document.file_id);
            const res = await axios.get(link.href, { responseType: 'arraybuffer' });
            const nums = await FileHandler.process(res.data, ctx.message.document.file_name);
            const txtFile = `Converted_${Date.now()}.txt`;
            fs.writeFileSync(txtFile, nums.join('\n'));
            await ctx.replyWithDocument({ source: txtFile }, { caption: `✅ Sukses konversi ${nums.length} nomor.`, reply_markup: mainKb });
            fs.unlinkSync(txtFile);
            userStates.delete(uid);
        } catch (e) { ctx.reply('Gagal konversi file.'); }
    }
});

async function processBatchCheck(ctx, nums, uid) {
    const socksMap = userSessions.get(uid);
    const sockets = Array.from(socksMap.values());
    if (sockets.length === 0) throw new Error('Tidak ada sesi WA yang aktif untuk melakukan scan.');
    
    let results = [];
    let invalid = [];
    
    const batchSize = CONFIG.batchSize; 
    const delayPerBatch = CONFIG.delayPerBatch; 
    
    for (let i = 0; i < nums.length; i += batchSize) {
        const batch = nums.slice(i, i + batchSize);
        const promises = batch.map(async (num, index) => {
            const sock = sockets[index % sockets.length];
            const jid = num.replace(/\D/g, '') + '@s.whatsapp.net';
            
            try {
                const [res] = await sock.onWhatsApp(jid);
                
                if (res?.exists) {
                    let bio = 'Tidak Ada Bio', type = 'Original', date = 'Tidak Diketahui';
                    
                    try { 
                        const s = await sock.fetchStatus(jid); 
                        
                        if (s?.setAt) {
                            date = formatTimestamp(s.setAt);
                        }
                        bio = s?.status || 'Tidak Ada Bio';
                        
                    } catch (e) { /* Gagal fetchStatus */ }

                    try { 
                        const bp = await sock.getBusinessProfile(jid);
                        if (bp && bp.address) type = 'Business'; 
                    } catch (e) { /* Gagal getBusinessProfile */ }
                    
                    results.push({ 
                        num: num.replace(/\D/g, ''), 
                        bio: bio.replace(/[\r\n]+/g, ' ').trim(),
                        type: type, 
                        date: date 
                    });
                } else {
                    invalid.push(num.replace(/\D/g, ''));
                }
            } catch (e) { 
                invalid.push(num.replace(/\D/g, '')); 
            }
        });
        
        await Promise.all(promises);
        await delay(delayPerBatch);
        db.updateStats('checked', batch.length);
    }

    const business = results.filter(r => r.type === 'Business');
    const original = results.filter(r => r.type === 'Original');

    let content = `REPORT CHECK\n\n`;
    
    content += `[ 🏢 BUSINESS PROFILES (${business.length}) ]\n`;
    business.forEach(b => {
        content += `| Nomor: ${b.num}\n`;
        content += `| Bio: ${b.bio}\n`;
        content += `| Tipe: Business\n`;
        content += `| Waktu Update Bio: ${b.date}\n`;
        content += `---\n`;
    });
    
    content += `\n[ 👤 ORIGINAL PROFILES (${original.length}) ]\n`;
    original.forEach(b => {
        content += `| Nomor: ${b.num}\n`;
        content += `| Bio: ${b.bio}\n`;
        content += `| Tipe: Original\n`;
        content += `| Waktu Update Bio: ${b.date}\n`;
        content += `---\n`;
    });
    
    content += `\n[ ❌ INVALID/TIDAK TERDAFTAR (${invalid.length}) ]\n${invalid.join('\n')}`;

    const f = `Check_${Date.now()}.txt`;
    fs.writeFileSync(f, content);
    
    await ctx.replyWithDocument({source: f}, {
        caption: `✅ <b>SCAN SELESAI</b>\n📊 Total: ${nums.length}\n🏢 Business: ${business.length}\n👤 Original: ${original.length}\n❌ Invalid: ${invalid.length}`,
        parse_mode: 'HTML'
    });
    fs.unlinkSync(f);
}

(async () => {
    console.log('🚀 Starting V76 Final Stable...');
    await WAManager.loadAll();
    await bot.launch();
    console.log('✅ Bot Online');
})();

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
