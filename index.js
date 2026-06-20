const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    delay
} = require("@whiskeysockets/baileys");

const express = require("express");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();

const PORT = process.env.PORT || 10000;

const sessions = {};

const SESSION_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR);
}

// =========================
// CREATE SOCKET
// =========================

async function createSocket(userId) {
    try {
        console.log(`\n🔵 [${userId}] Creating new socket...`);

        const authPath = path.join(SESSION_DIR, userId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`📦 [${userId}] Baileys Version: ${version}`);

        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sessions[userId] = { sock, connected: false };

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            console.log(`🟡 [${userId}] Connection Update: ${connection}`);

            if (connection === "open") {
                sessions[userId].connected = true;
                console.log(`✅ [${userId}] CONNECTED SUCCESSFULLY`);
            } 
            else if (connection === "close") {
                sessions[userId].connected = false;
                const reason = lastDisconnect?.error?.output?.statusCode;
                
                console.log(`❌ [${userId}] DISCONNECTED`);
                console.log(`🔴 [${userId}] Reason Code: ${reason}`);
                
                if (lastDisconnect?.error) {
                    console.log(`🔴 [${userId}] Error Details:`, JSON.stringify(lastDisconnect.error, null, 2));
                }

                if (reason === DisconnectReason.loggedOut) {
                    console.log(`🗑 [${userId}] LOGGED OUT - Deleting session...`);
                    const authFolder = path.join(SESSION_DIR, userId);
                    if (fs.existsSync(authFolder)) {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                    }
                    delete sessions[userId];
                    console.log(`🗑 [${userId}] Session deleted successfully`);
                } 
                else {
                    console.log(`🔄 [${userId}] Auto-reconnecting in 5 seconds...`);
                    setTimeout(() => { 
                        console.log(`🔄 [${userId}] Reconnection attempt started`);
                        createSocket(userId); 
                    }, 5000);
                }
            }
        });

    } catch (err) {
        console.log(`💥 [${userId}] Socket Creation Error:`, err.message);
        console.log(`💥 Full Error:`, err);
    }
}

// =========================
// HOME
// =========================

app.get("/", (req, res) => {
    console.log(`🏠 Home endpoint hit`);
    res.json({ status: true, message: "Multi User WhatsApp API Running" });
});

// =========================
// CREATE SESSION
// =========================

app.get("/create-session", async (req, res) => {
    try {
        const userId = uuidv4();
        console.log(`🆕 Creating new session: ${userId}`);
        await createSocket(userId);
        res.json({ status: true, userId });
    } catch (err) {
        console.log(`💥 Create session error:`, err.message);
        res.status(500).json({ status: false, error: err.message });
    }
});

// =========================
// PAIR CODE
// =========================

app.get("/pair", async (req, res) => {
    try {
        let { userId, number } = req.query;
        
        console.log(`\n🔑 PAIR REQUEST`);
        console.log(`📱 UserID: ${userId}`);
        console.log(`📱 Number: ${number}`);

        if (!userId || !number) {
            console.log(`❌ Missing userId or number`);
            return res.json({ status: false, message: "userId and number required" });
        }

        const session = sessions[userId];

        if (!session) {
            console.log(`❌ Session not found for ${userId}`);
            return res.json({ status: false, message: "Invalid session" });
        }

        if (session.connected) {
            console.log(`⚠️ Already connected for ${userId}`);
            return res.json({ status: true, message: "Already connected" });
        }

        number = number.replace(/[^0-9]/g, "");
        console.log(`🧹 Clean Number: ${number}`);
        
        await delay(5000);
        console.log(`🔄 Requesting pairing code...`);

        const code = await session.sock.requestPairingCode(number);
        console.log(`✅ Pairing code generated: ${code.substring(0, 4)}-****`);

        res.json({ status: true, code });

    } catch (err) {
        console.log(`💥 Pair Error:`, err.message);
        console.log(`💥 Full Error:`, err);
        res.status(500).json({ status: false, error: err.message });
    }
});

// =========================
// STATUS
// =========================

app.get("/status", (req, res) => {
    const { userId } = req.query;
    const session = sessions[userId];
    
    console.log(`📊 Status check for: ${userId}`);

    if (!session) {
        console.log(`❌ Session not found`);
        return res.json({ status: false, message: "Invalid session" });
    }

    console.log(`✅ Connected: ${session.connected}`);
    res.json({ status: true, connected: session.connected });
});

// =========================
// SEND OTP (✅ FIXED WITH FULL DEBUG)
// =========================

