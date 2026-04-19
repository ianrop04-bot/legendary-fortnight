import express from 'express';
import cors from 'cors';
import { default as makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

// Session storage
const AUTH_DIR = '/tmp/auth_info';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let connected = false;

// Auto-start bot
(async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Chrome', 'Windows', '10.0']
        });
        
        sock.ev.on('connection.update', ({ connection }) => {
            connected = connection === 'open';
            console.log('Status:', connection);
        });
        
        sock.ev.on('creds.update', saveCreds);
        
    } catch (err) {
        console.error('Bot error:', err);
    }
})();

// Status endpoint
app.get('/api/status', (req, res) => {
    res.json({ 
        connected: connected,
        ready: connected
    });
});

// Get pairing code
app.post('/api/pair/request', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required' });
    }
    
    if (!sock || !connected) {
        return res.status(503).json({ error: 'Bot starting, wait 10 seconds' });
    }
    
    try {
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        
        res.json({ 
            success: true, 
            code: code 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send message
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    
    if (!connected || !sock) {
        return res.status(503).json({ error: 'Bot not connected' });
    }
    
    try {
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: connected ? 'online' : 'starting' });
});

export default app;
