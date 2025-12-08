import { Telegraf, Markup } from 'telegraf';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
import P from "pino";
import fs from 'fs';
import nodemailer from 'nodemailer';
import axios from 'axios';
import path from 'path';
import csv from 'csv-parser';
import XLSX from 'xlsx';
import { PassThrough } from 'stream';

const CONFIG = {
    botToken: '8250992727:AAG2XlCefa-XZPLw9KlaexgnPI0bx-nZ6uE',
    ownerId: '7732520601',
    groupLink: 'https://t.me/stockwalzy',
    groupId: '-1003325663954',
    botImage: 'https://files.catbox.moe/kjfe0d.jpg',
    dbPath: './database',
    trialDuration: 86400000,
    batchSize: 50,
    delayPerBatch: 2000
};

const RANDOM_NAMES = ["Andi", "Budi", "Citra", "Dewi", "Eko", "Fajar", "Gita", "Hendra", "Indah", "Joko", "Kartika", "Lestari", "Maya", "Nanda"];
const APPEAL_MESSAGES = [
    "Halo Tim WA, nomor saya {nomor} tidak bisa diakses. Mohon bantuannya.",
    "Kepada Support WhatsApp, tolong pulihkan nomor {nomor} saya. Ini nomor penting.",
    "Hello WhatsApp, my number {nomor} is banned by mistake. Please recover it.",
    "Saya pemilik nomor {nomor}, mohon tinjau ulang pemblokiran ini. Terima kasih."
];

class Database {
    constructor() {
        if (!fs.existsSync(CONFIG.dbPath)) fs.mkdirSync(CONFIG.dbPath, { recursive: true });
        this.paths = {
            users: path.join(CONFIG.dbPath, 'users.json'),
            admins: path.join(CONFIG.dbPath, 'admins.json'),
            allowed: path.join(CONFIG.dbPath, 'allowed.json'),
            templates: path.join(CONFIG.dbPath, 'templates.json'),
            history: path.join(CONFIG.dbPath, 'history.json')
        };
        this.init();
    }

    init() {
        const defaults = {
            users: {},
            admins: [String(CONFIG.ownerId)],
            allowed: [],
            templates: [{ id: 1, subject: "Masalah Login", body: "Halo Tim WA, nomor {nomor} bermasalah." }],
            history: []
        };
        for (const [key, p] of Object.entries(this.paths)) {
            if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(defaults[key], null, 2));
        }
    }

    get(key) { try { return JSON.parse(fs.readFileSync(this.paths[key], 'utf8')); } catch { return null; } }
    set(key, data) { fs.writeFileSync(this.paths[key], JSON.stringify(data, null, 2)); }

    get users() { return this.get('users'); }
    get admins() { return this.get('admins'); }
    get allowed() { return this.get('allowed'); }
    get templates() { return this.get('templates'); }
    get history() { return this.get('history'); }

    updateUser(id, data) {
        const u = this.users;
        u[id] = { ...u[id], ...data };
        this.set('users', u);
    }

    saveHistory(data) {
        const hist = this.history;
        const newId = hist.length > 0 ? hist[hist.length - 1].id + 1 : 1;
        hist.push({ id: newId, ...data, timestamp: new Date().toISOString() });
        this.set('history', hist);
    }
}

const db = new Database();
const bot = new Telegraf(CONFIG.botToken, { handlerTimeout: 9000000 });
const userSessions = new Map();
const userStates = new Map();
const tempStorage = new Map();

function isRepeNumber(number) {
    const n = number.toString();
    if (/(\d)\1{2,}/.test(n)) return true;
    const d = n.split('').map(Number);
    let up = true, down = true;
    for (let i = 1; i < d.length; i++) {
        if (d[i] !== d[i-1] + 1) up = false;
        if (d[i] !== d[i-1] - 1) down = false;
    }
    return up || down || n === n.split('').reverse().join('');
}

