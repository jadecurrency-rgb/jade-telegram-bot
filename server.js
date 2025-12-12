const express = require('express');
const app = express();
app.use(express.json());

// ADD THESE 3 LINES — THIS FIXES CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_IDS = [
  process.env.CHANNEL_ID,
  process.env.GROUP_ID
].filter(Boolean);

async function sendToTelegram(text) {
  for (const chatId of CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      });
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message);
    }
  }
}

app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol, round } = req.body;
    console.log("VOTE RECEIVED →", { wallet, amount, projectName, projectSymbol, round });

    const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
    const message = `
New Vote Detected!

Wallet: \`${shortWallet}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${round}

https://jade1.io
    `.trim();

    await sendToTelegram(message);
    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/', (req, res) => res.send('Jade Vote Bot Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
