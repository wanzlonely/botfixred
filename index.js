import { Telegraf, Markup } from 'telegraf';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
import P from "pino";
import fs from 'fs';
import nodemailer from 'nodemailer';
import axios from 'axios';
import path from 'path';
import XLSX from 'xlsx';

const CONFIG = {
    botToken: '8182701764:AAFZnFZQwn4aAV3Gowh5eGZ43ogG2V4swJk',
    ownerId: '7650101390',
    adminUserName: 'walzyexploit',
    groupLink: 'https://t.me/stockwalzyy',
    groupId: '-1003675929763',
    botImage: 'https://files.catbox.moe/kjfe0d.jpg',
    dbPath: './database',
    batchSize: 50,
    delayPerBatch: 3000,
    maxEmails: 10,
    maxCountPerEmail: 15,
    maxSessions: 5
};

const APPEAL_TEXTS = {
    spam: [
        "Subject: Mohon Tinjauan Ulang - Nomor Diblokir\n\nHalo Tim WhatsApp,\n\nNomor saya {nomor} telah diblokir karena dianggap spam. Saya menggunakan nomor ini untuk komunikasi pribadi dan pekerjaan sehari-hari. Saya rasa ini adalah kekeliruan sistem.\n\nMohon tinjau kembali aktivitas akun saya dan pulihkan aksesnya.",
        "Subject: Permintaan Pemulihan Akun\n\nKepada Dukungan WhatsApp,\n\nSaya tidak bisa mengakses nomor {nomor}. Nomor ini sangat penting bagi kehidupan saya. Saya berjanji akan mematuhi ketentuan layanan. Mohon bantuannya."
    ],
    permanen: [
        "Subject: Banding Blokir Permanen\n\nHalo,\n\nNomor {nomor} saya terkena blokir permanen. Saya minta maaf jika ada pelanggaran yang tidak disengaja. Tolong beri saya kesempatan kedua.",
        "Subject: Kesalahan Pemblokiran Akun\n\nHalo Tim,\n\nSaya yakin pemblokiran {nomor} adalah kesalahan. Saya tidak melakukan spam massal. Mohon dicek secara manual."
    ]
};

class Database {
    constructor() {
        if (!fs.existsSync(CONFIG.dbPath)) {
            fs.mkdirSync(CONFIG.dbPath, { recursive: true });
        }
        this.paths = {
            users: path.join(CONFIG.dbPath, 'users.json'),
            emails: path.join(CONFIG.dbPath, 'emails.json'),
            settings: path.join(CONFIG.dbPath, 'settings.json'),
            stats: path.join(CONFIG.dbPath, 'stats.json')
        };
        this.init();
    }

    init() {
        const defaultSettings = {
            owners: [CONFIG.ownerId],
            maintenance: false,
            templates: {
                fixred: {
                    subject: "Masalah Login",
                    body: "Halo Tim WhatsApp, nomor saya {nomor} tidak bisa login (Masalah Hubungi Kami). Mohon bantuannya untuk diperbaiki."
                }
            }
        };
        const defaultStats = {
            checked: 0,
            fixed: 0
        };

        if (!fs.existsSync(this.paths.settings)) {
            fs.writeFileSync(this.paths.settings, JSON.stringify(defaultSettings, null, 2));
        }
        if (!fs.existsSync(this.paths.users)) {
            fs.writeFileSync(this.paths.users, JSON.stringify({}, null, 2));
        }
        if (!fs.existsSync(this.paths.emails)) {
            fs.writeFileSync(this.paths.emails, JSON.stringify([], null, 2));
        }
        if (!fs.existsSync(this.paths.stats)) {
            fs.writeFileSync(this.paths.stats, JSON.stringify(defaultStats, null, 2));
        }
    }

    get(key) {
        try {
            return JSON.parse(fs.readFileSync(this.paths[key], 'utf8'));
        } catch {
            return null;
        }
    }

    set(key, data) {
        fs.writeFileSync(this.paths[key], JSON.stringify(data, null, 2));
    }

    get users() {
        return this.get('users') || {};
    }

    get settings() {
        let data = this.get('settings');
        if (!data || typeof data !== 'object') {
            data = {
                owners: [CONFIG.ownerId],
                maintenance: false,
                templates: {}
            };
        }
        if (!Array.isArray(data.owners)) {
            data.owners = [CONFIG.ownerId];
        }
        if (!data.owners.includes(CONFIG.ownerId)) {
            data.owners.push(CONFIG.ownerId);
        }
        if (!data.templates) {
            data.templates = {};
        }
        if (!data.templates.fixred) {
            data.templates.fixred = {
                subject: "Masalah Login",
                body: "Nomor {nomor} bermasalah."
            };
        }
        return data;
    }

    set settings(v) {
        this.set('settings', v);
    }

    get stats() {
        return this.get('stats') || { checked: 0, fixed: 0 };
    }

    get emails() {
        return this.get('emails') || [];
    }

    set emails(v) {
        this.set('emails', v);
    }

    isOwner(id) {
        const currentSettings = this.settings;
        const list = currentSettings.owners || [];
        return list.includes(String(id)) || String(id) === CONFIG.ownerId;
    }

    addOwner(id) {
        let s = this.settings;
        if (!s.owners.includes(String(id))) {
            s.owners.push(String(id));
            this.settings = s;
            return true;
        }
        return false;
    }

    removeOwner(id) {
        if (String(id) === CONFIG.ownerId) {
            return "SUPER_ADMIN";
        }
        let s = this.settings;
        const initialLen = s.owners.length;
        s.owners = s.owners.filter(o => o !== String(id));
        this.settings = s;
        return s.owners.length < initialLen ? "SUCCESS" : "NOT_FOUND";
    }

    updateUser(id, data) {
        const u = this.users;
        const uid = String(id);
        if (uid === CONFIG.ownerId) {
            data.expired = 9999999999999;
        }
        if (!u[uid]) {
            u[uid] = {
                id: uid,
                username: 'User',
                joined: Date.now(),
                expired: 0,
                sessions: []
            };
        }
        u[uid] = { ...u[uid], ...data };
        this.set('users', u);
        return u[uid];
    }

    updateTemplate(type, subject, body) {
        let s = this.settings;
        s.templates[type] = { subject, body };
        this.settings = s;
    }

    addEmail(email, pass) {
        let ePool = this.emails;
        if (ePool.length >= CONFIG.maxEmails) {
            return "LIMIT_REACHED";
        }
        if (ePool.find(e => e.email === email)) {
            return "EXISTS";
        }
        ePool.push({
            email,
            pass,
            count: 0,
            added: Date.now()
        });
        this.emails = ePool;
        return "SUCCESS";
    }

    removeEmail(index) {
        let ePool = this.emails;
        if (ePool.length <= index) {
            return false;
        }
        ePool.splice(index, 1);
        this.emails = ePool;
        return true;
    }

    updateStats(key, val) {
        const s = this.stats;
        s[key] += val;
        this.set('stats', s);
    }
}

const db = new Database();
const bot = new Telegraf(CONFIG.botToken, { handlerTimeout: 9000000 });
const userSessions = new Map();
const sessionStatus = new Map();
const userStates = new Map();
const tempStorage = new Map();
const checkQueue = [];
let isProcessingCheck = false;