const FileHandler = {
    async readTxt(buffer) {
        return buffer.toString('utf8').split(/[\r\n]+/).filter(n => n.trim().length > 0);
    },
    async readCsv(buffer) {
        return new Promise((resolve, reject) => {
            const numbers = [];
            const stream = new PassThrough();
            stream.end(buffer);
            stream.pipe(csv())
                .on('data', (row) => Object.values(row).forEach(v => { if (v && v.toString().trim().length > 0) numbers.push(v.toString().trim()); }))
                .on('end', () => resolve(numbers))
                .on('error', reject);
        });
    },
    async readXlsx(buffer) {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const numbers = [];
        workbook.SheetNames.forEach(name => {
            const sheet = workbook.Sheets[name];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            data.flat().forEach(v => { if (v && v.toString().trim().length > 0) numbers.push(v.toString().trim()); });
        });
        return numbers;
    },
    async process(buffer, fileName) {
        const ext = fileName.toLowerCase().split('.').pop();
        if (ext === 'txt') return await this.readTxt(buffer);
        if (ext === 'csv') return await this.readCsv(buffer);
        if (ext === 'xlsx') return await this.readXlsx(buffer);
        throw new Error('Format file tidak didukung (Gunakan .txt, .csv, atau .xlsx)');
    }
};

const WAManager = {
    async startUserSession(userId) {
        const uid = String(userId);
        const authPath = path.join(CONFIG.dbPath, `auth_user_${uid}`);
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

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "close") {
                if (userSessions.has(uid)) userSessions.delete(uid);
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    this.deleteSession(uid);
                } else {
                    this.startUserSession(uid);
                }
            } else if (connection === "open") {
                userSessions.set(uid, sock);
                db.updateUser(uid, { sessionActive: true });
                try { await bot.telegram.sendMessage(uid, `🔔 *WhatsApp Terhubung!*\nSesi Anda siap digunakan.`); } catch {}
            }
        });

        sock.ev.on("creds.update", saveCreds);
        userSessions.set(uid, sock);
        return sock;
    },

    deleteSession(userId) {
        const uid = String(userId);
        userSessions.delete(uid);
        const p = path.join(CONFIG.dbPath, `auth_user_${uid}`);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        db.updateUser(uid, { sessionActive: false });
    },

    async loadAll() {
        const users = db.users;
        for (const [uid, userData] of Object.entries(users)) {
            if (userData.sessionActive) {
                await this.startUserSession(uid);
                await delay(1000);
            }
        }
    }
};

const EmailEngine = {
    send(user, targetNumber, template) {
        if (!user.email || !user.emailPass) throw new Error("Email belum disetting.");
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com', port: 587, secure: false,
            auth: { user: user.email, pass: user.emailPass },
            tls: { rejectUnauthorized: false }
        });
        const body = template.body.replace(/{nomor}/g, targetNumber);
        return transporter.sendMail({
            from: user.email,
            to: 'support@support.whatsapp.com',
            subject: template.subject,
            text: body
        });
    }
};

const checkAuth = async (ctx) => {
    const uid = String(ctx.from.id);
    let user = db.users[uid];
    if (!user) {
        user = { 
            id: uid, username: ctx.from.username || 'User', 
            joined: Date.now(), expired: Date.now() + CONFIG.trialDuration,
            email: null, emailPass: null, sessionActive: false 
        };
        db.updateUser(uid, user);
    }

    const isOwner = uid === CONFIG.ownerId;
    const isAdmin = db.admins.includes(uid);
    const isAllowed = db.allowed.includes(uid);

    if (isOwner || isAdmin || isAllowed) return true;

    if (CONFIG.groupId !== '0') {
        try {
            const member = await ctx.telegram.getChatMember(CONFIG.groupId, uid);
            if (['left', 'kicked'].includes(member.status)) {
                await ctx.reply(`❌ *AKSES DITOLAK*\nSilakan join grup terlebih dahulu.`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[Markup.button.url('🚀 JOIN GRUP', CONFIG.groupLink)]] }
                });
                return false;
            }
        } catch {}
    }

    if (Date.now() > user.expired) {
        await ctx.reply('⛔ *Masa Aktif Habis*\nHubungi Owner untuk perpanjangan.', {parse_mode:'Markdown'});
        return false;
    }
    return true;
};

