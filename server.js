const express = require('express');
const app = express();
app.use(express.json());

// CORS
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

// === MANUAL ROUND OVERRIDE (temporary) ===
const MANUAL_ROUND_OVERRIDE = "2";   // ← set to null or "" when contract is reliable
// ========================================

let ethers, provider, votingContract;
try {
  ethers = require('ethers');

  // Reliable fallback RPCs — this fixes most "stopped updating" issues
  provider = new ethers.FallbackProvider([
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.defibit.io/",
    "https://bsc-dataseed1.ninicoin.io/",
    "https://bsc-dataseed2.binance.org/",
    "https://bsc-dataseed3.binance.org/",
    "https://bsc-dataseed4.binance.org/"
  ], 1); // quorum = 1 for speed

  votingContract = new ethers.Contract(
    "0x1144eCa36680aE3fA7a2146b67F0db81A38ac403",
    [
      "function getProjects() view returns (string[20], string[20], address[20], uint256[20])",
      "function currentRound() view returns (uint256)"
    ],
    provider
  );

  console.log("Ethers v6 loaded with FallbackProvider — leaderboard enabled");
} catch (err) {
  console.error("Ethers initialization failed (leaderboard disabled):", err);
}

let pinnedMessageId = null;

async function sendToTelegram(chatId, text, parse_mode = "Markdown") {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true })
    });
    if (!res.ok) throw new Error(`Telegram send failed: ${res.status} - ${await res.text()}`);
  } catch (err) {
    console.error(`Send failed to ${chatId}:`, err.message);
  }
}

async function broadcastVote(message) {
  for (const chatId of CHAT_IDS) await sendToTelegram(chatId, message);
}

// Vote webhook (unchanged)
app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol, round } = req.body;
    console.log("VOTE RECEIVED →", { wallet, amount, projectName, projectSymbol, round });

    const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
    const message = `
🗳 *New Vote Detected!*

Wallet: \`${shortWallet}\`
Power: *${parseFloat(amount).toFixed(4)} JADE*
Project: *${projectName} (${projectSymbol})*
Round: #${round}

https://jade1.io
    `.trim();

    await broadcastVote(message);
    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: 'failed' });
  }
});

// Helper: try contract call with retry
async function tryContractCall(fn, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`Contract call attempt ${attempt} failed:`, err.message);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
    }
  }
}

// Leaderboard update with better resilience
async function updateLeaderboard() {
  if (!votingContract) {
    console.warn("votingContract not initialized — skipping update");
    return;
  }

  try {
    let round;

    if (MANUAL_ROUND_OVERRIDE) {
      round = MANUAL_ROUND_OVERRIDE;
      console.log(`[MANUAL] Using fixed round: #${round}`);
    } else {
      const roundBig = await tryContractCall(() => votingContract.currentRound());
      round = roundBig.toString();
      console.log(`[ON-CHAIN] Current round: #${round}`);
    }

    const projects = await tryContractCall(() => votingContract.getProjects());

    const [names, symbols, _, votesRaw] = projects;

    // Collect valid projects
    const entries = [];
    let totalVotes = 0;
    for (let i = 0; i < 20; i++) {
      if (names[i]?.trim()) {
        const votes = Number(ethers.formatUnits(votesRaw[i] || 0n, 18));
        totalVotes += votes;
        entries.push({
          name: names[i].trim(),
          symbol: symbols[i].trim(),
          votes
        });
      }
    }

    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #${round}\n`;
    text += `Total Votes: *${totalVotes.toFixed(0)} JADE*\n\n`;

    for (let i = 0; i < Math.min(entries.length, 20); i++) {
      const p = entries[i];
      text += `${i + 1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`;
    }

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const leaderboardChat = process.env.CHANNEL_ID;
    if (!leaderboardChat) {
      console.warn("CHANNEL_ID not set — skipping Telegram update");
      return;
    }

    // Send new or edit existing
    if (!pinnedMessageId) {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: leaderboardChat, text, parse_mode: 'Markdown' })
      });
      const data = await res.json();
      if (data.ok) {
        pinnedMessageId = data.result.message_id;
        console.log("New leaderboard sent & should be pinned → ID:", pinnedMessageId);
      } else {
        console.error("Send failed:", data);
      }
    } else {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: leaderboardChat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
        });
        console.log("Leaderboard edited successfully");
      } catch (editErr) {
        console.error("Edit failed — resetting pinnedMessageId:", editErr.message);
        pinnedMessageId = null; // next time send new one
      }
    }
  } catch (err) {
    console.error("Leaderboard update failed:", err);
    console.error("Full stack:", err.stack);
    if (err.code) console.error("Error code:", err.code);
    if (err.reason) console.error("Revert reason:", err.reason);
  }
}

// Run every 60 seconds
setInterval(updateLeaderboard, 60000);
updateLeaderboard(); // initial run

app.get('/', (req, res) => res.send('Jade Bot + Live Leaderboard Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
