// ========== KONFIGURASI BOT ==========

// Konfigurasi Telegram
const TELEGRAM_BOT_TOKEN = '8250992727:AAG2XlCefa-XZPLw9KlaexgnPI0bx-nZ6uE';
const OWNER_ID = 7732520601;
const GROUP_LINK = "https://t.me/stockwalzy";
const VERIFICATION_GROUP_ID = -1003325663954;

// Konfigurasi WhatsApp
const WHATSAPP_EMAIL = "android@support.whatsapp.com";

// Konfigurasi Email
const EMAIL_SENDER = 'wanzlonely04@gmail.com';
const EMAIL_PASSWORD = 'saprudin#1';

// Konfigurasi Cooldown & Limits
const COOLDOWN_DURATION = 100000; // 5 menit
const COOLDOWN_TIME = 1000 * 1000; // 1000 detik untuk semua command
const MAX_RECONNECT_ATTEMPTS = 10;

// Konfigurasi File Database
const MT_FILE = 'mt_texts.json';
const PREMIUM_FILE = 'premium_users.json';
const USER_DB = 'users.json';
const HISTORY_DB = 'history.json';
const BANNED_GROUP_DB = 'banned_groups.json';
const SETTINGS_DB = 'settings.json';
const ALLOWED_FILE = 'allowed.json';
const ADMIN_FILE = 'admin.json';

// Daftar nama acak untuk fitur banding
const RANDOM_NAMES = [
  "Luai", "Ahmad", "Rizky", "Budi", "Sari", "Dewi", "Putra", "Indra", "Rina", "Fajar",
  "Nadia", "Hendra", "Rama", "Sinta", "Doni", "Lina", "Rizki", "Ayu", "Feri", "Dian"
];

// Daftar pesan banding acak dalam berbagai bahasa
const APPEAL_MESSAGES = [
  "Hello WhatsApp team, my name is (NAME). I'm having trouble registering my phone number (+NUMBER). I keep getting a 'login unavailable' error. Please help me resolve this issue.",
  "Hola equipo de WhatsApp, me llamo (NAME). Estoy teniendo problemas para registrar mi número de teléfono (+NUMBER). Aparece el mensaje 'inicio de sesión no disponible'. Por favor, ayúdenme a resolver este problema.",
  "Bonjour l'équipe WhatsApp, je m'appelle (NAME). J'ai des dificultés à enregistrer mon numéro de téléphone (+NUMBER). Le message 'connexion non disponible' aparece. Aidez-moi à résoudre ce problème, s'il vous plaît.",
  "Hallo WhatsApp-Team, mein Name ist (NAME). Ich habe Problems bei der Registrierung meiner Telefonnummer (+NUMBER). Die Meldung 'Anmeldung nicht verfügbar' erscheint. Bitte helfen Sie mir, dieses Problem zu lösen."
];

export {
  TELEGRAM_BOT_TOKEN,
  OWNER_ID,
  GROUP_LINK,
  VERIFICATION_GROUP_ID,
  WHATSAPP_EMAIL,
  EMAIL_SENDER,
  EMAIL_PASSWORD,
  COOLDOWN_DURATION,
  COOLDOWN_TIME,
  MAX_RECONNECT_ATTEMPTS,
  MT_FILE,
  PREMIUM_FILE,
  USER_DB,
  HISTORY_DB,
  BANNED_GROUP_DB,
  SETTINGS_DB,
  ALLOWED_FILE,
  ADMIN_FILE,
  RANDOM_NAMES,
  APPEAL_MESSAGES
};