const UI = {
    async send(ctx, text, buttons) {
        try { await ctx.editMessageCaption(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }); }
        catch { try { await ctx.deleteMessage(); } catch {} await ctx.replyWithPhoto(CONFIG.botImage, { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }); }
    },
    async menu(ctx) {
        const uid = String(ctx.from.id);
        const u = db.users[uid];
        const isOwner = uid === CONFIG.ownerId;
        const isAdmin = db.admins.includes(uid);
        const role = isOwner ? 'Owner' : (isAdmin ? 'Admin' : 'User');
        const status = Date.now() > u.expired ? '🔴 Expired' : '🟢 Active';
        
        let text = `╭───── ⧼ 𝑰 𝒏 𝒇 𝒐 - 𝑩 𝒐 𝒕 𝒔 ⧽
│🤖 𝐁𝐨𝐭 : Whatsapp Master V36
│👤 𝐑𝐨𝐥𝐞 : ${role}
│🎫 𝐒𝐭𝐚𝐭𝐮𝐬 : ${status}
╰─────
╭───── ⧼ 𝑺 𝒕 𝒂 𝒕 𝒖 𝒔 - 𝑼 𝒔 𝒆 𝒓 ⧽
┃ 📧 Email: ${u.email ? '✅' : '❌'}
┃ 📱 WA: ${userSessions.has(uid) ? '✅' : '❌'}
╰─────
 ═══════════[ 𝙈𝙀𝙉𝙐 ]═══════════\n`;

        const buttons = [
            [Markup.button.callback('🔧 Fix Menu', 'm_fix'), Markup.button.callback('🔍 Cek Menu', 'm_cek')],
            [Markup.button.callback('⚙️ Setup Saya', 'm_myset'), Markup.button.callback('👤 Profil', 'm_prof')]
        ];

        if (isAdmin || isOwner) buttons.push([Markup.button.callback('🔐 Admin Panel', 'm_adm')]);
        await UI.send(ctx, text, buttons);
    }
};

const Back = [Markup.button.callback('🔙 Kembali', 'home')];

bot.command('start', async (ctx) => { userStates.delete(String(ctx.from.id)); if (await checkAuth(ctx)) await UI.menu(ctx); });
bot.action('home', async (ctx) => { userStates.delete(String(ctx.from.id)); await UI.menu(ctx); });
bot.action('cancel', async (ctx) => { userStates.delete(String(ctx.from.id)); await ctx.answerCbQuery('Dibatalkan'); await UI.menu(ctx); });

bot.action('m_fix', (ctx) => UI.send(ctx, `🔧 *MENU FIX*\n\nPilih metode:`, [[Markup.button.callback('🚀 Auto Email', 'a_fix_auto')], [Markup.button.callback('📝 Generate Teks', 'a_fix_man')], Back]));
bot.action('m_cek', (ctx) => UI.send(ctx, `🔍 *MENU CEK*\n\nPilih alat pengecekan:`, [[Markup.button.callback('✍️ Cek Bio (Manual)', 'a_cek_man'), Markup.button.callback('📂 Cek Bio (File)', 'a_cek_file')], [Markup.button.callback('🔢 Cek Repe', 'a_cek_repe'), Markup.button.callback('📊 Cek Range', 'a_cek_range')], Back]));
bot.action('m_myset', (ctx) => UI.send(ctx, `⚙️ *PENGATURAN SAYA*`, [[Markup.button.callback('📧 Set Email', 'my_set_email'), Markup.button.callback('📱 Connect WA', 'my_set_wa')], [Markup.button.callback('❌ Logout WA', 'my_del_wa')], Back]));
bot.action('m_adm', (ctx) => UI.send(ctx, `🔐 *ADMIN PANEL*`, [[Markup.button.callback('📝 Set Template', 's_tm_set'), Markup.button.callback('➕ Add Time', 'u_add')], [Markup.button.callback('📋 List User', 'u_list')], Back]));
bot.action('m_prof', (ctx) => { const u = db.users[String(ctx.from.id)]; UI.send(ctx, `👤 *PROFIL*\nID: \`${u.id}\`\nExp: ${new Date(u.expired).toLocaleDateString()}`, [Back]); });

