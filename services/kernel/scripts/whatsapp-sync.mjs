#!/usr/bin/env node
/**
 * WhatsApp Sync Script (Node.js standalone)
 * 
 * Connects to WhatsApp via Baileys, stores messages in Kernl's SQLite DB.
 * 
 * Usage:
 *   node scripts/whatsapp-sync.mjs                    # QR code pairing
 *   node scripts/whatsapp-sync.mjs --phone 1234567890 # Phone number pairing (v7+ only)
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";
import pino from "pino";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const DB_PATH = resolve(DATA_DIR, "kernel.db");
const AUTH_PATH = resolve(DATA_DIR, "whatsapp-auth");

// Logger (suppress verbose baileys logs)
const logger = pino({ level: "warn" });

// Initialize database
const db = new Database(DB_PATH);

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    message_type TEXT NOT NULL DEFAULT 'text',
    is_from_me INTEGER NOT NULL DEFAULT 0,
    is_group INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    raw_data TEXT NOT NULL DEFAULT '{}',
    analyzed INTEGER NOT NULL DEFAULT 0,
    extracted_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  
  CREATE INDEX IF NOT EXISTS idx_wa_chat ON whatsapp_messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_wa_timestamp ON whatsapp_messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_wa_analyzed ON whatsapp_messages(analyzed);
`);

const insertMsg = db.prepare(`
  INSERT OR IGNORE INTO whatsapp_messages 
  (id, chat_id, chat_name, sender_id, sender_name, message, message_type, is_from_me, is_group, timestamp, raw_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

console.log("WhatsApp Sync Script (Baileys 6.x)");
console.log("==================================");
console.log(`Database: ${DB_PATH}`);
console.log(`Auth: ${AUTH_PATH}`);
console.log("");

let messageCount = 0;
let socket = null;

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  socket = makeWASocket({
    auth: state,
    browser: ["Chrome", "Desktop", "127.0.0.0"],
    syncFullHistory: true,
    markOnlineOnConnect: false,
    logger,
  });

  // Handle connection updates
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n========================================");
      console.log("   SCAN THIS QR CODE WITH WHATSAPP");
      console.log("========================================\n");
      qrcode.generate(qr, { small: true });
      console.log("\n1. Open WhatsApp on your phone");
      console.log("2. Go to Settings > Linked Devices");
      console.log("3. Tap 'Link a Device'");
      console.log("4. Scan this QR code\n");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut && reason !== 405;
      
      if (reason === 405) {
        console.log(`\nConnection rejected (405). This may be due to:`);
        console.log(`  1. Rate limiting - wait 10-30 minutes and try again`);
        console.log(`  2. WhatsApp protocol changes`);
        console.log(`  3. Too many failed attempts - clear auth and wait\n`);
        console.log(`To clear auth: rm -rf ${AUTH_PATH}\n`);
        process.exit(1);
      } else if (shouldReconnect) {
        console.log(`Connection closed (${reason}). Reconnecting in 5s...`);
        setTimeout(connectWhatsApp, 5000);
      } else {
        console.log("Logged out. Delete auth folder and restart to re-authenticate.");
        process.exit(1);
      }
    }

    if (connection === "open") {
      const phone = socket.user?.id?.split(":")[0] || "unknown";
      console.log(`\n========================================`);
      console.log(`   CONNECTED AS: ${phone}`);
      console.log(`========================================`);
      console.log("\nListening for messages... (Ctrl+C to stop)\n");
    }
  });

  // Save credentials
  socket.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  socket.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      await processMessage(msg);
    }
  });

  // Handle history sync (old messages)
  socket.ev.on("messaging-history.set", async ({ messages, isLatest }) => {
    console.log(`Received ${messages.length} historical messages (isLatest: ${isLatest})`);
    for (const msg of messages) {
      await processMessage(msg, true);
    }
  });
}

async function processMessage(msg, isHistory = false) {
  try {
    if (!msg.key?.id || !msg.key?.remoteJid) return;
    if (msg.key.remoteJid === "status@broadcast") return;

    const chatId = msg.key.remoteJid;
    const messageId = msg.key.id;
    const isFromMe = msg.key.fromMe || false;
    const isGroup = chatId.endsWith("@g.us");
    const senderId = msg.key.participant || chatId;
    const senderName = msg.pushName || senderId.split("@")[0];
    const timestamp = new Date((msg.messageTimestamp || 0) * 1000).toISOString();

    // Get chat name for groups
    let chatName = "";
    if (isGroup) {
      try {
        const meta = await socket.groupMetadata(chatId);
        chatName = meta?.subject || "";
      } catch {
        chatName = chatId;
      }
    } else {
      chatName = senderName;
    }

    // Extract message content
    let text = "";
    let messageType = "text";
    const content = msg.message;

    if (content) {
      if (content.conversation) {
        text = content.conversation;
      } else if (content.extendedTextMessage?.text) {
        text = content.extendedTextMessage.text;
      } else if (content.imageMessage) {
        text = content.imageMessage.caption || "[Image]";
        messageType = "image";
      } else if (content.videoMessage) {
        text = content.videoMessage.caption || "[Video]";
        messageType = "video";
      } else if (content.audioMessage) {
        text = "[Audio]";
        messageType = content.audioMessage.ptt ? "voice" : "audio";
      } else if (content.documentMessage) {
        text = content.documentMessage.fileName || "[Document]";
        messageType = "document";
      } else if (content.stickerMessage) {
        text = "[Sticker]";
        messageType = "sticker";
      } else if (content.locationMessage) {
        text = `[Location: ${content.locationMessage.degreesLatitude}, ${content.locationMessage.degreesLongitude}]`;
        messageType = "location";
      } else if (content.contactMessage) {
        text = `[Contact: ${content.contactMessage.displayName}]`;
        messageType = "contact";
      }
    }

    if (!text) return;

    // Store in database
    insertMsg.run(
      messageId,
      chatId,
      chatName,
      senderId,
      senderName,
      text,
      messageType,
      isFromMe ? 1 : 0,
      isGroup ? 1 : 0,
      timestamp,
      JSON.stringify({ key: msg.key, pushName: msg.pushName })
    );

    messageCount++;
    
    if (!isHistory) {
      const direction = isFromMe ? "→" : "←";
      const chatLabel = isGroup ? `[${chatName}]` : senderName;
      console.log(`${direction} ${chatLabel}: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`);
    }

    if (messageCount % 100 === 0) {
      console.log(`[${messageCount} messages stored]`);
    }
  } catch (err) {
    console.error("Error processing message:", err.message);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log(`\n\nShutting down... (${messageCount} messages stored)`);
  db.close();
  process.exit(0);
});

// Start
connectWhatsApp().catch(console.error);
