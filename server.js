const express = require('express');
const app = express();
app.use(express.json());

// CORS middleware
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

// Fast RPCs
const RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc.publicnode.com",
  "https://rpc.ankr.com/bsc",
  "https://bscrpc.com",
  "https://bsc-dataseed.binance.org/"
];

const ethers = require('ethers');

const JADE_ADDRESS = "0x330F4fe5ef44B4d0742fE8BED8ca5E29359870DF";

// Round 4 projects (hardcoded, exact from jade1.io)
const PROJECTS = [
  { name: "DOYR", symbol: "DOYR", addr: "0x925c8Ab7A9a8a148E87CD7f1EC7ECc3625864444" },
  { name: "Happy-Sci", symbol: "HAPPY-SCI", addr: "0x03173FBcC63b5f27A6b3d25e03d426d143647777" },
  { name: "ZygoSwap", symbol: "ZSWAP", addr: "0x2e44aB95549b8a12AFDB970bde5A6a78365e4444" },
  { name: "4", symbol: "4", addr: "0x0A43fC31a73013089DF59194872Ecae4cAe14444" },
  { name: "人生K线", symbol: "人生K线", addr: "0x1a1E69F1e6182e2F8b9e8987E83C016ac9444444" },
  { name: "WIKI CAT", symbol: "WKC", addr: "0x6Ec90334d89dBdc89E08A133271be3d104128Edb" },
  { name: "CZ'S DOG", symbol: "Broccoli", addr: "0x6d5AD1592ed9D6D1dF9b93c793AB759573Ed6714" },
  { name: "SHIVA INU", symbol: "SHVA", addr: "0x56aDF7C4f03c093323999d104815A03b3Bb54444" },
  { name: "哈基米", symbol: "哈基米", addr: "0x82Ec31D69b3c289E541b50E30681FD1ACAd24444" },
  { name: "我踏马来了", symbol: "我踏马来了", addr: "0xc51A9250795c0186a6FB4A7D20A90330651e4444" },
  { name: "Nick Shirley Fund", symbol: "NSF", addr: "0x863AFE6eD8E226deE1b9E4f81bb93DA04C082205" },
  { name: "WebKey DAO", symbol: "wkeyDAO", addr: "0x194B302a4b0a79795Fb68E2ADf1B8c9eC5ff8d1F" },
  { name: "BULLA", symbol: "BULLA", addr: "0x595E21b20E78674F8a64C1566A20b2b316Bc3511" },
  { name: "Bnbjak", symbol: "BNBJAK", addr: "0xacc31a5C47A62ea987719943dcc382A455c94444" },
  { name: "Giant", symbol: "GTAN", addr: "0xbD7909318b9Ca4ff140B840F69bB310a785d1095" },
  { name: "ARK", symbol: "ARK", addr: "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D" },
  { name: "CREPE", symbol: "CREPE", addr: "0xeb2B7d5691878627eff20492cA7c9a71228d931D" },
  { name: "Aster", symbol: "ASTER", addr: "0x000Ae314E2A2172a039B26378814C252734f556A" },
  { name: "MYX", symbol: "MYX", addr: "0xD82544bf0dfe8385eF8FA34D67e6e4940CC63e16" },
  { name: "PUP", symbol: "PUP", addr: "0x73b84F7E3901F39FC29F3704a03126D317Ab4444" }
];

let provider = null;
let jadeContract = null;

async function initProvider() {
  for (const url of RPC_URLS) {
    try {
      const temp = new ethers.JsonRpcProvider(url);
      await temp.getBlockNumber();
      provider = temp;
      jadeContract = new ethers.Contract(JADE_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
      console.log(`[SUCCESS] RPC connected: ${url}`);
      break;
    } catch (e) {
      console.warn(`[SKIP] ${url}`);
    }
  }
  if (!provider) console.error("[ERROR] No RPC available");
}

initProvider();

let pinnedMessageId = null;

async function sendToTelegram(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true })
    });
    const data = await res.json();
    console.log(`[TELEGRAM] Sent: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    console.error(`[ERROR] Send failed: ${err.message}`);
    return null;
  }
}

app.post('/vote-webhook', async (req, res) => {
  try {
    const { wallet, amount, projectName, projectSymbol } = req.body;
    const shortWallet = wallet.slice(0,6) + '...' + wallet.slice(-4);
    const message = `🗳 *New Vote Detected!*\n\nWallet: \`${shortWallet}\`\nPower: *${parseFloat(amount).toFixed(4)} JADE*\nProject: *${projectName} (${projectSymbol})*\nRound: #4\n\nhttps://jade1.io`.trim();
    for (const chatId of CHAT_IDS) if (chatId) await sendToTelegram(chatId, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'failed' });
  }
});

async function updateLeaderboard() {
  if (!jadeContract) return console.log("[WARN] No JADE contract");

  try {
    console.log("[DEBUG] Fetching live JADE balances for Round 4...");

    const entries = [];
    let total = 0n;

    for (const p of PROJECTS) {
      const bal = await jadeContract.balanceOf(p.addr).catch(() => 0n);
      const votes = Number(ethers.formatUnits(bal, 18));
      total += bal;
      entries.push({ ...p, votes });
    }

    entries.sort((a, b) => b.votes - a.votes);

    let text = `*Jade1 Live Leaderboard* — Round #4\n`;
    text += `Total Votes: *${Number(ethers.formatUnits(total, 18)).toFixed(0)} JADE*\n\n`;
    text += `Votes = real-time JADE balance held by project\nSend JADE to vote!\n\n`;

    entries.forEach((p, i) => text += `${i+1}. *${p.name} (${p.symbol})* — ${p.votes.toFixed(4)} JADE\n`);

    text += `\nUpdated: ${new Date().toUTCString()}\nhttps://jade1.io`;

    const chat = process.env.CHANNEL_ID;
    if (!chat) return;

    if (!pinnedMessageId) {
      const data = await sendToTelegram(chat, text);
      if (data?.ok) {
        pinnedMessageId = data.result.message_id;
        console.log(`[NEW] Leaderboard ID: ${pinnedMessageId} - PIN THIS`);
      }
    } else {
      const editRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, message_id: pinnedMessageId, text, parse_mode: 'Markdown' })
      });
      const editData = await editRes.json();
      if (!editData.ok) {
        console.log("[EDIT FAIL] Sending new");
        const data = await sendToTelegram(chat, text);
        if (data?.ok) pinnedMessageId = data.result.message_id;
      }
    }
  } catch (err) {
    console.error("[ERROR] Update failed:", err.message);
  }
}

setInterval(updateLeaderboard, 60000);
updateLeaderboard();

app.get('/', (req, res) => res.send('Jade Bot Round #4 Live'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