bot.action('my_set_email', (ctx) => { userStates.set(String(ctx.from.id), 'MY_SET_EMAIL'); UI.send(ctx, `📧 *SET EMAIL PRIBADI*\n\nKirim alamat Gmail Anda.`, [Back]); });
bot.action('my_set_wa', async (ctx) => { await WAManager.startUserSession(ctx.from.id); userStates.set(String(ctx.from.id), 'MY_SET_WA_NUM'); UI.send(ctx, `📱 *CONNECT WHATSAPP*\n\nKirim Nomor HP Anda (Contoh: 628xxx).`, [Back]); });
bot.action('my_del_wa', (ctx) => { WAManager.deleteSession(ctx.from.id); ctx.reply('✅ Sesi WhatsApp dihapus.'); });
bot.action('a_fix_auto', (ctx) => { const u = db.users[String(ctx.from.id)]; if (!u.email) return ctx.answerCbQuery('❌ Setting email dulu!', { show_alert: true }); userStates.set(String(ctx.from.id), 'FIX_AUTO'); UI.send(ctx, `🚀 *AUTO FIX*\nKirim Nomor WA Target.`, [Back]); });
bot.action('a_fix_man', (ctx) => { userStates.set(String(ctx.from.id), 'FIX_MAN'); UI.send(ctx, `📝 *GENERATE TEXT*\nKirim Nomor WA Target.`, [Back]); });
bot.action('a_cek_man', (ctx) => { if (!userSessions.has(String(ctx.from.id))) return ctx.answerCbQuery('❌ WA belum konek!', { show_alert: true }); userStates.set(String(ctx.from.id), 'CEK_MAN'); UI.send(ctx, `✍️ *INPUT NOMOR*\nKirim nomor dipisahkan spasi/enter.`, [Back]); });
bot.action('a_cek_file', (ctx) => { if (!userSessions.has(String(ctx.from.id))) return ctx.answerCbQuery('❌ WA belum konek!', { show_alert: true }); userStates.set(String(ctx.from.id), 'CEK_FILE'); UI.send(ctx, `📂 *UPLOAD FILE*\nKirim file .txt/.csv/.xlsx.`, [Back]); });
bot.action('a_cek_repe', (ctx) => { if (!userSessions.has(String(ctx.from.id))) return ctx.answerCbQuery('❌ WA belum konek!', { show_alert: true }); userStates.set(String(ctx.from.id), 'CEK_REPE'); UI.send(ctx, `🔢 *CEK REPE*\nKirim list nomor.`, [Back]); });
bot.action('a_cek_range', (ctx) => { if (!userSessions.has(String(ctx.from.id))) return ctx.answerCbQuery('❌ WA belum konek!', { show_alert: true }); userStates.set(String(ctx.from.id), 'CEK_RANGE'); UI.send(ctx, `📊 *CEK RANGE*\nFormat: Prefix Start End`, [Back]); });
bot.action('s_tm_set', (ctx) => { userStates.set(String(ctx.from.id), 'SET_TM_SUBJ'); UI.send(ctx, `📝 *SET TEMPLATE*\nKirim Judul Email.`, [Back]); });
bot.action('u_add', (ctx) => { userStates.set(String(ctx.from.id), 'ADM_TIME_ID'); UI.send(ctx, `➕ *ADD TIME*\nKirim ID User.`, [Back]); });
bot.action('u_list', (ctx) => { const list = Object.values(db.users).map(u => `ID: ${u.id} (${u.username})`).join('\n'); if (list.length > 3000) { fs.writeFileSync('u.txt', list); ctx.replyWithDocument({ source: 'u.txt' }); fs.unlinkSync('u.txt'); } else UI.send(ctx, `👥 *USER LIST*\n\n${list}`, [Back]); });

