/**
 * Telegram Bot Setup — finds your chat ID and sends a test message.
 *
 * Steps:
 *   1. Create a bot via @BotFather on Telegram and get your token
 *   2. Add TELEGRAM_BOT_TOKEN=your_token to .env
 *   3. Send any message to your bot on Telegram (e.g. /start)
 *   4. Run: node scripts/telegramSetup.mjs
 *
 * The script will auto-detect your chat ID, save it to .env,
 * and send a test message to confirm everything works.
 */

import https from 'https';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('\n❌ TELEGRAM_BOT_TOKEN not set in .env');
  console.error('   Get one from @BotFather on Telegram → /newbot');
  process.exit(1);
}

function tgGet(endpoint) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/bot${TOKEN}/${endpoint}`, { timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function tgPost(endpoint, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${endpoint}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  10000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(e){reject(e);} });
    });
    req.on('error', reject);
    req.on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

console.log('\n=== Telegram Bot Setup ===\n');

// 1. Verify bot token
console.log('Verifying bot token…');
const me = await tgGet('getMe');
if (!me.ok) {
  console.error('❌ Invalid token:', me.description);
  process.exit(1);
}
console.log(`✓ Bot: @${me.result.username} (${me.result.first_name})\n`);

// 2. Find chat ID from recent updates
console.log('Looking for your chat ID…');
const updates = await tgGet('getUpdates?limit=20&timeout=0');
if (!updates.ok || !updates.result?.length) {
  console.error('❌ No messages found.');
  console.error('   → Send any message to your bot on Telegram first, then re-run this script.');
  process.exit(1);
}

// Pick the most recent message with a chat ID
const latest = updates.result
  .filter(u => u.message?.chat?.id)
  .sort((a, b) => b.update_id - a.update_id)[0];

if (!latest) {
  console.error('❌ Could not find a chat ID in recent updates.');
  process.exit(1);
}

const chatId   = String(latest.message.chat.id);
const chatName = latest.message.chat.first_name || latest.message.chat.username || chatId;
console.log(`✓ Found chat: ${chatName} (ID: ${chatId})\n`);

// 3. Save to .env
const envPath = path.join(__dirname, '..', '.env');
let envContent = '';
try { envContent = fs.readFileSync(envPath, 'utf8'); } catch {}

const upsert = (text, key, val) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.trimEnd()}\n${key}=${val}`;
};
envContent = upsert(envContent, 'TELEGRAM_CHAT_ID', chatId);
fs.writeFileSync(envPath, envContent.trimStart() + '\n', 'utf8');
console.log(`✓ TELEGRAM_CHAT_ID=${chatId} saved to .env\n`);

// 4. Send test message
console.log('Sending test message…');
const result = await tgPost('sendMessage', {
  chat_id:    chatId,
  parse_mode: 'HTML',
  text: `✅ <b>Polymarket Bot Connected!</b>

Your BTC Scalp Trader is now linked to this chat.

You'll receive notifications for:
⚡ Every new trade opened
✅ Take profit hit → +$3
❌ Stop loss hit → −$1
⏱ Max hold expired
📊 Session P&L summary

Capital: <b>$40</b>  |  R:R: <b>3:1</b>  |  Mode: <b>LIVE</b>`,
});

if (result.ok) {
  console.log('✅ Test message sent successfully!');
  console.log('\n🎉 Setup complete. Restart the dashboard to activate notifications.\n');
} else {
  console.error('❌ Failed to send test message:', result.description);
}