app.get("/send", async (req, res) => {
    try {
        const { userId, number, otp } = req.query;

        console.log(`\n========================================`);
        console.log(`📨 OTP SEND REQUEST STARTED`);
        console.log(`========================================`);
        console.log(`👤 UserID: ${userId}`);
        console.log(`📱 Target Number (raw): ${number}`);
        console.log(`🔢 OTP: ${otp}`);

        // --- Validation ---
        if (!userId || !number || !otp) {
            console.log(`❌ Missing parameters`);
            return res.json({ status: false, message: "Missing parameters" });
        }

        const session = sessions[userId];
        console.log(`🔍 Looking for session: ${userId}`);

        if (!session) {
            console.log(`❌ Session not found in memory`);
            console.log(`📋 Active sessions:`, Object.keys(sessions));
            return res.json({ status: false, message: "Invalid session" });
        }

        console.log(`✅ Session found`);
        console.log(`🔌 Connected status: ${session.connected}`);

        if (!session.connected) {
            console.log(`❌ WhatsApp not connected`);
            return res.json({ status: false, message: "WhatsApp not connected" });
        }

        // --- Prepare Number ---
        const cleanNumber = number.replace(/[^0-9]/g, "");
        const jid = `${cleanNumber}@s.whatsapp.net`;
        
        console.log(`🧹 Clean Number: ${cleanNumber}`);
        console.log(`📧 JID: ${jid}`);

        // --- Get Sender Info ---
        try {
            const userInfo = session.sock.user;
            console.log(`📱 Sender Number: ${userInfo?.id?.split(':')[0]}`);
        } catch (e) {
            console.log(`⚠️ Could not get sender info`);
        }

        // ============ PLAN B FIX WITH DETAILED LOGGING ============
        
        // Step 1: Send "composing" status
        console.log(`\n📝 STEP 1: Sending "composing" presence...`);
        try {
            await session.sock.sendPresenceUpdate("composing", jid);
            console.log(`✅ "composing" sent successfully`);
        } catch (e) {
            console.log(`❌ "composing" failed:`, e.message);
        }
        
        await delay(2000);
        console.log(`⏰ Waited 2 seconds`);

        // Step 2: Send "paused" status
        console.log(`\n📝 STEP 2: Sending "paused" presence...`);
        try {
            await session.sock.sendPresenceUpdate("paused", jid);
            console.log(`✅ "paused" sent successfully`);
        } catch (e) {
            console.log(`❌ "paused" failed:`, e.message);
        }
        
        await delay(1000);
        console.log(`⏰ Waited 1 second`);

        // Step 3: Subscribe to presence
        console.log(`\n📝 STEP 3: Subscribing to presence...`);
        try {
            await session.sock.presenceSubscribe(jid);
            console.log(`✅ presenceSubscribe successful`);
        } catch (e) {
            console.log(`⚠️ presenceSubscribe warning:`, e.message);
        }
        
        await delay(1500);
        console.log(`⏰ Waited 1.5 seconds`);

        // Step 4: Send OTP
        console.log(`\n📝 STEP 4: Sending OTP message...`);
        
        const messageText = `🔐 Your OTP Code: ${otp}\n\n⏳ Valid For 5 Minutes\n\nDo not share this OTP.`;
        
        try {
            const result = await session.sock.sendMessage(jid, {
                text: messageText
            });
            
            console.log(`✅ Message send result:`, JSON.stringify(result, null, 2));
            
            // Check if it actually went through
            if (result?.key?.id) {
                console.log(`✅ MESSAGE SENT SUCCESSFULLY`);
                console.log(`📨 Message ID: ${result.key.id}`);
                console.log(`📨 Remote JID: ${result.key.remoteJid}`);
            }
            
        } catch (e) {
            console.log(`❌ Send message error:`, e.message);
            console.log(`❌ Full error:`, JSON.stringify(e, null, 2));
            throw e;
        }

        console.log(`\n========================================`);
        console.log(`✅ OTP PROCESS COMPLETED`);
        console.log(`========================================\n`);

        res.json({ status: true, message: "OTP sent" });

    } catch (err) {
        console.log(`\n💥 FINAL ERROR:`, err.message);
        console.log(`💥 Stack:`, err.stack);
        console.log(`========================================\n`);
        
        res.status(500).json({ 
            status: false, 
            error: err.message,
            stack: err.stack 
        });
    }
});

// =========================
// DISCONNECT
// =========================

app.get("/disconnect", async (req, res) => {
    try {
        const { userId } = req.query;
        console.log(`\n🔌 DISCONNECT REQUEST: ${userId}`);
        
        const session = sessions[userId];

        if (!session) {
            console.log(`❌ Session not found`);
            return res.json({ status: false, message: "Invalid session" });
        }

        console.log(`🔄 Logging out...`);
        await session.sock.logout();

        const authFolder = path.join(SESSION_DIR, userId);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
            console.log(`🗑 Session files deleted`);
        }

        delete sessions[userId];
        console.log(`✅ Disconnected successfully`);

        res.json({ status: true, message: "Disconnected" });

    } catch (err) {
        console.log(`💥 Disconnect error:`, err.message);
        res.status(500).json({ status: false, error: err.message });
    }
});

// =========================
// START SERVER
// =========================

app.listen(PORT, () => {
    console.log(`\n🚀 SERVER STARTED`);
    console.log(`🔗 PORT: ${PORT}`);
    console.log(`📁 Session Directory: ${SESSION_DIR}`);
    console.log(`👥 Active Sessions: 0\n`);
});