bot.command('addadmin', (ctx) => { if (String(ctx.from.id) !== CONFIG.ownerId) return; const id = ctx.message.text.split(' ')[1]; if (!id) return; const admins = db.admins; if (!admins.includes(id)) admins.push(id); db.set('admins', admins); ctx.reply(`✅ Admin ${id} ditambahkan.`); });
bot.command('addkacung', (ctx) => { if (!db.admins.includes(String(ctx.from.id)) && String(ctx.from.id) !== CONFIG.ownerId) return; const id = ctx.message.text.split(' ')[1]; if (!id) return; const allowed = db.allowed; if (!allowed.includes(id)) allowed.push(id); db.set('allowed', allowed); ctx.reply(`✅ Kacung ${id} ditambahkan.`); });
bot.command('listkacung', (ctx) => { if (!db.admins.includes(String(ctx.from.id)) && String(ctx.from.id) !== CONFIG.ownerId) return; ctx.reply(`📋 List Kacung:\n${db.allowed.join('\n')}`); });

bot.on('message', async (ctx) => {
    const uid = String(ctx.from.id);
    const state = userStates.get(uid);
    const text = ctx.message.text;
    if (!state) return;

    if (state === 'MY_SET_EMAIL') {
        tempStorage.set(uid, { email: text.trim() });
        userStates.set(uid, 'MY_SET_PASS');
        ctx.reply('✅ Email diterima. Kirim *App Password*.');
    } else if (state === 'MY_SET_PASS') {
        db.updateUser(uid, { email: tempStorage.get(uid).email, emailPass: text.replace(/\s+/g, '') });
        ctx.reply('✅ Email tersimpan!');
        userStates.delete(uid);
        UI.menu(ctx);
    } else if (state === 'MY_SET_WA_NUM') {
        const sock = userSessions.get(uid);
        if (!sock) return ctx.reply('❌ Sesi Error.');
        try {
            const code = await sock.requestPairingCode(text.replace(/\D/g, ''));
            ctx.reply(`🔢 Kode: \`${code}\``, { parse_mode: 'Markdown' });
            userStates.delete(uid);
        } catch(e) { ctx.reply(`Gagal: ${e.message}`); }
    }

    else if (state === 'SET_TM_SUBJ') {
        tempStorage.set(uid, { s: text });
        userStates.set(uid, 'SET_TM_BODY');
        ctx.reply('✅ Judul oke. Kirim Isi Pesan ({nomor}).');
    } else if (state === 'SET_TM_BODY') {
        db.templates = [{ id: 1, subject: tempStorage.get(uid).s, body: text }];
        ctx.reply('✅ Template Updated.');
        userStates.delete(uid);
        UI.menu(ctx);
    }

    else if (state === 'FIX_AUTO') {
        const num = text.replace(/\D/g, '');
        const mt = db.templates[0];
        const u = db.users[uid];
        try {
            await EmailEngine.send(u, num, mt);
            db.saveHistory({ userId: uid, action: 'FIX', target: num, status: 'SUCCESS' });
            ctx.reply(`✅ Terkirim!\nTarget: ${num}`);
            userStates.delete(uid);
        } catch (e) { ctx.reply(`❌ Gagal: ${e.message}`); }
    } else if (state === 'FIX_MAN') {
        const num = text.replace(/\D/g, '');
        const name = RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
        const msg = APPEAL_MESSAGES[Math.floor(Math.random() * APPEAL_MESSAGES.length)].replace('{nomor}', num);
        ctx.reply(`📝 *Nama:* ${name}\n\n${msg}`, { parse_mode: 'Markdown' });
        userStates.delete(uid);
    }

    else if (state === 'CEK_MAN' || (state === 'CEK_FILE' && ctx.message.document) || state === 'CEK_REPE') {
        let nums = [];
        if (ctx.message.document) {
            try {
                const link = await bot.telegram.getFileLink(ctx.message.document.file_id);
                const res = await axios.get(link.href, { responseType: 'arraybuffer' });
                nums = await FileHandler.process(res.data, ctx.message.document.file_name);
            } catch (e) { return ctx.reply(`❌ Gagal baca file: ${e.message}`); }
        } else {
            nums = text.split(/[\s,\n]+/).map(n => n.replace(/\D/g, '')).filter(n => n.length > 5);
        }

        if (state === 'CEK_REPE') nums = nums.filter(n => isRepeNumber(n));
        if (nums.length === 0) return ctx.reply('No valid numbers.');
        
        const sock = userSessions.get(uid);
        if(!sock) return ctx.reply('❌ WA Belum Konek.');
        processBatchCheck(ctx, nums, sock);
        userStates.delete(uid);
    }

    else if (state === 'CEK_RANGE') {
        const args = text.split(/\s+/);
        if(args.length < 3) return ctx.reply('Format: Prefix Start End');
        const [prefix, start, end] = args;
        let nums = [];
        for(let i=parseInt(start); i<=parseInt(end); i++) nums.push(prefix + i);
        const sock = userSessions.get(uid);
        if(!sock) return ctx.reply('❌ WA Belum Konek.');
        processBatchCheck(ctx, nums, sock);
        userStates.delete(uid);
    }

    else if (state === 'ADM_TIME_ID') {
        tempStorage.set(uid, { tid: text });
        userStates.set(uid, 'ADM_TIME_D');
        ctx.reply('Jumlah Hari?');
    } else if (state === 'ADM_TIME_D') {
        const u = db.users[tempStorage.get(uid).tid];
        if (u) {
            u.expired += parseInt(text) * 86400000;
            db.updateUser(u.id, u);
            ctx.reply('✅ Sukses.');
        } else ctx.reply('User not found.');
        userStates.delete(uid);
        UI.menu(ctx);
    }
});

