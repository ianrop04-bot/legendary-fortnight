import { default as makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

// Use /tmp for Vercel
const AUTH_DIR = '/tmp/auth_info';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let isConnected = false;

// Initialize bot
async function initBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.0']
        });
        
        sock.ev.on('connection.update', ({ connection }) => {
            isConnected = connection === 'open';
            console.log('Connection:', connection);
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        console.log('Bot initialized');
    } catch (error) {
        console.error('Bot error:', error);
    }
}

// Start bot
initBot();

// API Endpoints
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        ready: !!sock,
        message: isConnected ? 'Bot is ready!' : 'Bot connecting...'
    });
});

app.post('/api/pair/request', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required' });
    }
    
    if (!sock || !isConnected) {
        return res.status(500).json({ error: 'Bot not ready. Wait 10 seconds.' });
    }
    
    try {
        let formattedNumber = phoneNumber.replace(/\s/g, '');
        if (!formattedNumber.includes('@')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }
        
        const code = await sock.requestPairingCode(formattedNumber);
        
        res.json({
            success: true,
            code: code,
            message: 'Enter this code in WhatsApp'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    
    if (!isConnected || !sock) {
        return res.status(400).json({ error: 'Bot not connected' });
    }
    
    try {
        let formattedNumber = number;
        if (!formattedNumber.includes('@')) {
            formattedNumber = `${formattedNumber}@s.whatsapp.net`;
        }
        
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: 'Sent!' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Bot',
        status: isConnected ? '🟢 Online' : '🔴 Offline',
        endpoints: ['/api/status', '/api/pair/request', '/api/send']
    });
});

export default app;
