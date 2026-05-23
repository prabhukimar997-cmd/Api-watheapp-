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

const SESSION_DIR =
    path.join(__dirname, "sessions");

if (!fs.existsSync(SESSION_DIR)) {

    fs.mkdirSync(SESSION_DIR);

}

// =========================
// CREATE SOCKET
// =========================

async function createSocket(userId) {

    try {

        const authPath =
            path.join(SESSION_DIR, userId);

        const { state, saveCreds } =
            await useMultiFileAuthState(authPath);

        const { version } =
            await fetchLatestBaileysVersion();

        const sock = makeWASocket({

            auth: state,

            version,

            logger: pino({
                level: "silent"
            }),

            browser: Browsers.ubuntu("Chrome"),

            syncFullHistory: false,

            markOnlineOnConnect: false

        });

        sessions[userId] = {

            sock,

            connected: false

        };

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {

            const {
                connection,
                lastDisconnect
            } = update;

            // CONNECTED

            if (connection === "open") {

                sessions[userId].connected = true;

                console.log(`✅ ${userId} Connected`);

            }

            // DISCONNECTED

            else if (connection === "close") {

                sessions[userId].connected = false;

                const reason =
                    lastDisconnect?.error?.output?.statusCode;

                console.log(`❌ ${userId} Disconnected`);

                // LOGOUT

                if (reason === DisconnectReason.loggedOut) {

                    const authFolder =
                        path.join(SESSION_DIR, userId);

                    if (fs.existsSync(authFolder)) {

                        fs.rmSync(authFolder, {
                            recursive: true,
                            force: true
                        });

                    }

                    delete sessions[userId];

                    console.log(`🗑 ${userId} Session Deleted`);

                }

                // AUTO RECONNECT

                else {

                    console.log(`🔄 ${userId} Reconnecting...`);

                    setTimeout(() => {

                        createSocket(userId);

                    }, 5000);

                }
            }

        });

    } catch (err) {

        console.log("Socket Error:", err);

    }
}

// =========================
// HOME
// =========================

app.get("/", (req, res) => {

    res.json({
        status: true,
        message: "Multi User WhatsApp API Running"
    });

});

// =========================
// CREATE SESSION
// =========================

app.get("/create-session", async (req, res) => {

    try {

        const userId = uuidv4();

        await createSocket(userId);

        res.json({
            status: true,
            userId
        });

    } catch (err) {

        res.status(500).json({
            status: false,
            error: err.message
        });

    }

});

// =========================
// PAIR CODE
// =========================

app.get("/pair", async (req, res) => {

    try {

        let {
            userId,
            number
        } = req.query;

        if (!userId || !number) {

            return res.json({
                status: false,
                message: "userId and number required"
            });

        }

        const session =
            sessions[userId];

        if (!session) {

            return res.json({
                status: false,
                message: "Invalid session"
            });

        }

        if (session.connected) {

            return res.json({
                status: true,
                message: "Already connected"
            });

        }

        number =
            number.replace(/[^0-9]/g, "");

        await delay(5000);

        const code =
            await session.sock.requestPairingCode(number);

        res.json({
            status: true,
            code
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            status: false,
            error: err.message
        });
    }

});

// =========================
// STATUS
// =========================

app.get("/status", (req, res) => {

    const { userId } = req.query;

    const session =
        sessions[userId];

    if (!session) {

        return res.json({
            status: false,
            message: "Invalid session"
        });

    }

    res.json({
        status: true,
        connected: session.connected
    });

});

// =========================
// SEND OTP
// =========================

app.get("/send", async (req, res) => {

    try {

        const {
            userId,
            number,
            otp
        } = req.query;

        if (!userId ||
            !number ||
            !otp) {

            return res.json({
                status: false,
                message: "Missing parameters"
            });

        }

        const session =
            sessions[userId];

        if (!session) {

            return res.json({
                status: false,
                message: "Invalid session"
            });

        }

        if (!session.connected) {

            return res.json({
                status: false,
                message: "WhatsApp not connected"
            });

        }

        const cleanNumber =
            number.replace(/[^0-9]/g, "");

        const jid =
            `${cleanNumber}@s.whatsapp.net`;

        await session.sock.sendMessage(jid, {

            text:
`🔐 Your OTP Code: ${otp}

⏳ Valid For 5 Minutes

Do not share this OTP.`

        });

        res.json({
            status: true,
            message: "OTP sent"
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            status: false,
            error: err.message
        });
    }

});

// =========================
// DISCONNECT
// =========================

app.get("/disconnect", async (req, res) => {

    try {

        const { userId } = req.query;

        const session =
            sessions[userId];

        if (!session) {

            return res.json({
                status: false,
                message: "Invalid session"
            });

        }

        await session.sock.logout();

        const authFolder =
            path.join(SESSION_DIR, userId);

        if (fs.existsSync(authFolder)) {

            fs.rmSync(authFolder, {
                recursive: true,
                force: true
            });

        }

        delete sessions[userId];

        res.json({
            status: true,
            message: "Disconnected"
        });

    } catch (err) {

        console.log(err);

        res.status(500).json({
            status: false,
            error: err.message
        });

    }

});

// =========================
// START SERVER
// =========================

app.listen(PORT, () => {

    console.log(`🚀 Server Running On ${PORT}`);

});