async function processBatchCheck(ctx, nums, sock) {
    const msg = await ctx.reply(`⏳ Checking ${nums.length} numbers...`);
    let business = [], original = [], invalid = [];

    for (let i = 0; i < nums.length; i += 50) {
        const batch = nums.slice(i, i + 50);
        await Promise.all(batch.map(async (n) => {
            const num = n.startsWith('0') ? '62' + n.slice(1) : n;
            try {
                const jid = num + '@s.whatsapp.net';
                const [res] = await sock.onWhatsApp(jid);
                if (res?.exists) {
                    let bio = '-', type = 'whatsapp original';
                    try { const s = await sock.fetchStatus(jid); bio = s?.status || '-'; } catch {}
                    try { if (await sock.getBusinessProfile(jid)) type = 'whatsapp business'; } catch {}
                    const data = { number: num, bio, type };
                    if (type === 'whatsapp business') business.push(data); else original.push(data);
                } else { invalid.push(num); }
            } catch { invalid.push(num); }
        }));
        await delay(1000);
    }

    db.updateStats('checked', nums.length);

    let content = `LAPORAN CEK BIO (Total: ${nums.length})\n\n`;
    if (business.length > 0) {
        content += `whatsapp business\n`;
        business.forEach(r => content += `|--- ${r.number}\n|--- Bio: ${r.bio}\n|--- Verifikasi Meta: Yes\n\n`);
    }
    if (original.length > 0) {
        content += `whatsapp original\n`;
        original.forEach(r => content += `|--- ${r.number}\n|--- Bio: ${r.bio}\n|--- Verifikasi Meta: No\n\n`);
    }
    if (invalid.length > 0) {
        content += `whatsapp number ampas\n---- Tidak Terdaftar ----\n`;
        invalid.forEach(n => content += `${n}\n`);
    }

    const f = `Result_${Date.now()}.txt`;
    fs.writeFileSync(f, content);
    await ctx.replyWithDocument({ source: f }, { caption: `✅ Selesai` });
    fs.unlinkSync(f);
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch {}
}

(async () => {
    console.log('🚀 Starting V36 Complete...');
    await WAManager.loadAll();
    await bot.launch();
    console.log('✅ Bot Online');
})();

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
