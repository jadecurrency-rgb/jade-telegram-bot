const express = require('express');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;

// List of places to send notifications
const CHAT_IDS = [
  process.env.CHANNEL_ID,        // your leaderboard channel (e.g. @jade1_leaderboard)
  process.env.GROUP_ID          // your main group @jadecurrency1
];

async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  for (const chatId of CHAT_IDS) {
    if (!chatId) continue;

    try {
      await fetch(url, {
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
      console.error(`Failed to send to ${chatId}:`, err);
    }
  }
}

app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol, round } = req.body;

    const shortWallet = wallet.slice(0, 6) + '...' + wallet.slice(-4);
    const message = `
🗳 *New Vote Detected!*

Wallet: \`${shortWallet}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${round}

https://jade1.io
    `.trim();

    await sendToTelegram(message);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});
