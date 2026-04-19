// ============ WHATSAPP BOT API FOR VERCEL (ES MODULES) ============
import { default: makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ============ CORS CONFIGURATION ============
app.use(cors({
    origin: '*', // Allow all origins (change in production)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Use /tmp for Vercel (writable directory)
const TMP_DIR = '/tmp/auth_info';
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Global variables
let sock = null;
let botStatus = {
    connected: false,
    ready: false,
    startTime: Date.now(),
    messagesReceived: 0,
    messagesSent: 0
};

// Store pairing codes
const activePairs = new Map();

// ============ BOT INITIALIZATION ============
async function startBot() {
    console.log('🤖 Starting bot on Vercel...');
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(TMP_DIR);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Vercel', 'Serverless', '1.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false
        });
        
        // Connection handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                botStatus.connected = true;
                botStatus.ready = true;
                botStatus.startTime = Date.now();
                console.log('✅ Bot connected!');
            }
            
            if (connection === 'close') {
                botStatus.connected = false;
                botStatus.ready = false;
                console.log('❌ Connection closed');
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(startBot, 5000);
                }
            }
        });
        
        // Save credentials
        sock.ev.on('creds.update', saveCreds);
        
        // Message handler
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            botStatus.messagesReceived++;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const sender = msg.key.remoteJid;
            
            console.log(`📩 Message from ${sender}: ${text.substring(0, 50)}`);
            
            // Auto-reply
            if (text.toLowerCase() === 'ping') {
                await sock.sendMessage(sender, { text: 'pong! 🏓' });
                botStatus.messagesSent++;
            }
            
            if (text.toLowerCase() === 'status') {
                await sock.sendMessage(sender, { 
                    text: `🤖 Bot Status:\nConnected: ${botStatus.connected}\nUptime: ${Math.floor((Date.now() - botStatus.startTime) / 1000)}s` 
                });
                botStatus.messagesSent++;
            }
        });
        
        console.log('✅ Bot ready for pairing!');
        
    } catch (error) {
        console.error('❌ Bot error:', error);
        setTimeout(startBot, 10000);
    }
}

// Start bot
startBot();

// ============ API ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: botStatus.connected,
        ready: botStatus.ready,
        uptime: Math.floor((Date.now() - botStatus.startTime) / 1000),
        timestamp: new Date().toISOString()
    });
});

// Get bot status
app.get('/api/status', (req, res) => {
    res.json({
        connected: botStatus.connected,
        ready: botStatus.ready,
        uptime: Math.floor((Date.now() - botStatus.startTime) / 1000),
        messagesReceived: botStatus.messagesReceived,
        messagesSent: botStatus.messagesSent,
        activePairs: activePairs.size
    });
});

// Request pairing code
app.post('/api/pair/request', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ 
            success: false, 
            error: 'Phone number required' 
        });
    }
    
    if (!sock || !botStatus.connected) {
        return res.status(500).json({ 
            success: false, 
            error: 'Bot not connected. Wait a few seconds.' 
        });
    }
    
    try {
        let formattedNumber = phoneNumber.replace(/\s/g, '');
        if (!formattedNumber.includes('@')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }
        
        console.log(`📱 Requesting pairing code for: ${formattedNumber}`);
        const pairCode = await sock.requestPairingCode(formattedNumber);
        
        console.log(`✅ Pairing code: ${pairCode}`);
        
        activePairs.set(formattedNumber, {
            code: pairCode,
            expires: Date.now() + 5 * 60 * 1000,
            phoneNumber: phoneNumber
        });
        
        res.json({
            success: true,
            code: pairCode,
            message: 'Pairing code generated! Enter this code in WhatsApp.',
            expiresIn: 300
        });
        
    } catch (error) {
        console.error('❌ Pairing error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Check pairing status
app.get('/api/pair/status/:phoneNumber', (req, res) => {
    const { phoneNumber } = req.params;
    const jid = `${phoneNumber}@s.whatsapp.net`;
    const pairData = activePairs.get(jid);
    
    if (pairData && pairData.expires > Date.now()) {
        res.json({
            success: true,
            hasActiveCode: true,
            code: pairData.code,
            expiresIn: Math.floor((pairData.expires - Date.now()) / 1000),
            botConnected: botStatus.connected
        });
    } else {
        res.json({
            success: true,
            hasActiveCode: false,
            botConnected: botStatus.connected
        });
    }
});

// Send message
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    
    if (!botStatus.connected || !sock) {
        return res.status(400).json({ 
            success: false, 
            error: 'Bot not connected' 
        });
    }
    
    if (!number || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Number and message required' 
        });
    }
    
    try {
        let formattedNumber = number;
        if (!formattedNumber.includes('@')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }
        
        await sock.sendMessage(formattedNumber, { text: message });
        botStatus.messagesSent++;
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Broadcast to all chats
app.post('/api/broadcast', async (req, res) => {
    const { message } = req.body;
    
    if (!botStatus.connected || !sock) {
        return res.status(400).json({ 
            success: false, 
            error: 'Bot not connected' 
        });
    }
    
    try {
        const chats = sock.chats || [];
        let sent = 0;
        
        for (const chat of chats) {
            if (chat.id && !chat.id.includes('g.us')) {
                await sock.sendMessage(chat.id, { text: message });
                sent++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        botStatus.messagesSent += sent;
        
        res.json({
            success: true,
            sent: sent,
            total: chats.length
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        botStatus.connected = false;
        botStatus.ready = false;
        
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Bot API',
        version: '2.0.0',
        status: botStatus.connected ? 'connected' : 'disconnected',
        endpoints: {
            health: 'GET /health',
            status: 'GET /api/status',
            pair: 'POST /api/pair/request',
            pairStatus: 'GET /api/pair/status/:phoneNumber',
            send: 'POST /api/send',
            broadcast: 'POST /api/broadcast',
            logout: 'POST /api/logout'
        },
        usage: {
            pair: {
                method: 'POST',
                url: '/api/pair/request',
                body: { phoneNumber: '1234567890' }
            },
            send: {
                method: 'POST',
                url: '/api/send',
                body: { number: '1234567890', message: 'Hello!' }
            }
        }
    });
});

// ============ EXPORT FOR VERCEL ============
export default app;
