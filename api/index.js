// ============ VERCEL WHATSAPP BOT - NO REDIS NEEDED ============
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const cors= require('cors')
const app = express();
app.use(cors())
app.use(express.json());


// Use /tmp directory (Vercel allows read/write here)
const TMP_DIR = '/tmp/whatsapp-auth';
const AUTH_FILE = path.join(TMP_DIR, 'creds.json');

// Ensure temp directory exists
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Global variables
let sock = null;
let botStatus = {
    connected: false,
    ready: false,
    lastActivity: Date.now()
};

let keepAliveInterval = null;

// ============ FILE-BASED SESSION STORAGE ============
async function loadAuthFromFile() {
    try {
        if (fs.existsSync(AUTH_FILE)) {
            const data = fs.readFileSync(AUTH_FILE, 'utf8');
            const auth = JSON.parse(data);
            console.log('✅ Loaded auth from /tmp');
            return auth;
        }
    } catch (error) {
        console.log('No existing auth found:', error.message);
    }
    return null;
}

async function saveAuthToFile(creds) {
    try {
        fs.writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2));
        console.log('💾 Auth saved to /tmp');
        return true;
    } catch (error) {
        console.error('Failed to save auth:', error.message);
        return false;
    }
}

// ============ BOT INITIALIZATION ============
async function startBot() {
    console.log('🤖 Starting WhatsApp Bot on Vercel...');
    
    try {
        // Load existing auth from /tmp
        const savedAuth = await loadAuthFromFile();
        
        const sockConfig = {
            browser: ['Vercel', 'Serverless', '1.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 20000, // Shorter keep-alive for Vercel
            // Use saved auth if exists
            auth: savedAuth || undefined
        };
        
        sock = makeWASocket(sockConfig);
        
        // Connection handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('📱 QR Code for initial pairing');
                qrcode.generate(qr, { small: true });
                botStatus.ready = false;
            }
            
            if (connection === 'open') {
                botStatus.connected = true;
                botStatus.ready = true;
                botStatus.lastActivity = Date.now();
                console.log('✅✅✅ BOT CONNECTED SUCCESSFULLY! ✅✅✅');
                
                // Save credentials immediately
                if (sock.authState && sock.authState.creds) {
                    await saveAuthToFile(sock.authState.creds);
                }
                
                startKeepAlive();
            }
            
            if (connection === 'close') {
                botStatus.connected = false;
                botStatus.ready = false;
                console.log('❌ Connection closed');
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('Logged out, clearing auth...');
                    if (fs.existsSync(AUTH_FILE)) {
                        fs.unlinkSync(AUTH_FILE);
                    }
                } else {
                    console.log('Reconnecting in 3 seconds...');
                    setTimeout(startBot, 3000);
                }
            }
        });
        
        // Save credentials when updated
        sock.ev.on('creds.update', async (creds) => {
            console.log('📝 Credentials updated, saving...');
            await saveAuthToFile(creds);
        });
        
        // Message handler
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            botStatus.lastActivity = Date.now();
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const sender = msg.key.remoteJid;
            
            console.log(`📩 Message: ${text.substring(0, 50)}`);
            
            // Auto-reply to keep session alive
            if (text.toLowerCase() === 'ping') {
                await sock.sendMessage(sender, { text: 'pong! 🏓' });
            }
            
            if (text.toLowerCase() === 'status') {
                await sock.sendMessage(sender, { 
                    text: `🤖 Bot is online!\nConnected: ${botStatus.connected}\nUptime: ${Math.floor((Date.now() - botStatus.lastActivity) / 1000)}s` 
                });
            }
        });
        
    } catch (error) {
        console.error('❌ Bot error:', error);
        setTimeout(startBot, 5000);
    }
}

function startKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    
    // Send presence every 20 seconds
    keepAliveInterval = setInterval(() => {
        if (sock && botStatus.connected) {
            sock.sendPresenceUpdate('available')
                .catch(() => {
                    console.log('Keep-alive failed');
                });
            console.log('💓 Heartbeat sent');
        }
    }, 20000);
}

// ============ API ROUTES ============

// Status endpoint
app.get('/api/status', (req, res) => {
    res.json({
        connected: botStatus.connected,
        ready: botStatus.ready,
        lastActivity: botStatus.lastActivity,
        hasAuth: fs.existsSync(AUTH_FILE),
        tmpDirSize: fs.existsSync(TMP_DIR) ? fs.readdirSync(TMP_DIR).length : 0
    });
});

// Pairing code request
app.post('/api/pair/request', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required' });
    }
    
    if (!sock) {
        return res.status(500).json({ error: 'Bot initializing. Wait 5 seconds.' });
    }
    
    try {
        let formattedNumber = phoneNumber.replace(/\s/g, '');
        if (!formattedNumber.includes('@')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }
        
        console.log(`📱 Requesting code for: ${formattedNumber}`);
        const pairCode = await sock.requestPairingCode(formattedNumber);
        
        console.log(`✅ Pairing code: ${pairCode}`);
        res.json({ success: true, code: pairCode });
        
    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send message
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    
    if (!botStatus.connected || !sock) {
        return res.status(400).json({ error: 'Bot not connected' });
    }
    
    try {
        let formattedNumber = number;
        if (!formattedNumber.includes('@')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }
        
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: 'Message sent!' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Force reconnection (useful for Vercel)
app.post('/api/reconnect', async (req, res) => {
    console.log('Manual reconnect requested');
    if (sock) {
        try {
            await sock.logout();
        } catch(e) {}
    }
    botStatus.connected = false;
    setTimeout(() => startBot(), 1000);
    res.json({ success: true, message: 'Reconnecting...' });
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'alive',
        botConnected: botStatus.connected,
        timestamp: Date.now(),
        tmpExists: fs.existsSync(TMP_DIR)
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START BOT ============
console.log('🚀 Initializing WhatsApp Bot on Vercel...');
startBot();

// Keep warm with ping (self-ping every 4 minutes)
setInterval(() => {
    if (!botStatus.connected) {
        console.log('⚠️ Bot disconnected, attempting restart...');
        startBot();
    }
}, 240000);

// Export for Vercel
module.exports = app;