function createProgressBar(current, max) {
    const filled = Math.round((current / max) * 5);
    const empty = 5 - filled;
    return '▰'.repeat(filled) + '▱'.repeat(empty);
}

async function runNextCheck() {
    if (isProcessingCheck || checkQueue.length === 0) {
        return;
    }
    isProcessingCheck = true;
    const { ctx, nums, uid } = checkQueue.shift();
    const isOwner = db.isOwner(uid);
    const mainKb = (uid === CONFIG.ownerId) ? MENUS.superAdmin : (isOwner ? MENUS.owner : MENUS.user);

    try {
        await ctx.reply(`<b>[ 🔄 SEDANG MEMPROSES DATA ]</b>\n\n📂 <b>Total Target:</b> ${nums.length} Nomor\n🚀 <b>Metode:</b> Multi-Session Deep Fetch\n⏳ <b>Status:</b> Sedang memindai...`, { parse_mode: 'HTML' });
        await processBatchCheck(ctx, nums, uid);
    } catch (error) {
        await ctx.reply(`❌ Terjadi Kesalahan: ${error.message}`, { reply_markup: mainKb });
    } finally {
        isProcessingCheck = false;
        runNextCheck();
    }
}

const MENUS = {
    superAdmin: {
        keyboard: [
            [{ text: '🚀 PERBAIKI WA' }, { text: '🔎 CEK BIO NOMOR' }],
            [{ text: '⚙️ PENGATURAN' }, { text: '👑 PANEL OWNER' }],
            [{ text: '👥 KELOLA USER' }, { text: '📂 KONVERSI FILE' }],
            [{ text: '❓ BANTUAN' }]
        ],
        resize_keyboard: true
    },
    owner: {
        keyboard: [
            [{ text: '🚀 PERBAIKI WA' }, { text: '🔎 CEK BIO NOMOR' }],
            [{ text: '⚙️ PENGATURAN' }, { text: '👥 KELOLA USER' }],
            [{ text: '📂 KONVERSI FILE' }, { text: '❓ BANTUAN' }]
        ],
        resize_keyboard: true
    },
    user: {
        keyboard: [
            [{ text: '🚀 PERBAIKI WA' }, { text: '🔎 CEK BIO NOMOR' }],
            [{ text: '⚙️ PENGATURAN' }, { text: '👤 PROFIL SAYA' }],
            [{ text: '📂 KONVERSI FILE' }, { text: '🛒 BELI SCRIPT' }],
            [{ text: '❓ BANTUAN' }]
        ],
        resize_keyboard: true
    },
    superAdminPanel: {
        keyboard: [
            [{ text: '➕ TAMBAH ADMIN' }, { text: '➖ HAPUS ADMIN' }],
            [{ text: '🚧 MAINTENANCE' }, { text: '📦 BACKUP DATA' }],
            [{ text: '📢 BROADCAST' }, { text: '📝 ATUR TEMPLATE' }],
            [{ text: '📋 LIST ADMIN' }, { text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    settings: {
        keyboard: [
            [{ text: '📧 KELOLA EMAIL' }, { text: '📱 KONEKSI WA' }],
            [{ text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    userMan: {
        keyboard: [
            [{ text: '➕ TAMBAH DURASI' }, { text: '➖ POTONG DURASI' }],
            [{ text: '👥 DAFTAR USER' }, { text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    emailMenu: {
        keyboard: [
            [{ text: '➕ TAMBAH EMAIL' }, { text: '📋 LIHAT EMAIL' }],
            [{ text: '🗑️ HAPUS EMAIL' }, { text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    waMenu: {
        keyboard: [
            [{ text: '➕ TAMBAH NOMOR' }, { text: '📋 LIHAT SESI' }],
            [{ text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    fixMenu: {
        keyboard: [
            [{ text: '🔧 FIX MASALAH LOGIN' }, { text: '🔓 BANDING (SPAM/PERM)' }],
            [{ text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    unbanType: {
        keyboard: [
            [{ text: '🚫 BANDING SPAM' }, { text: '⛔ BANDING PERMANEN' }],
            [{ text: '🔙 KEMBALI' }]
        ],
        resize_keyboard: true
    },
    cancel: {
        keyboard: [[{ text: '🔙 KEMBALI' }]],
        resize_keyboard: true
    },
    verify: {
        inline_keyboard: [
            [{ text: '🚀 GABUNG GRUP RESMI', url: CONFIG.groupLink }],
            [{ text: '✅ SAYA SUDAH JOIN', callback_data: 'verify_join' }]
        ]
    }
};

const Validator = {
    email: (text) => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(text.trim()),
    appPass: (text) => text.replace(/\s/g, '').length === 16,
    number: (text) => /^\d{10,15}$/.test(text.replace(/\D/g, '')),
    days: (text) => /^\d+$/.test(text.trim()) && parseInt(text) > 0
};

function formatTimeLeft(expiredTime) {
    if (expiredTime > 9000000000000) {
        return "SELAMANYA";
    }
    const diff = expiredTime - Date.now();
    if (diff <= 0) {
        return "HABIS";
    }
    const d = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return `${d} Hari`;
}

function formatDate(ms) {
    if (!ms) {
        return "-";
    }
    if (ms > 9000000000000) {
        return "Selamanya";
    }
    return new Date(ms).toLocaleDateString('id-ID');
}

function maskEmail(email) {
    const parts = email.split('@');
    if (parts.length !== 2) {
        return 'xxxx';
    }
    const [local, domain] = parts;
    return local.substring(0, 2) + '•••@' + domain;
}

const FileHandler = {
    async process(url, fileName) {
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            const ext = fileName.split('.').pop().toLowerCase();
            
            if (ext === 'txt') {
                const text = buffer.toString('utf-8');
                return text.match(/\d{8,15}/g) || [];
            } 
            else if (ext === 'xlsx' || ext === 'xls') {
                const wb = XLSX.read(buffer, { type: 'buffer' });
                let nums = [];
                wb.SheetNames.forEach(name => {
                    const sheet = wb.Sheets[name];
                    const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                    json.flat().forEach(cell => {
                        if (cell) {
                            const str = String(cell).replace(/\D/g, '');
                            if (str.length > 5) {
                                nums.push(str);
                            }
                        }
                    });
                });
                return nums;
            }
            return [];
        } catch (e) {
            throw new Error('Gagal mendownload atau membaca file. Pastikan format benar.');
        }
    }
};

const WAManager = {
    async startSession(userId, sessionId) {
        const uid = String(userId);
        const sessionKey = `${uid}_${sessionId}`;
        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${sessionId}`);
        if (!fs.existsSync(authPath)) {
            fs.mkdirSync(authPath, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })) },
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: true,
            syncFullHistory: false
        });

        if (!userSessions.has(uid)) {
            userSessions.set(uid, new Map());
        }
        userSessions.get(uid).set(sessionId, sock);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                sessionStatus.set(sessionKey, 'open');
                sock.user = { id: sock.user?.id || 'unknown' };
            } else if (connection === "close") {
                sessionStatus.set(sessionKey, 'close');
                if (userSessions.has(uid)) {
                    userSessions.get(uid).delete(sessionId);
                }
                const code = lastDisconnect?.error?.output?.statusCode;
                
                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                    const u = db.users[uid];
                    if (u.sessions) {
                        u.sessions = u.sessions.filter(s => s !== sessionId);
                        db.updateUser(uid, { sessions: u.sessions });
                    }
                    try {
                        await bot.telegram.sendMessage(uid, `⚠️ <b>PERANGKAT LOGOUT</b>\nSesi ke-${sessionId} telah terputus dan dihapus otomatis dari database.`, { parse_mode: 'HTML' });
                    } catch {}
                } else if (code !== 401) {
                    this.startSession(userId, sessionId);
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
            if (u.sessions.length >= CONFIG.maxSessions) {
                throw new Error("Batas Sesi Tercapai (Maks 5)");
            }
        }
        const authPath = path.join(CONFIG.dbPath, `auth_${uid}_${newSessionId}`);
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
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
            throw new Error("Gagal mengambil kode. Cek nomor HP Anda.");
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
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
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
        if (ePool.length === 0) {
            throw new Error("Stok Email Kosong!");
        }
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
                throw new Error(`Password Aplikasi Salah: ${maskEmail(emailData.email)}`);
            }
            throw error;
        }
    }
};

async function isGroupMember(ctx, uid) {
    if (CONFIG.groupId === '0') {
        return true;
    }
    if (uid === CONFIG.ownerId || db.isOwner(uid)) {
        return true;
    }
    try {
        const member = await ctx.telegram.getChatMember(CONFIG.groupId, uid);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        return false;
    }
}

const checkAuth = async (ctx, enforceGroup = true) => {
    const uid = String(ctx.from.id);
    let user = db.users[uid];
    const settings = db.settings;
    const isMaintenance = settings.maintenance;
    const isSuperAdmin = uid === CONFIG.ownerId;
    const isOwner = db.isOwner(uid);

    if (isMaintenance && !isSuperAdmin) {
        await ctx.reply("🚧 <b>SISTEM DALAM PERBAIKAN</b>\n\nAdmin sedang melakukan update. Mohon tunggu sebentar.", { parse_mode: 'HTML' });
        return false;
    }

    const currentName = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'User');
    if (!user) {
        user = { id: uid, username: currentName, joined: Date.now(), expired: 0 };
        if (uid === CONFIG.ownerId) {
            user.expired = 9999999999999;
        }
        db.updateUser(uid, user);
    } else if (user.username !== currentName) {
        db.updateUser(uid, { username: currentName });
    }

    if (!isSuperAdmin && !isOwner) {
        if (enforceGroup) {
            const isMember = await isGroupMember(ctx, uid);
            if (!isMember) {
                await ctx.replyWithPhoto(CONFIG.botImage, {
                    caption: `🛑 <b>AKSES DITOLAK</b>\n\nAnda wajib masuk ke grup resmi kami terlebih dahulu.\n\n👇 <i>Klik tombol di bawah ini:</i>`,
                    parse_mode: 'HTML',
                    reply_markup: MENUS.verify
                });
                return false;
            }
        }

        if (user.expired === 0 || Date.now() > user.expired) {
            const spamKey = `EXPIRED_${uid}`;
            if (!tempStorage.has(spamKey)) {
                await ctx.reply(`🔴 <b>MASA AKTIF HABIS</b>\n\nID: <code>${uid}</code>\nPaket Anda tidak aktif. Silakan hubungi Admin untuk membeli durasi.`, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📞 Hubungi Admin', url: `https://t.me/${CONFIG.adminUserName}` }]
                        ]
                    }
                });
                tempStorage.set(spamKey, true);
                setTimeout(() => tempStorage.delete(spamKey), 180000);

            }
            return false;
        }
    }

    if (isSuperAdmin) return 'superadmin';
    if (isOwner) return 'owner';
    return 'user';
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
        try { await ctx.deleteMessage(); } catch (e) { }
        const role = (uid === CONFIG.ownerId) ? 'superadmin' : (db.isOwner(uid) ? 'owner' : 'user');
        await showDashboard(ctx, uid, role);
    } else {
        await ctx.answerCbQuery('❌ Anda belum bergabung!', { show_alert: true });
    }
});

async function showDashboard(ctx, uid, role) {
    const u = db.users[uid] || {};
    const daysLeft = formatTimeLeft(u.expired);
    
    let activeSessions = 0;
    if (u.sessions) {
        const currentSessions = [...u.sessions];
        for (const s of currentSessions) {
            if (sessionStatus.get(`${uid}_${s}`) === 'open') {
                activeSessions++;
            } else {
                await WAManager.deleteSession(uid, s);
            }
        }
    }

    const progressBar = createProgressBar(activeSessions, 5);

    let roleBadge = '👤 PENGGUNA PREMIUM';
    let menu = MENUS.user;

    if (role === 'superadmin') {
        roleBadge = '👑 SUPER ADMIN';
        menu = MENUS.superAdmin;
    } else if (role === 'owner') {
        roleBadge = '🛡️ ADMIN / STAFF';
        menu = MENUS.owner;
    }

    const caption =
        `╭─── [ 𝗪 𝗔 𝗟 𝗭 𝗬  𝗩 𝟴 𝟵 ] ───╮
│ 👤 𝗨𝘀𝗲𝗿: ${u.username}
│ 💎 𝗥𝗼𝗹𝗲: ${roleBadge}
╰────────────────────────╯
╭── ⚡ 𝗦𝗧𝗔𝗧𝗨𝗦 𝗦𝗜𝗦𝗧𝗘𝗠 ──╮
│ 🟢 𝗦𝗲𝗿𝘃𝗲𝗿: 𝗢𝗻𝗹𝗶𝗻𝗲
│ 🔗 𝗞𝗼𝗻𝗲𝗸𝘀𝗶: ${progressBar} (${activeSessions}/5)
│ 📧 𝗦𝘁𝗼𝗸 𝗘𝗺𝗮𝗶𝗹: ${db.emails.length} Siap
╰────────────────────────╯
╭── 🔐 𝗜𝗡𝗙𝗢 𝗔𝗞𝗨𝗡 ──╮
│ 🆔 𝗜𝗗: <code>${uid}</code>
│ ⏳ 𝗘𝘅𝗽𝗶𝗿𝗲𝗱: ${daysLeft}
╰────────────────────────╯`;

    await ctx.replyWithPhoto(CONFIG.botImage, {
        caption: caption,
        parse_mode: 'HTML',
        reply_markup: menu
    });
}

bot.on(['text', 'photo', 'video'], async (ctx) => {
    const uid = String(ctx.from.id);
    const text = ctx.message.text || ctx.message.caption || '';
    const state = userStates.get(uid);
    const role = await checkAuth(ctx, true);
    if (!role) return;

    let mainKb;
    if (role === 'superadmin') {
        mainKb = MENUS.superAdmin;
    } else if (role === 'owner') {
        mainKb = MENUS.owner;
    } else {
        mainKb = MENUS.user;
    }

    const isSuperAdmin = (role === 'superadmin');
    const isOwnerOrSuper = (role === 'owner' || role === 'superadmin');

    if (text === '🔙 KEMBALI' || text === '🔙 Cancel') {
        userStates.delete(uid);
        if (text === '🔙 KEMBALI') {
            return showDashboard(ctx, uid, role);
        }
        return ctx.reply('Aksi dibatalkan.', { reply_markup: mainKb });
    }

    if (state) {
        try {
            if (isSuperAdmin && state === 'ADD_OWNER_ID') {
                const newOwner = text.trim();
                if (db.addOwner(newOwner)) {
                    ctx.reply(`✅ <b>${newOwner}</b> berhasil diangkat jadi Admin.`, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
                } else {
                    ctx.reply(`❌ User tersebut sudah jadi Admin.`, { reply_markup: MENUS.superAdminPanel });
                }
                userStates.delete(uid);
            }
            else if (isSuperAdmin && state === 'DEL_OWNER_ID') {
                const target = text.trim();
                const res = db.removeOwner(target);
                if (res === 'SUCCESS') {
                    ctx.reply(`✅ Akses Admin <b>${target}</b> telah dicabut.`, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
                } else if (res === 'SUPER_ADMIN') {
                    ctx.reply(`🛡️ Tidak bisa menghapus Super Admin.`, { reply_markup: MENUS.superAdminPanel });
                } else {
                    ctx.reply(`❌ ID tidak ditemukan.`, { reply_markup: MENUS.superAdminPanel });
                }
                userStates.delete(uid);
            }
            else if (isSuperAdmin && state === 'BROADCAST_MSG') {
                const users = Object.keys(db.users);
                await ctx.reply(`⏳ <b>Mengirim Broadcast...</b>\nTarget: ${users.length} pengguna.`, { parse_mode: 'HTML' });

                let success = 0;
                let blocked = 0;
                for (const u of users) {
                    try {
                        await bot.telegram.copyMessage(u, ctx.chat.id, ctx.message.message_id);
                        success++;
                        await delay(200);
                    } catch (e) { blocked++; }
                }
                ctx.reply(`✅ <b>SELESAI</b>\n\n✅ Terkirim: ${success}\n❌ Gagal: ${blocked}`, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
                userStates.delete(uid);
            }
            else if (isSuperAdmin && state === 'SETUP_TEMPLATE_SUBJ') {
                tempStorage.set(uid, { subj: text });
                userStates.set(uid, 'SETUP_TEMPLATE_BODY');
                ctx.reply('📝 <b>Set Isi Pesan Email:</b>\nGunakan <code>{nomor}</code> sebagai kode pengganti nomor target.\n\nContoh: <i>Halo, nomor {nomor} saya bermasalah...</i>', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
            }
            else if (isSuperAdmin && state === 'SETUP_TEMPLATE_BODY') {
                const subj = tempStorage.get(uid).subj;
                db.updateTemplate('fixred', subj, text);
                ctx.reply('✅ <b>Template Tersimpan!</b>', { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
                userStates.delete(uid);
            }
            else if (isOwnerOrSuper && state === 'SETUP_EMAIL_ADDR') {
                if (!Validator.email(text)) {
                    ctx.reply('❌ <b>Format Salah!</b>\nGunakan Gmail (@gmail.com)', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
                } else {
                    tempStorage.set(uid, { email: text.trim() });
                    userStates.set(uid, 'SETUP_EMAIL_PASS');
                    ctx.reply('🔑 <b>Langkah 2/2:</b>\nMasukkan 16 Digit App Password Google.', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
                }
            }
            else if (isOwnerOrSuper && state === 'SETUP_EMAIL_PASS') {
                const pass = text.replace(/\s+/g, '');
                if (!Validator.appPass(pass)) {
                    ctx.reply('❌ <b>Password Salah!</b>\nHarus 16 karakter.', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
                } else {
                    const email = tempStorage.get(uid).email;
                    const res = db.addEmail(email, pass);
                    if (res === 'SUCCESS') {
                        ctx.reply(`✅ <b>Berhasil!</b>\n${maskEmail(email)} ditambahkan.`, { parse_mode: 'HTML', reply_markup: MENUS.emailMenu });
                    } else {
                        ctx.reply('❌ Gagal menambahkan email.', { reply_markup: MENUS.emailMenu });
                    }
                    userStates.delete(uid);
                }
            }
            else if (isOwnerOrSuper && state === 'ADD_TIME_ID') {
                tempStorage.set(uid, { target: text.trim() });
                userStates.set(uid, 'ADD_TIME_DAYS');
                ctx.reply('📅 Mau tambah berapa hari?', { reply_markup: MENUS.cancel });
            }
            else if (isOwnerOrSuper && state === 'ADD_TIME_DAYS') {
                if (!Validator.days(text)) {
                    ctx.reply('❌ Masukkan angka yang benar.', { reply_markup: MENUS.cancel });
                } else {
                    const target = tempStorage.get(uid).target;
                    const days = parseInt(text);
                    const tUser = db.users[target];

                    if (!tUser) {
                        ctx.reply('❌ User ID tidak ditemukan.', { reply_markup: MENUS.userMan });
                        userStates.delete(uid);
                        return;
                    }

                    const currentExp = Number(tUser.expired);
                    const now = Date.now();
                    const newExp = (currentExp > now) ? (currentExp + (days * 86400000)) : (now + (days * 86400000));

                    db.updateUser(target, { expired: newExp });
                    ctx.reply(`✅ <b>Berhasil!</b>\nUser ${target} ditambah +${days} hari.\nExp Baru: ${formatDate(newExp)}`, { parse_mode: 'HTML', reply_markup: MENUS.userMan });
                    userStates.delete(uid);
                }
            }
            else if (isOwnerOrSuper && state === 'DEL_TIME_ID') {
                tempStorage.set(uid, { target: text.trim() });
                userStates.set(uid, 'DEL_TIME_DAYS');
                ctx.reply('📅 Mau dikurangi berapa hari?', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
            }
            else if (isOwnerOrSuper && state === 'DEL_TIME_DAYS') {
                if (!Validator.days(text)) {
                    ctx.reply('❌ Masukkan angka yang benar.', { reply_markup: MENUS.cancel });
                } else {
                    const target = tempStorage.get(uid).target;
                    const days = parseInt(text);
                    const tUser = db.users[target];

                    if (!tUser) {
                        ctx.reply('❌ User ID tidak ditemukan.', { reply_markup: MENUS.userMan });
                    } else {
                        const currentExp = Number(tUser.expired);
                        let newExp = currentExp - (days * 86400000);
                        if (newExp < Date.now()) newExp = 0;

                        db.updateUser(target, { expired: newExp });
                        ctx.reply(`✅ <b>Berhasil Dikurangi!</b>\nUser ${target} dikurangi -${days} hari.\nExp Baru: ${formatDate(newExp)}`, { parse_mode: 'HTML', reply_markup: MENUS.userMan });
                    }
                    userStates.delete(uid);
                }
            }
            else if (state === 'ADD_WA_NUM') {
                const num = text.replace(/\D/g, '');
                if (!Validator.number(num)) {
                    ctx.reply('❌ Nomor tidak valid.', { reply_markup: MENUS.cancel });
                } else {
                    ctx.reply('⏳ <b>Meminta Kode Pairing...</b>', { parse_mode: 'HTML' });
                    try {
                        const code = await WAManager.requestPairing(uid, num);
                        ctx.reply(`🔐 <b>KODE PAIRING ANDA:</b>\n\n<code>${code}</code>\n\n<i>Masukkan kode ini di WhatsApp Perangkat Tertaut.</i>`, { parse_mode: 'HTML', reply_markup: MENUS.waMenu });
                    } catch (e) {
                        ctx.reply(`❌ Gagal: ${e.message}`, { reply_markup: MENUS.waMenu });
                    }
                    userStates.delete(uid);
                }
            }
            else if (state === 'FIX_RED_INPUT' || state === 'UNBAN_INPUT') {
                const num = text.replace(/\D/g, '');
                if (!Validator.number(num)) {
                    return ctx.reply('❌ Nomor Salah.', { reply_markup: MENUS.cancel });
                }

                let subject, body;
                if (state === 'FIX_RED_INPUT') {
                    const t = db.settings.templates.fixred || { subject: "Help", body: "{nomor}" };
                    subject = t.subject;
                    body = t.body.split('{nomor}').join(num);
                } else {
                    const type = tempStorage.get(uid).type;
                    const texts = APPEAL_TEXTS[type];
                    const randomText = texts[Math.floor(Math.random() * texts.length)];
                    const [s, ...b] = randomText.split('\n\n');
                    subject = s.replace('Subject: ', '');
                    body = b.join('\n\n').replace('{nomor}', num);
                }

                await sendAutoEmail(ctx, uid, num, subject, body);
            }
            else if (state === 'CHECK_BIO') {
                let nums = [];
                
                if (text.length >= 4090) {
                    ctx.reply('⚠️ <b>PERINGATAN TELEGRAM:</b>\nPesan Anda terlalu panjang. Sebagian nomor mungkin terpotong. Untuk data >300 nomor, mohon gunakan kirim FILE (.txt atau .xlsx).', { parse_mode: 'HTML' });
                }

                nums = (text.match(/\d{8,15}/g) || []).map(n => n.replace(/\D/g, ''));
                
                let isConnected = false;
                const u = db.users[uid];
                if (u && u.sessions) {
                    for (const s of u.sessions) {
                        if (sessionStatus.get(`${uid}_${s}`) === 'open') {
                            isConnected = true;
                            break;
                        }
                    }
                }

                if (!isConnected) {
                    return ctx.reply('❌ <b>AKSES DITOLAK</b>\n\nTidak ada WhatsApp yang terhubung. Silakan hubungkan nomor di menu Pengaturan.', { parse_mode: 'HTML', reply_markup: MENUS.settings });
                }
                
                if (nums.length === 0) {
                    return ctx.reply('❌ Tidak ada nomor ditemukan.');
                }

                checkQueue.push({ ctx, nums, uid });
                userStates.delete(uid);
                if (isProcessingCheck) {
                    return ctx.reply(`⏳ Sedang antri...`);
                }
                runNextCheck();
                return;
            }
            else if (state === 'DEL_WA_INDEX') {
                const sessId = parseInt(text);
                await WAManager.deleteSession(uid, sessId);
                ctx.reply(`✅ Sesi ke-${sessId} dihapus.`, { reply_markup: MENUS.waMenu });
                userStates.delete(uid);
            }
            else if (isOwnerOrSuper && state === 'DEL_EMAIL_INDEX') {
                const idx = parseInt(text) - 1;
                if (db.removeEmail(idx)) {
                    ctx.reply('✅ Email berhasil dihapus.', { reply_markup: MENUS.emailMenu });
                } else {
                    ctx.reply('❌ Nomor urut salah.', { reply_markup: MENUS.emailMenu });
                }
                userStates.delete(uid);
            }

        } catch (error) {
            ctx.reply(`❌ Error: ${error.message}`, { reply_markup: mainKb });
            userStates.delete(uid);
        }
        return;
    }

    switch (text) {
        case '👑 PANEL OWNER':
            if (!isSuperAdmin) return;
            const currentSettings = db.settings;
            const status = currentSettings.maintenance ? '🔴 AKTIF' : '🟢 MATI';
            ctx.reply(`<b>👑 KONTROL SUPER ADMIN</b>\n\nMode Maintenance: <b>${status}</b>`, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
            break;
        case '➕ TAMBAH ADMIN':
            if (!isSuperAdmin) return;
            userStates.set(uid, 'ADD_OWNER_ID');
            ctx.reply('🆔 Masukkan ID Telegram calon Admin:', { reply_markup: MENUS.cancel });
            break;
        case '➖ HAPUS ADMIN':
            if (!isSuperAdmin) return;
            const settingsForDel = db.settings;
            const ownersList = settingsForDel.owners.filter(o => o !== CONFIG.ownerId).join('\n- ');
            userStates.set(uid, 'DEL_OWNER_ID');
            ctx.reply(`📝 <b>DAFTAR ADMIN:</b>\n- ${ownersList || 'Kosong'}\n\nMasukkan ID yang mau dihapus:`, { parse_mode: 'HTML', reply_markup: MENUS.cancel });
            break;
        case '🚧 MAINTENANCE':
            if (!isSuperAdmin) return;
            const s = db.settings;
            const current = s.maintenance;
            s.maintenance = !current;
            db.settings = s;
            const newStatus = !current ? '🔴 AKTIF' : '🟢 NON-AKTIF';
            ctx.reply(`🔧 <b>MODE MAINTENANCE: ${newStatus}</b>`, { parse_mode: 'HTML', reply_markup: MENUS.superAdminPanel });
            break;
        case '📢 BROADCAST':
            if (!isSuperAdmin) return;
            userStates.set(uid, 'BROADCAST_MSG');
            ctx.reply('📢 <b>Kirim Pesan Broadcast (Teks/Gambar/Video):</b>', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
            break;
        case '📝 ATUR TEMPLATE':
            if (!isSuperAdmin) return;
            userStates.set(uid, 'SETUP_TEMPLATE_SUBJ');
            ctx.reply('📝 <b>Set Judul Email untuk Fix Login:</b>', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
            break;
        case '📋 LIST ADMIN':
            if (!isSuperAdmin) return;
            const adminData = db.settings;
            const allOwners = (adminData.owners || []).map(id => (id === CONFIG.ownerId ? `👑 ${id} (SUPER)` : `👮 ${id} (Admin)`)).join('\n');
            ctx.reply(`👥 <b>STRUKTUR ADMIN:</b>\n\n${allOwners}`, { parse_mode: 'HTML' });
            break;
        case '📦 BACKUP DATA':
            if (!isSuperAdmin) return;
            ctx.reply('📦 Mengirim semua database...', { parse_mode: 'HTML' });
            if (fs.existsSync(db.paths.users)) await ctx.replyWithDocument({ source: db.paths.users });
            if (fs.existsSync(db.paths.emails)) await ctx.replyWithDocument({ source: db.paths.emails });
            if (fs.existsSync(db.paths.settings)) await ctx.replyWithDocument({ source: db.paths.settings });
            break;
        case '👥 KELOLA USER':
            if (!isOwnerOrSuper) return;
            ctx.reply('👥 <b>MANAJEMEN PENGGUNA</b>', { parse_mode: 'HTML', reply_markup: MENUS.userMan });
            break;
        case '👥 DAFTAR USER':
            if (!isOwnerOrSuper) return;
            const uList = Object.values(db.users).map((u, i) => {
                const exp = u.expired > 9000000000000 ? 'VIP' : (u.expired > Date.now() ? formatDate(u.expired) : 'Expired');
                return `${i + 1}. <code>${u.id}</code> | ${u.username} | ${exp}`;
            }).join('\n');
            ctx.reply(`👥 <b>DATABASE USER:</b>\n\n${uList}`, { parse_mode: 'HTML' });
            break;
        case '➕ TAMBAH DURASI':
            if (!isOwnerOrSuper) return;
            userStates.set(uid, 'ADD_TIME_ID');
            ctx.reply('🆔 Masukkan ID User:', { reply_markup: MENUS.cancel });
            break;
        case '➖ POTONG DURASI':
            if (!isOwnerOrSuper) return;
            userStates.set(uid, 'DEL_TIME_ID');
            ctx.reply('🆔 Masukkan ID User yang mau dipotong:', { reply_markup: MENUS.cancel });
            break;
        case '⚙️ PENGATURAN':
            ctx.reply('⚙️ <b>PENGATURAN SISTEM</b>', { parse_mode: 'HTML', reply_markup: MENUS.settings });
            break;
        case '📧 KELOLA EMAIL':
            ctx.reply('📧 <b>MANAJEMEN EMAIL</b>', { reply_markup: MENUS.emailMenu });
            break;
        case '📱 KONEKSI WA':
            ctx.reply('📱 <b>MANAJEMEN WHATSAPP</b>', { reply_markup: MENUS.waMenu });
            break;
        case '➕ TAMBAH EMAIL':
            if (!isOwnerOrSuper) return ctx.reply('Fitur Admin.');
            userStates.set(uid, 'SETUP_EMAIL_ADDR');
            ctx.reply('📧 Masukkan Alamat Gmail:', { reply_markup: MENUS.cancel });
            break;
        case '📋 LIHAT EMAIL':
            if (!isOwnerOrSuper) return ctx.reply('Fitur Admin.');
            const emails = db.emails || [];
            const eMsg = emails.map((e, i) => `${i + 1}. <code>${maskEmail(e.email)}</code> [${e.count}/${CONFIG.maxCountPerEmail}]`).join('\n');
            ctx.reply(`📧 <b>EMAIL AKTIF:</b>\n${eMsg || 'Kosong'}`, { parse_mode: 'HTML' });
            break;
        case '🗑️ HAPUS EMAIL':
            if (!isOwnerOrSuper) return ctx.reply('Fitur Admin.');
            userStates.set(uid, 'DEL_EMAIL_INDEX');
            ctx.reply(`🗑️ Masukkan nomor urut email yang mau dihapus:`, { reply_markup: MENUS.cancel });
            break;
        case '➕ TAMBAH NOMOR':
            userStates.set(uid, 'ADD_WA_NUM');
            ctx.reply('📱 Masukkan Nomor HP (628xxx):', { reply_markup: MENUS.cancel });
            break;
        case '📋 LIHAT SESI':
            const sess = db.users[uid].sessions || [];
            const wMsg = sess.map(s => `Perangkat ${s}: ${sessionStatus.get(`${uid}_${s}`) === 'open' ? '🟢 ONLINE' : '🔴 OFFLINE'}`).join('\n');
            ctx.reply(`📱 <b>STATUS KONEKSI:</b>\n\n${wMsg || 'Belum ada koneksi.'}`, { parse_mode: 'HTML' });
            break;
        case '❌ HAPUS SESI':
            userStates.set(uid, 'DEL_WA_INDEX');
            ctx.reply(`❌ Masukkan Nomor Sesi (contoh: 1) untuk dihapus:`, { reply_markup: MENUS.cancel });
            break;
        case '🚀 PERBAIKI WA':
            if (db.emails.length === 0) return ctx.reply('⚠️ Sistem belum siap. Hubungi Admin.', { reply_markup: mainKb });
            ctx.reply('🔧 <b>Pilih Jenis Perbaikan:</b>', { parse_mode: 'HTML', reply_markup: MENUS.fixMenu });
            break;
        case '🔧 FIX MASALAH LOGIN':
            userStates.set(uid, 'FIX_RED_INPUT');
            ctx.reply('🔧 Masukkan Nomor WA yang bermasalah (628xxx):', { reply_markup: MENUS.cancel });
            break;
        case '🔓 BANDING (SPAM/PERM)':
            ctx.reply('🔓 Pilih Jenis Blokir:', { parse_mode: 'HTML', reply_markup: MENUS.unbanType });
            break;
        case '🚫 BANDING SPAM':
            tempStorage.set(uid, { type: 'spam' });
            userStates.set(uid, 'UNBAN_INPUT');
            ctx.reply('🚫 Masukkan Nomor Terblokir (628xxx):', { reply_markup: MENUS.cancel });
            break;
        case '⛔ BANDING PERMANEN':
            tempStorage.set(uid, { type: 'permanen' });
            userStates.set(uid, 'UNBAN_INPUT');
            ctx.reply('⛔ Masukkan Nomor Terblokir (628xxx):', { reply_markup: MENUS.cancel });
            break;
        case '🔎 CEK BIO NOMOR':
            let isConnected = false;
            const u = db.users[uid];
            if (u && u.sessions) {
                for (const s of u.sessions) {
                    if (sessionStatus.get(`${uid}_${s}`) === 'open') {
                        isConnected = true;
                        break;
                    }
                }
            }

            if (!isConnected) {
                return ctx.reply('❌ <b>AKSES DITOLAK</b>\n\nTidak ada WhatsApp yang terhubung. Silakan hubungkan nomor di menu Pengaturan.', { parse_mode: 'HTML', reply_markup: MENUS.settings });
            }

            userStates.set(uid, 'CHECK_BIO');
            ctx.reply('✍️ <b>INPUT DATA:</b>\nKirim list nomor (copy paste) atau kirim file .txt/.xlsx', { parse_mode: 'HTML', reply_markup: MENUS.cancel });
            break;
        case '👤 PROFIL SAYA':
            await showDashboard(ctx, uid, role);
            break;
        case '📂 KONVERSI FILE':
            userStates.set(uid, 'CONVERT_XLSX');
            ctx.reply('📂 Kirim file Excel/Txt untuk dibersihkan (ambil nomor saja).', { reply_markup: MENUS.cancel });
            break;
        case '🛒 BELI SCRIPT':
            const priceList = `
╭─── [ 💸 𝗣𝗥𝗜𝗖𝗘 𝗟𝗜𝗦𝗧 𝗦𝗖𝗥𝗜𝗣𝗧 ] ───╮
│
│ 📦 𝗣𝗔𝗞𝗘𝗧 𝗛𝗘𝗠𝗔𝗧 (𝟭𝟬𝗞)
│ ├─ ✅ Full Fitur V89
│ ├─ ❌ Tidak Dapat Update
│ ├─ ❌ Support Basic
│ ╰────────────────────
│
│ 💎 𝗣𝗔𝗞𝗘𝗧 𝗦𝗨𝗟𝗧𝗔𝗡 (𝟭𝟱𝗞)
│ ├─ ✅ Full Fitur V89
│ ├─ ✅ 𝗚𝗥𝗔𝗧𝗜𝗦 𝗨𝗣𝗗𝗔𝗧𝗘 Seterusnya
│ ├─ ✅ Prioritas Support / Install
│ ╰────────────────────
│
│ 💳 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻: Dana / Gopay / QRIS
╰──────────────────────────────╯
`;
            ctx.reply(priceList, { 
                parse_mode: 'HTML', 
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👨‍💻 Chat Owner (Beli Sekarang)', url: `https://t.me/${CONFIG.adminUserName}` }]
                    ]
                }
            });
            break;
        case '❓ BANTUAN':
            const guide = `
<b>📖 PANDUAN PENGGUNAAN WALZY BOT</b>

1️⃣ <b>CARA MENGHUBUNGKAN WHATSAPP</b>
• Pergi ke Menu <b>⚙️ PENGATURAN</b>
• Pilih <b>📱 KONEKSI WA</b> > <b>➕ TAMBAH NOMOR</b>
• Masukkan nomor HP Anda (format 628xxx)
• Salin <b>KODE PAIRING</b> yang muncul
• Buka WA di HP > Perangkat Tertaut > Tautkan > Masukkan Kode.

2️⃣ <b>CARA MEMPERBAIKI WA (HUBUNGI KAMI)</b>
• Pilih menu <b>🚀 PERBAIKI WA</b> > <b>🔧 FIX MASALAH LOGIN</b>
• Masukkan nomor yang error.
• Bot akan otomatis mengirim email ke pihak WhatsApp.

3️⃣ <b>CARA CEK STATUS NOMOR (BIO)</b>
• Pastikan WA sudah terkoneksi (Langkah 1).
• Pilih menu <b>🔎 CEK BIO NOMOR</b>.
• Kirim list nomor atau file Excel/Txt.
• Bot akan memisahkan nomor Aktif, Tidak Aktif, dan Bisnis.

4️⃣ <b>CARA BANDING (UNBAN)</b>
• Pilih menu <b>🚀 PERBAIKI WA</b> > <b>🔓 BANDING</b>.
• Pilih jenis blokir (Spam/Permanen).
• Masukkan nomor yang terblokir.

<i>Jika ada kendala, silakan hubungi Admin.</i>
`;
            ctx.reply(guide, { parse_mode: 'HTML', reply_markup: mainKb });
            break;
    }
});

async function sendAutoEmail(ctx, uid, num, subject, body) {
    const mainKb = (uid === CONFIG.ownerId) ? MENUS.superAdmin : (db.isOwner(uid) ? MENUS.owner : MENUS.user);
    ctx.reply('📨 <b>Sedang Mengirim Permintaan...</b>', { parse_mode: 'HTML' });
    try {
        const used = await EmailEngine.send(subject, body.replace('{nomor}', num));
        db.updateStats('fixed', 1);
        ctx.reply(`✅ <b>EMAIL TERKIRIM!</b>\n\n🎯 <b>Target:</b> ${num}\n📧 <b>Via:</b> ${used}\n\n<i>Silakan cek status WA setelah 1-10 Detik ke Depan.</i>`, { parse_mode: 'HTML', reply_markup: mainKb });
    } catch (e) {
        ctx.reply(`❌ <b>GAGAL:</b> ${e.message}`, { parse_mode: 'HTML', reply_markup: mainKb });
    }
    userStates.delete(uid);
}

bot.on('document', async (ctx) => {
    const uid = String(ctx.from.id);
    const state = userStates.get(uid);
    const mainKb = (uid === CONFIG.ownerId) ? MENUS.superAdmin : (db.isOwner(uid) ? MENUS.owner : MENUS.user);

    if (state === 'CHECK_BIO') {
        const socks = userSessions.get(uid);
        if (!socks || socks.size === 0) return ctx.reply('❌ WA Terputus. Sambungkan ulang di Pengaturan.', { reply_markup: MENUS.settings });
        try {
            const link = await bot.telegram.getFileLink(ctx.message.document.file_id);
            const nums = await FileHandler.process(link.href, ctx.message.document.file_name);
            
            if (nums.length === 0) {
                return ctx.reply('❌ Tidak ada nomor valid dalam file. Pastikan format benar.');
            }

            checkQueue.push({ ctx, nums, uid });
            userStates.delete(uid);
            if (isProcessingCheck) return ctx.reply(`⏳ Sedang antri...`);
            runNextCheck();
        } catch (e) {
            ctx.reply('❌ Gagal membaca file: ' + e.message);
        }
    } else if (state === 'CONVERT_XLSX') {
        try {
            const link = await bot.telegram.getFileLink(ctx.message.document.file_id);
            const nums = await FileHandler.process(link.href, ctx.message.document.file_name);
            const txtFile = `Clean_${Date.now()}.txt`;
            fs.writeFileSync(txtFile, nums.join('\n'));
            await ctx.replyWithDocument({ source: txtFile }, { caption: `✅ <b>Selesai!</b>\nTotal: ${nums.length} Nomor Bersih.`, parse_mode: 'HTML', reply_markup: mainKb });
            fs.unlinkSync(txtFile);
            userStates.delete(uid);
        } catch (e) {
            ctx.reply('❌ File bermasalah.');
        }
    }
});

async function processBatchCheck(ctx, nums, uid) {
    const socksMap = userSessions.get(uid);
    const allSockets = Array.from(socksMap.values());
    let activeSockets = allSockets.filter(s => s.user); 
    
    if (activeSockets.length === 0) {
        if(allSockets.length > 0) activeSockets = allSockets;
        else throw new Error('Semua sesi WA terputus/banned.');
    }

    let results = [];
    let invalid = [];

    const formatDateIndo = (dateObj) => {
        if (!dateObj) return '-';
        try { return new Date(dateObj).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }); } 
        catch (e) { return '-'; }
    };

    const fetchUSync = async (sock, jid) => {
        try {
            const { USyncQuery, USyncUser } = await import('@whiskeysockets/baileys/lib/WAUSync/index.js');
            const usyncQuery = new USyncQuery().withContext('interactive').withStatusProtocol().withUser(new USyncUser().withId(jid));
            const result = await sock.executeUSyncQuery(usyncQuery);
            if (result?.list?.[0]?.status) {
                return { status: result.list[0].status.status, setAt: result.list[0].status.setAt };
            }
        } catch (e) { }
        return null;
    };

    const getRandomSocket = () => activeSockets[Math.floor(Math.random() * activeSockets.length)];

    for (let i = 0; i < nums.length; i += CONFIG.batchSize) {
        const batch = nums.slice(i, i + CONFIG.batchSize);
        const promises = batch.map(async (num) => {
            const cleanNum = num.replace(/\D/g, '');
            const jid = cleanNum + '@s.whatsapp.net';
            
            let sock = getRandomSocket();
            let attempts = 0;
            let success = false;

            while(attempts < 2 && !success) {
                try {
                    const [onWa] = await sock.onWhatsApp(jid);

                    if (onWa && onWa.exists) {
                        let bioContent = "Bio Kosong / Privasi"; 
                        let bioDate = "-";
                        let rawDate = 0;
                        let type = "PRIBADI";
                        let metaStatus = "NONE";

                        try {
                            await sock.presenceSubscribe(jid);
                            await sock.profilePictureUrl(jid, 'image').catch(() => {});
                        } catch (e) {}

                        let statusData = await fetchUSync(sock, jid);
                        if (!statusData) {
                            try {
                                const classic = await sock.fetchStatus(jid);
                                if (classic) statusData = classic;
                            } catch (err) { }
                        }

                        if (statusData && statusData.status) {
                            bioContent = statusData.status;
                            if (statusData.setAt) {
                                bioDate = formatDateIndo(statusData.setAt);
                                rawDate = new Date(statusData.setAt).getTime();
                            }
                        }

                        try {
                            const biz = await sock.getBusinessProfile(jid);
                            if (biz) {
                                const isHighLevel = (biz.verifiedLevel >= 2 || biz.verifiedLevel === 'high' || biz.verifiedLevel === 'very_high');
                                const hasVerifiedName = (biz.verifiedName && biz.verifiedName.length > 0 && biz.verifiedName !== biz.pushName);

                                if (isHighLevel || hasVerifiedName) {
                                    type = "BISNIS (META VERIFIED)";
                                    metaStatus = "VERIFIED";
                                } else {
                                    type = "BISNIS (PROSPEK META)";
                                    metaStatus = "CANDIDATE";
                                }

                                if (biz.description && (bioContent === "Bio Kosong / Privasi")) {
                                    bioContent = biz.description;
                                    bioDate = "Deskripsi Bisnis";
                                    rawDate = 9999999999999;
                                }
                            }
                        } catch (e) {
                        }

                        results.push({ 
                            num: cleanNum, 
                            type: type, 
                            metaStatus: metaStatus,
                            date: bioDate, 
                            rawDate: rawDate,
                            bio: bioContent.replace(/[\r\n]+/g, ' ').trim()
                        });
                    } else {
                        invalid.push(cleanNum);
                    }
                    success = true; 
                } catch (e) {
                    if (e.message.includes('Stream') || e.message.includes('Connection')) {
                        activeSockets = activeSockets.filter(s => s !== sock);
                        if(activeSockets.length === 0) throw new Error("Semua sesi mati.");
                        sock = getRandomSocket();
                    } else {
                        success = true; 
                    }
                }
                attempts++;
            }
        });

        await Promise.all(promises);
        if (i + CONFIG.batchSize < nums.length) await delay(CONFIG.delayPerBatch);
    }

    const validResults = results.filter(r => r.rawDate > 0).sort((a, b) => a.rawDate - b.rawDate);
    const noDateResults = results.filter(r => r.rawDate === 0);
    const finalSorted = [...validResults, ...noDateResults];

    const listVerified = finalSorted.filter(r => r.metaStatus === "VERIFIED");
    const listFiturMeta = finalSorted.filter(r => r.metaStatus === "CANDIDATE");
    const listBiz = finalSorted.filter(r => r.type.toUpperCase().includes('BISNIS') && r.metaStatus !== "VERIFIED" && r.metaStatus !== "CANDIDATE");
    const listPers = finalSorted.filter(r => r.type.toUpperCase().includes('PRIBADI'));

    let content = `WALZY INTELLIGENCE V91\n`;
    content += `Scan: ${new Date().toLocaleString('id-ID')}\n`;
    content += `Data: ${results.length} Valid Numbers\n\n`;

    const addSection = (title, list) => {
        if (list.length === 0) return;
        
        content += `>>> ${title} (${list.length})\n`;
        content += `──────────────────────────────\n`;
        
        list.forEach(r => {
            let labelTipe = "PRIBADI 👤";
            if (r.metaStatus === "VERIFIED") labelTipe = "SUDAH CENTANG BIRU ✅";
            else if (r.metaStatus === "CANDIDATE") labelTipe = "FITUR VERIF META (BELUM BELI) 💼";
            else if (r.type.toUpperCase().includes("BISNIS")) labelTipe = "BUSINESS ACCOUNT 🏢";

            let displayBio = r.bio;
            if (!displayBio || displayBio.trim() === "") displayBio = "TIDAK ADA BIO / PRIVATE";

            content += `╭── 👤 ${r.num}\n`;
            content += `│ 🏷️ ${labelTipe}\n`;
            content += `│ 📅 ${r.date}\n`;
            content += `│ 📝 ${displayBio}\n`;
            content += `╰───────────────────────────\n`;
        });
        content += `\n`;
    };

    addSection("LIST SUDAH CENTANG BIRU", listVerified);
    addSection("LIST ADA FITUR VERIFIKASI META", listFiturMeta);
    addSection("LIST WHATSAPP BUSINESS BIASA", listBiz);
    addSection("LIST WHATSAPP PRIBADI", listPers);

    if (invalid.length > 0) {
        content += `>>> INVALID / GAGAL (${invalid.length})\n`;
        content += `──────────────────────────────\n`;
        content += invalid.map(n => `❌ ${n}`).join('\n');
    }

    const f = `Hasil_${uid}_${Date.now()}.txt`;
    fs.writeFileSync(f, content);

    const total = nums.length;
    const verifiedCount = listVerified.length;
    const fiturMetaCount = listFiturMeta.length;
    const bizCount = listBiz.length;
    const persCount = listPers.length;
    const hasBio = results.filter(r => r.rawDate > 0 || (r.bio !== "Bio Kosong / Privasi")).length;
    const noBio = results.length - hasBio;
    
    let oldestYear = validResults.length > 0 ? new Date(validResults[0].rawDate).getFullYear() : "-";

    const caption =
`⚡ <b>WALZY INTELLIGENCE V91</b>
━━━━━━━━━━━━━━━━━━
📊 <b>STATISTIK INPUT</b>
├ 📁 Total Nomor : ${total}
└ ✅ Valid WA : ${results.length}

😈 <b>KATEGORI AKUN</b>
├ 🌟 <b>Centang Biru : ${verifiedCount}</b>
├ 💼 Fitur Meta : ${fiturMetaCount}
├ 🏢 Bisnis Biasa : ${bizCount}
└ 👤 Akun Pribadi : ${persCount}

📝 <b>INFO TAMBAHAN</b>
├ 🟢 Ada Bio : ${hasBio}
├ 🔴 No Bio : ${noBio}
└ 📅 Tahun Tertua : ${oldestYear}

<i>File txt sudah disusun rapi.</i>`;

    await ctx.replyWithDocument({ source: f }, { caption: caption, parse_mode: 'HTML' });
    fs.unlinkSync(f);
}

(async () => {
    console.log('🚀 Walzy V89 FINAL Started...');
    await WAManager.loadAll();
    await bot.launch({ dropPendingUpdates: true }); 
    console.log('✅ Sistem Online');
})();

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());