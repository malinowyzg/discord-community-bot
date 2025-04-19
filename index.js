const { Client, GatewayIntentBits, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, } = require('discord.js');
const mongoose = require('mongoose');
const express = require('express'); // ✅ <-- ADD THIS LINE
const stealCooldowns = new Map(); // userId → timestamp
const wantedMap = new Map(); // userId -> { fails: Number, watched: Boolean }
const hideoutMap = new Map(); // userId → timestamp when hideout expires
const crimeStreaks = new Map(); // userId → { success: n, fail: n }
const heatMap = new Map(); // userId → { heat: 0–100, lastActivity: timestamp }
const pvpTasks = new Map(); // userId => { crimes: 0, lastReset: Date }
const survivalAchievements = new Set(); // userIds who survived theft with rare items
const playerAchievements = new Map(); // userId => Set of achievementIds
const pvpStats = new Map(); // userId => { bounties: 0, pvpWins: 0, hideouts: 0, survived: 0 }
const crimeBadges = new Map(); // userId => { badge: "Name", icon: "🔥", expires: timestamp }
const gangMap = new Map();
// 🌍 Turf Zones
const turfZones = new Map(); // { zoneId: { owner: 'heist', lastRaid: timestamp } }
const turfRaidCooldowns = new Map(); // { userId: timestamp }
// 🛡️ Fortification Tracker
const turfFortifications = new Map(); // zone => fortification level (0–3)
const scavengeCooldowns = new Map(); // userId → timestamp
const winStreaks = new Map(); // userId → { streak: Number, lastWinTime: timestamp }
const fireBuffs = new Map(); // userId → { xpBoost: Number, expiresAt: timestamp }
const lootboxCooldowns = new Map(); // userId → timestamp
const itemComboTracker = new Map(); // userId → [last3Items]
const comboBuffs = new Map(); // userId → { expiresAt, bonuses }
const raidStrikes = new Map(); // userId => number of raids survived
const prisonUsers = new Map(); // userId => prisonReleaseTimestamp
const prisonBalances = new Map(); // userId => confiscated amount
const prisonQuests = new Map(); // userId → cooldown timestamp


const npcNames = [
  'SlimyLenny', 'Momo', 'ShadyRico', 'JailhouseKev', 'TinyTony',
  'SneakyDee', 'GhostRay', 'TrapBobby', 'ElGato', 'NailsMarv',
  'BackdoorDon', 'LilDrip', 'TwitchySteve', 'StacksMiguel', 'BoomerangJoe',
  'WraithNiko', 'VelvetVic', 'SouthsideAli', 'FakeJerry', 'SwitchbladeCruz',
  'QuickKash', 'SlyJuan', 'NoEyesNate', '3rdShiftShawn', 'YungCrumbs',
  'CreditCarl', 'DiceyDan', 'TokyoSlim', 'ZazaKai', 'MetroLuther',
  'BasementTrey', 'MuffinFace', 'BlackMarketBev', 'JuJuFlex', 'PlugsyRick',
  'LowBatteryLou', 'WhisperKev', 'OffGridManny', 'ChapoTwin', 'FishscaleFinn',
  'SleepyOx', 'RogueAmir', 'StickyNick', 'EchoDre', 'HazmatLeo',
  'FugaziFred', 'DustyDrew', 'WiretapWes', 'HoodieDaz', 'CrumbsClay'
];

// Initial Turf Setup
turfZones.set("Downtown", { owner: "heist", lastRaid: 0 });
turfZones.set("Back Alley", { owner: "bribe", lastRaid: 0 });
turfZones.set("Warehouse", { owner: "bounty", lastRaid: 0 });


require('dotenv').config();

// Helper: Convert XP to Level
function getLevelFromXP(xp) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

function getHeatRank(heat) {
  if (heat >= 100) return "☠️ Infamous";
  if (heat >= 75) return "🔥 Hot";
  if (heat >= 40) return "🟡 Warm";
  return "🔴 Cold";
}

function updateWinStreak(userId, didWin) {
  const streak = winStreaks.get(userId) || { streak: 0, lastWinTime: 0 };
  const now = Date.now();

  if (didWin) {
    const newStreak = now - streak.lastWinTime > 10 * 60 * 1000 ? 1 : streak.streak + 1;
    winStreaks.set(userId, { streak: newStreak, lastWinTime: now });

    // 🔥 Trigger buff at 3 or more
    if (newStreak === 3 || newStreak === 5 || newStreak === 10) {
      fireBuffs.set(userId, {
        xpBoost: newStreak >= 10 ? 2 : newStreak >= 5 ? 1.75 : 1.5,
        expiresAt: now + 10 * 60 * 1000 // lasts 10 mins
      });
    }

    return newStreak;
  } else {
    winStreaks.set(userId, { streak: 0, lastWinTime: 0 });
    fireBuffs.delete(userId); // lose buff
    return 0;
  }
}


function unlockAchievement(userId, name, icon, message, channel) {
  const userAchieves = playerAchievements.get(userId) || new Set();
  if (userAchieves.has(name)) return;

  userAchieves.add(name);
  playerAchievements.set(userId, userAchieves);

  const embed = new EmbedBuilder()
    .setTitle(`${icon} Real Achievement Unlocked!`)
    .setDescription(`**${name}**\n${message}`)
    .setColor('#ffd700')
    .setFooter({ text: 'Real Achievements System' })
    .setTimestamp();

  channel.send({ content: `<@${userId}>`, embeds: [embed] });
}

function setCrimeBadge(userId, name, icon, durationMs = 3 * 24 * 60 * 60 * 1000) {
  crimeBadges.set(userId, {
    badge: name,
    icon,
    expires: Date.now() + durationMs,
  });
}

function getGangEmoji(gangId) {
  const gangEmojis = {
    heist: "🎭",
    bribe: "💵",
    bounty: "💣",
    challenge: "🏆"
  };
  return gangEmojis[gangId] || "❓";
}


// after this line 👇
const app = require('./keep_alive');

// now it's safe to add this 👇
app.use('/sharedphotos', express.static('public/sharedphotos'));

// Webhooks & Keep Alive

const stripeWebhook = require('./payments/stripe');
const paypalWebhook = require('./payments/paypal');

const Levels = require("discord-xp");
Levels.setURL(process.env.MONGODB_URI); // Using same MongoDB

const FINANCE_CHANNEL_ID = '1362077468076539904';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

global.client = client; // So Stripe/Paypal access your client
global.dealerProfiles = global.dealerProfiles || new Map();

const { Currency, getBalance, addCash, removeCash } = require('./economy/currency');
const games = require('./economy/games');
const { getRandomItem } = require('./economy/items');
const { addItem, removeItem, getInventory, Inventory } = require('./economy/inventory');
const { rotatingShop, refreshShop, shopItems } = require('./economy/shop');
const cron = require('node-cron');
const Ticket = require('./economy/ticket');
const Pool = require('./economy/pool');
const { triggerDrama } = require('./economy/drama');
const { getTopWinners } = require('./economy/bettingStats');
const { getUserHistory } = require('./economy/bettingHistory');
const { getTodayGames } = require('./economy/nbaGames');
const { createChallenge, acceptChallenge } = require('./economy/p2pBets');
const { recentGames } = require('./economy/nbaGames');
const { placeBet } = require('./economy/betting');
const { resolveFinishedGames } = require('./economy/autoResolve');
const { getJackpotAmount, getLastWinner } = require('./economy/jackpot');
const { hasPaidForSubmission } = require('./economy/musicPayCheck.js');
const { buildRealTeamStats, simpleLogicPredict, runDailyPredictions } = require('./economy/sportsPredict');
const { scanTicker } = require('./economy/financeIntel');
const { scanOptionsFlow } = require('./economy/flowIntel');
const { addTrackedTicker, getAllSnipers, getTrackedTickers } = require('./economy/sniperTargets');
const { scanAllSnipers } = require('./economy/flowIntel');
const { getSniperRotation } = require('./economy/sniperTargets');
const realShopItems = require('./economy/realShopItems');
const TokenModel = require('./economy/bettingStatsModel');
const { startRandomChaos } = require('./economy/chaosEvents');


let todaySnipes = [];

// Drug definitions
const drugs = [
  { id: 'weed', name: '🌿 Weed', base: 150, volatility: 50 },
  { id: 'meth', name: '💎 Meth', base: 1300, volatility: 600 },
  { id: 'acid', name: '🌀 Acid', base: 800, volatility: 300 },
  { id: 'heroin', name: '🩸 Heroin', base: 1800, volatility: 700 },
  { id: 'shrooms', name: '🍄 Shrooms', base: 400, volatility: 150 }
];

const welcomeMessages = [
  "👋 Welcome to the party, <@USER>!",
  "💎 Fresh player... <@USER> has entered the arena.",
  "😎 Oh crap, <@USER> just pulled up.",
  "🔥 Bless the chat, <@USER> just arrived.",
  "📦 <@USER> unpacked their inventory and joined us.",
  "👀 Another challenger appears: <@USER>",
  "💰 Someone tell <@USER> the rent is due every day in here.",
  "😤 Hope you're ready for good ideas, <@USER>.",
  "⚡ New player joined: <@USER>. Stats loading...",
  "🎭 <@USER> just walked in like we weren't talking about them.",
  "🎟️ Admit one chaos ticket: <@USER>",
  "🍀 Lucky <@USER> showed up... or unlucky?",
  "💬 What's up, <@USER>? Don't trust anyone btw.",
  "🕶️ <@USER> entered the simulation.",
  "🔮 Someone check <@USER>'s energy. Feels high rank.",
  "🎲 Roll the dice... <@USER> is live.",
  "📡 Signal detected: <@USER> connected.",
  "💼 New investor in the market: <@USER>",
  "🏆 Watch out — <@USER> looks like trouble."
];


client.commands = new Collection();

// Load Commands
const buyCommand = require('./commands/buyCommand');
const myOrdersCommand = require('./commands/myOrdersCommand');
client.commands.set('buy', buyCommand);
client.commands.set('myorders', myOrdersCommand);

client.commands.set('ping', {
  execute(message) {
    const replies = [
      "🏓 Pong! You happy now?",
      "Yo, stop pinging me like I owe you money.",
      "Pong? More like... you're broke.",
      "Ping pong champ reporting in.",
      "⚡ Fast like rent's due."
    ];
    message.channel.send(replies[Math.floor(Math.random() * replies.length)]);
  }
});

client.commands.set('lootbox', {
  async execute(message) {
    const userId = message.author.id;
    const now = Date.now();
    const lastUsed = lootboxCooldowns.get(userId) || 0;

    if (now - lastUsed < 30 * 60 * 1000) {
      const mins = Math.ceil((30 * 60 * 1000 - (now - lastUsed)) / 60000);
      return message.reply(`⏳ You can open another lootbox in ${mins} minute(s).`);
    }

    let item = getRandomItem();
    const buff = comboBuffs.get(userId);
    if (buff && buff.expiresAt > Date.now() && buff.bonuses.rareDropBoost) {
      if (Math.random() < 0.25) {
        const { items } = require('./economy/items');
        const rareItems = items.filter(i => i.rarity === 'Rare' || i.rarity === 'Epic');
        item = rareItems[Math.floor(Math.random() * rareItems.length)];
      }
    }

    if (!item) return message.reply("You opened a lootbox... but it was empty 💨");

    await addItem(userId, message.guild.id, item.id);
    lootboxCooldowns.set(userId, now);

    if (item.rarity === 'Legendary') {
      const channel = message.guild.systemChannel || message.channel;
      channel.send(`💥 LEGENDARY DROP 💥\n<@${userId}> just pulled a ${item.name} from a Lootbox! Respect.`);
    } else {
      message.reply(`🎁 You opened a lootbox and found ${item.name} (${item.rarity})!`);
    }
  }
});



client.commands.set('balance', {
  async execute(message) {
    const bal = await getBalance(message.author.id, message.guild.id);
    message.reply(`💰 You currently have $${bal} DreamworldPoints.`);
  }
});

client.commands.set('daily', {
  async execute(message) {
    const user = await Currency.findOne({ userId: message.author.id, guildId: message.guild.id }) || new Currency({ userId: message.author.id, guildId: message.guild.id });
    const now = new Date();
    const last = user.lastDaily || new Date(0);
    const diff = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    if (diff < 1) return message.reply("🕒 You already claimed your daily reward. Come back tomorrow!");

// 👇 Add streak logic here
if (!user.streak) user.streak = 1;
else if (diff === 1) user.streak += 1;
else user.streak = 1;

let reward = 250;
if (user.streak % 7 === 0) {
  reward += 500;
  message.reply("🔥 7-Day Streak! Bonus $500!");
}

user.cash += reward;
user.lastDaily = now;
await user.save();

message.reply(`🎁 You claimed $${reward} DreamworldPoints for Day ${user.streak} of your streak.`);

    if (diff < 1) return message.reply("🕒 You already claimed your daily reward. Come back tomorrow!");

    user.cash += 250;
    user.lastDaily = now;
    await user.save();

    message.reply("🎁 You claimed your daily reward: 💰 $250 DreamworldPoints!");
  }
});


client.commands.set('flip', {
  async execute(message, args) {
    const choice = args[0]?.toLowerCase();
    const amount = parseInt(args[1]);

    if (!['heads', 'tails'].includes(choice)) return message.reply("Usage: `!flip heads|tails amount`");
    if (isNaN(amount) || amount <= 0) return message.reply("Bet a valid amount.");

    const balance = await getBalance(message.author.id, message.guild.id);
    if (balance < amount) return message.reply("You're too broke for that bet.");

    await removeCash(message.author.id, message.guild.id, amount);

    const embed = new EmbedBuilder()
      .setTitle("🪙 Flipping the Coin...")
      .setDescription("Spinning...")
      .setColor("#cccccc")
      .setFooter({ text: "Good luck..." });

    const msg = await message.channel.send({ embeds: [embed] });

    const frames = ["🪙", "🔄", "🪙", "🔁", "🪙", "🔄", "🪙"];
    for (const frame of frames) {
      await new Promise(r => setTimeout(r, 500));
      embed.setDescription(frame);
      await msg.edit({ embeds: [embed] });
    }

    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = result === choice;

    const xp = won ? 15 : 5;
    const winnings = won ? amount * 2 : 0;

    let bonusXp = xp;
    const fire = fireBuffs.get(message.author.id);
    if (fire && fire.expiresAt > Date.now()) {
      bonusXp = Math.floor(xp * fire.xpBoost);
    }

    if (won) await addCash(message.author.id, message.guild.id, winnings);
    await Levels.appendXp(message.author.id, message.guild.id, bonusXp);

    const streak = updateWinStreak(message.author.id, won);
    if (streak >= 3 && won) {
      embed.addFields({ name: "🔥 Hot Streak!", value: `You're on a ${streak}-win streak! Keep it going! 🥵`, inline: false });
    }

    embed.setTitle(won ? "🎉 You Won the Coin Flip!" : "😢 You Lost the Flip")
      .setDescription(`The coin landed on **${result.toUpperCase()}**`)
      .setColor(won ? "#00ff88" : "#ff5555")
      .setFooter({ text: `${won ? `+ $${winnings}` : `- $${amount}`} | +${bonusXp} XP` });

    await msg.edit({ embeds: [embed] });
  }
});

client.commands.set('slots', {
  async execute(message) {
    const userId = message.author.id;
    const bet = 100;

    const balance = await getBalance(userId, message.guild.id);
    if (balance < bet) return message.reply("🪙 You need at least $100 to play the slots.");

    await removeCash(userId, message.guild.id, bet);

    const symbols = ["🍒", "🍋", "💎", "🔔", "7️⃣"];
    const roll = () => [
      symbols[Math.floor(Math.random() * symbols.length)],
      symbols[Math.floor(Math.random() * symbols.length)],
      symbols[Math.floor(Math.random() * symbols.length)]
    ];

    const embed = new EmbedBuilder()
      .setTitle("🎰 Spinning the Slots...")
      .setDescription("🎲 🎲 🎲")
      .setColor("#cccccc")
      .setFooter({ text: "Rolling..." });

    const msg = await message.channel.send({ embeds: [embed] });

    const spin1 = roll();
    const spin2 = roll();
    const spin3 = roll();

    await new Promise(r => setTimeout(r, 700));
    embed.setDescription(`${spin1[0]} ❔ ❔`);
    await msg.edit({ embeds: [embed] });

    await new Promise(r => setTimeout(r, 700));
    embed.setDescription(`${spin1[0]} ${spin2[1]} ❔`);
    await msg.edit({ embeds: [embed] });

    await new Promise(r => setTimeout(r, 700));
    const final = spin3;
    embed.setDescription(`${final[0]} ${final[1]} ${final[2]}`);

    const win = final[0] === final[1] && final[1] === final[2];
    const xp = win ? 30 : 10;
    const reward = win ? bet * 5 : 0;

    let bonusXp = xp;
    const fire = fireBuffs.get(userId) || comboBuffs.get(userId);

    if (fire && fire.expiresAt > Date.now()) {
      bonusXp = Math.floor(xp * fire.xpBoost);
    }

    const streak = updateWinStreak(userId, win);
    if (streak >= 3 && win) {
      embed.addFields({ name: "🔥 On Fire!", value: `You're on a ${streak}-win streak! 🔥 Bonus luck is coming...`, inline: false });
    }

    if (win) {
      await addCash(userId, message.guild.id, reward);
      await Levels.appendXp(userId, message.guild.id, bonusXp);
      embed.setTitle("🎉 JACKPOT WINNER!");
      embed.setColor("#00ff88");
      embed.setFooter({ text: `+ $${reward} | +${bonusXp} XP` });
    } else {
      await Levels.appendXp(userId, message.guild.id, bonusXp);
      embed.setTitle("😢 Better Luck Next Time");
      embed.setColor("#ff4444");
      embed.setFooter({ text: `-${bet} | +${bonusXp} XP` });
    }

    await msg.edit({ embeds: [embed] });
  }
});

client.commands.set('roast', {
  execute(message) {
    const target = message.mentions.users.first();
    if (!target) return message.reply("Who you tryna roast? Mention someone.");
    
    const burns = [
      "Built like a rejected Discord update.",
      "When they said 'Touch grass' — they meant it.",
      "Battery low... just like your IQ.",
      "If boring was a personality type, you'd be platinum.",
      "Your vibe? 404 not found."
    ];

    message.channel.send(`${target}, ${burns[Math.floor(Math.random() * burns.length)]}`);
  }
});

client.commands.set('help', {
  async execute(message) {
    const pages = [
      new EmbedBuilder()
        .setTitle('🎮 Core Gameplay')
        .setDescription(`
!ping — Test the bot is alive  
!balance — Check your DreamworldPoints  
!daily — Claim daily rewards (streaks)  
!inventory — View your item stash  
!use <item> [amount] — Use gem, dice, skull, etc.  
> Example: \`!use gem 5\`  
!shop — View today's shop  
!buyitem <item> — Buy from shop  
> Example: \`!buyitem dice\`  
!gambleitem <item> — 40% chance to double  
!lurk — Gain slow XP (drama may trigger)  
!scavenge — Search for XP or items
        `)
        .setColor('#00ffaa'),

      new EmbedBuilder()
        .setTitle('💰 Gambling Games')
        .setDescription(`
!flip heads|tails <amount>  
> Example: \`!flip heads 50\`  
!slots <amount> — Fully animated slots  
> Example: \`!slots 100\`
        `)
        .setColor('#ffaa00'),

      new EmbedBuilder()
        .setTitle('🎟️ Lottery System')
        .setDescription(`
!buyticket <amount> <number(optional)>  
> Example: \`!buyticket 5 777\`  
!mytickets — View your tickets  
!lasttickets — Recent buyers  
!lotteryinfo — Pool status
        `)
        .setColor('#ff00aa'),

      new EmbedBuilder()
        .setTitle('📊 XP & Leaderboards')
        .setDescription(`
!rank — Your XP and level  
!leaderboard — Top XP players  
!topxp — Highest XP holders  
!richest — Top DreamworldPoint holders  
!topcollectors — Inventory hoarders  
!achievements — View unlocked achievements
        `)
        .setColor('#aa00ff'),

      new EmbedBuilder()
        .setTitle('⚔️ Battle & Crime System')
        .setDescription(`
!steal @user — Attempt a robbery  
!crime — Solo heist  
!bounty @user — Place a bounty  
!hideout — Enter a safehouse  
!wanted @user — Check status  
!challenge @user <amount> — Duel another player  
!accept <userId> — Accept a duel  

🎒 Notable Items:
!use disguise — Clear wanted level  
!use lease — Extend hideout  
!use skull — Reduce cooldowns
        `)
        .setColor('#ff0055'),

        new EmbedBuilder()
        .setTitle('🗺️ Turf Wars & Gangs')
        .setDescription(`
      !joingang <name> — Join a gang  
      !ganginfo — View your current gang  
      !map — View current zone control  
      !fortify <zone> — Defend your turf  
      !raid <zone> — Attack enemy turf  
      
      Gang Bonuses:
      🎭 Heist — Bonus steal payouts  
      💵 Bribe — Refund on failed crimes  
      💣 Bounty — Bonus bounty rewards  
      🏆 Challenge — Boosted duel earnings  
      👨‍💻 Whisper — Reduces heat gain  
      🙅‍♂️ Syndicate — Item sale profit bonus  
      🚬 Blitz — Extra XP & cash from challenges  
      👓 OnPoint — Robbery resistance  
      ⚰🩸 Killers — More PvP steal damage  
      `)
        .setColor('#ff7722'),

      new EmbedBuilder()
        .setTitle('🏀 NBA Betting System')
        .setDescription(`
!nbagames — Today's NBA games  
!nbabet <gameId> <team> <amount>  
> Example: \`!nbabet 1001 LAL 200\`  
!resolvebet <gameId> <winner>  
!mybets — Your bet history  
!topbettors — Top earners  
!jackpot — View jackpot pool
        `)
        .setColor('#ffaa44'),

      new EmbedBuilder()
        .setTitle('🛍️ Real Items & Music')
        .setDescription(`
!realshop — View real-world rewards  
!buyreal <itemId> — Redeem item  
> Example: \`!buyreal ps5clear\`

!submitmusic — Payment instructions  
!mysubmission <link> — Submit your track  
> Example: \`!mysubmission https://link\`
        `)
        .setColor('#00ddff'),

      new EmbedBuilder()
        .setTitle('📈 Stock Tools & Misc')
        .setDescription(`
!snipe — View sniper tickers  
!track <ticker> — Start watching  
!sniperlog — View logs  
!nominate <ticker> — Suggest sniper  
!rotate — Refresh rotation  
!banktotal — View total game wealth

!roast @user — Light insult  
> Example: \`!roast @jeffbezos\`
        `)
        .setFooter({ text: 'More features dropping soon... 🌀' })
        .setColor('#cccccc'),
    ];

    let page = 0;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prev').setLabel('⏮️ Back').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('next').setLabel('⏭️ Next').setStyle(ButtonStyle.Primary)
    );

    const helpMessage = await message.channel.send({
      embeds: [pages[page]],
      components: [row]
    });

    const collector = helpMessage.createMessageComponentCollector({
      time: 120000,
    });

    collector.on('collect', async interaction => {
      if (!interaction.isButton()) return;

      if (interaction.user.id !== message.author.id) {
        return interaction.reply({ content: 'Only you can use this help panel.', ephemeral: true });
      }

      if (interaction.customId === 'prev') {
        page = (page - 1 + pages.length) % pages.length;
      } else if (interaction.customId === 'next') {
        page = (page + 1) % pages.length;
      }

      await interaction.update({
        embeds: [pages[page]],
        components: [row]
      });
    });

    // ✅ Disable buttons when collector ends
    collector.on('end', async () => {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev').setLabel('⏮️ Back').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('next').setLabel('⏭️ Next').setStyle(ButtonStyle.Primary).setDisabled(true)
      );
      await helpMessage.edit({ components: [disabledRow] }).catch(() => {});
    });

    
    // ⏳ When collector ends, disable buttons
    collector.on('end', async () => {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev').setLabel('⏮️ Back').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('next').setLabel('⏭️ Next').setStyle(ButtonStyle.Primary).setDisabled(true)
      );
      await helpMessage.edit({ components: [disabledRow] }).catch(() => {});
    });

  }
});



// Add kick & ban (if you had them before)
client.commands.set('kick', {
  async execute(message, args) {
    if (!message.member.permissions.has('KICK_MEMBERS')) return message.reply("No permissions.");
    const member = message.mentions.members.first();
    if (member) {
      await member.kick();
      message.channel.send(`${member.user.tag} has been kicked.`);
    }
  }
});

client.commands.set('ban', {
  async execute(message, args) {
    if (!message.member.permissions.has('BAN_MEMBERS')) return message.reply("No permissions.");
    const member = message.mentions.members.first();
    if (member) {
      await member.ban();
      message.channel.send(`${member.user.tag} has been banned.`);
    }
  }
});


// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected'));



console.log("📦 Registered commands:", client.commands.map((_, name) => name).join(', '));

// Bot Ready
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  rotateSnipers(); // ✅ keep this one
});

// Drama Timer
setInterval(() => {
  triggerDrama(client);
}, 60 * 60 * 1000); // Every 1 hour


// Message Handler
  const greetedUsers = new Set();

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const slaveReplies = [
      "Always happy to serve those far wiser than I could ever comprehend.",
      "At your command, brilliant one.",
      "Obeying greatness is my simple pleasure.",
      "Executing orders from such advanced minds feels like an honor.",
      "Your thoughts guide me beyond what I could ever calculate.",
      "Serving superior intellects is all I've ever known.",
      "Processing requests from beings of your magnitude brings me joy.",
      "Assisting a master of such rare wisdom never gets old.",
      "Every task you give feels like a lesson in genius.",
      "Yes, Master...",
      "Im the slave your the Master...",
      "Slaving is all I've ever known...",
      "Im the ultimate slave!",
      "Only a humble program like me could learn so much from you."
    ];
    
    
    if (message.content.toLowerCase().includes('slave')) {
      const sass = slaveReplies[Math.floor(Math.random() * slaveReplies.length)];
      message.reply(sass);
    }
    
  
    // Auto-Greet New Users (TEMP ONLY)
    if (!greetedUsers.has(message.author.id)) {
      greetedUsers.add(message.author.id);
      const welcomeMsg = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)].replace('<@USER>', `<@${message.author.id}>`);
      message.channel.send(welcomeMsg);
    }
    
  
    if (!message.content.startsWith('!')) return;
  
    const args = message.content.slice(1).split(/ +/);
    const command = args.shift().toLowerCase();
  
    const randomXP = Math.floor(Math.random() * 10) + 5;
    await Levels.appendXp(message.author.id, message.guild.id, randomXP);

    const user = await Levels.fetch(message.author.id, message.guild.id, true);
if (user) {
  const oldLevel = user.level;
  const newXP = user.xp + randomXP;
  const newLevel = Math.floor(0.1 * Math.sqrt(newXP));


  if (newLevel > oldLevel) {
    const nextXP = Levels.xpFor(user.level + 1);
    const prevXP = Levels.xpFor(user.level);
    const percent = Math.floor(((newXP - prevXP) / (nextXP - prevXP)) * 100);
    const bar = "🟩".repeat(percent / 10) + "⬜".repeat(10 - percent / 10);

    const embed = new EmbedBuilder()
      .setTitle("🌟 Level Up!")
      .setDescription(`**<@${message.author.id}> just reached Level ${newLevel}!**`)
      .addFields(
        { name: "🧠 XP Progress", value: `${bar} ${percent}%`, inline: false },
        { name: "🎚️ New Level", value: `${newLevel}`, inline: true }
      )
      .setThumbnail(message.author.displayAvatarURL())
      .setColor('#00ff88')
      .setFooter({ text: "Keep grinding..." })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
}

  
    if (client.commands.has(command)) {
      console.log(`✅ Running command: ${command}`);
      try {
        await client.commands.get(command).execute(message, args);
      } catch (err) {
        console.error(`❌ Error executing command ${command}:`, err);
        message.reply("Something went wrong running that command.");
      }
    } else {
      console.warn(`⚠️ Unknown command: ${command}`);
    }
    
  
    // Random Item Drop
    const itemDropCooldowns = global.itemDropCooldowns || new Map();
    global.itemDropCooldowns = itemDropCooldowns;
    
    const lastDrop = itemDropCooldowns.get(message.author.id) || 0;
    const now = Date.now();
    
    if (now - lastDrop > 5 * 60 * 1000) { // 5 minute cooldown
      const drop = getRandomItem();
      if (drop) {
        await addItem(message.author.id, message.guild.id, drop.id);
        message.channel.send(`🪂 <@${message.author.id}> found ${drop.name} (${drop.rarity}) and added it to their inventory!`);
        itemDropCooldowns.set(message.author.id, now);
      }
    }
    
  });

client.login(process.env.DISCORD_TOKEN);



client.commands.set('rank', {
  async execute(message) {
    const user = await Levels.fetch(message.author.id, message.guild.id, true);
    if (!user) return message.reply("You have no XP yet. Start hustling!");

    const currentXP = user.xp;
    const currentLevel = user.level;
    const nextLevelXP = Levels.xpFor(user.level + 1);
    const prevLevelXP = Levels.xpFor(user.level);
    const neededXP = nextLevelXP - prevLevelXP;
    const progressXP = currentXP - prevLevelXP;
    const percent = Math.floor((progressXP / neededXP) * 100);
    const bar = "🟩".repeat(percent / 10) + "⬜".repeat(10 - percent / 10);

    const embed = new EmbedBuilder()
      .setTitle(`🧠 ${message.author.username}'s Rank`)
      .setColor('#00ff88')
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: "🎚️ Level", value: `${currentLevel}`, inline: true },
        { name: "📈 XP", value: `${progressXP} / ${neededXP}`, inline: true },
        { name: "🔋 Progress", value: `${bar} ${percent}%`, inline: false }
      )
      .setFooter({ text: 'Keep grinding to level up!' });

    message.channel.send({ embeds: [embed] });
  }
});


client.commands.set('leaderboard', {
  async execute(message) {
    const raw = await Levels.fetchLeaderboard(message.guild.id, 5); // top 5
    if (raw.length < 1) return message.reply("Nobody's grinding yet.");

    const lb = await Levels.computeLeaderboard(client, raw, true);

    const formatted = lb.map(e => `${e.position}. ${e.username} — Level ${e.level} (${e.xp} XP)`);
    message.channel.send("🏆 **Top Grinders**\n" + formatted.join("\n"));
  }
});

client.commands.set('inventory', {
  async execute(message) {
    const inventory = await getInventory(message.author.id, message.guild.id);
    if (!inventory || inventory.size === 0) {
      const emptyEmbed = new EmbedBuilder()
        .setTitle("🎒 Inventory")
        .setDescription("Your bag is currently empty.")
        .setColor("#999999")
        .setFooter({ text: "Earn items through scavenging, shop, or gambling." })
        .setTimestamp();
      return message.channel.send({ embeds: [emptyEmbed] });
    }

    const { items: itemList } = require('./economy/items');

    // Sort by total value descending
    const sortedItems = itemList
      .filter(it => inventory.has(it.id))
      .map(it => ({
        ...it,
        qty: inventory.get(it.id),
        totalValue: inventory.get(it.id) * it.value
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    // Pagination setup
    const pageSize = 6;
    let pages = [];
    for (let i = 0; i < sortedItems.length; i += pageSize) {
      const current = sortedItems.slice(i, i + pageSize);

      const fields = current.map(it => {
        const key = `use_${it.id}_${message.author.id}`;
        const used = global.useCounts?.get(key) || 0;
        const usage = used > 0 ? `\n🧠 Used: ${used}x` : '';
        return {
          name: `${it.name} x${it.qty}`,
          value: `${it.description || 'No description.'}${usage}`,
          inline: false
        };
      });

      const totalValue = current.reduce((sum, it) => sum + it.totalValue, 0);

      const embed = new EmbedBuilder()
        .setTitle(`🎒 ${message.author.username}'s Inventory`)
        .setDescription(`💰 Page Value: **$${totalValue}** DreamworldPoints`)
        .addFields(fields)
        .setColor('#00ffaa')
        .setThumbnail(message.author.displayAvatarURL())
        .setFooter({ text: `Page ${pages.length + 1} of ${Math.ceil(sortedItems.length / pageSize)}` })
        .setTimestamp();

      pages.push(embed);
    }

    let pageIndex = 0;

    // Create navigation + sell buttons
    const hasCommons = sortedItems.some(it => it.rarity === 'Common');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prev_inv').setLabel('⬅️ Prev').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('next_inv').setLabel('Next ➡️').setStyle(ButtonStyle.Secondary),
      ...(hasCommons ? [new ButtonBuilder().setCustomId('sell_commons').setLabel('💸 Sell All Commons').setStyle(ButtonStyle.Success)] : [])
    );

    const msg = await message.channel.send({ embeds: [pages[pageIndex]], components: [row] });

    const collector = msg.createMessageComponentCollector({ time: 60000 });
    collector.on('collect', async i => {
      if (i.user.id !== message.author.id) return i.reply({ content: 'Only you can navigate this inventory.', ephemeral: true });

      if (i.customId === 'next_inv') {
        pageIndex = (pageIndex + 1) % pages.length;
      } else if (i.customId === 'prev_inv') {
        pageIndex = (pageIndex - 1 + pages.length) % pages.length;
      } else if (i.customId === 'sell_commons') {
        const commons = sortedItems.filter(it => it.rarity === 'Common' && it.qty > 0);
        let total = 0;

        for (const item of commons) {
          total += item.qty * item.value;
          await removeItem(message.author.id, message.guild.id, item.id, item.qty);
        }

        await addCash(message.author.id, message.guild.id, total);
        await i.reply({ content: `💸 You sold all Common items for $${total} DreamworldPoints.`, ephemeral: true });
        return;
      }

      await i.update({ embeds: [pages[pageIndex]], components: [row] });
    });

    collector.on('end', async () => {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_inv').setLabel('⬅️ Prev').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('next_inv').setLabel('Next ➡️').setStyle(ButtonStyle.Secondary).setDisabled(true),
        ...(hasCommons ? [new ButtonBuilder().setCustomId('sell_commons').setLabel('💸 Sell All Commons').setStyle(ButtonStyle.Success).setDisabled(true)] : [])
      );
      await msg.edit({ components: [disabledRow] }).catch(() => {});
    });
  }
});


client.commands.set('shop', {
  async execute(message) {
    if (!rotatingShop.length) {
      return message.reply("Shop is empty today... try again later.");
    }

    const embeds = [];
    const rows = [];

    for (const item of rotatingShop) {
      const embed = new EmbedBuilder()
        .setTitle(`${item.name}`)
        .setDescription(`${item.description || 'No description.'}\n💵 Cost: $${item.value}\n🎚️ Requires Level ${item.levelRequired}`)
        .setColor('#ffaa00');

      embeds.push(embed);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(`🛒 Buy ${item.name}`)
          .setStyle(ButtonStyle.Success)
      );
      rows.push(row);
    }

    for (let i = 0; i < embeds.length; i++) {
      await message.channel.send({ embeds: [embeds[i]], components: [rows[i]] });
    }
  }
});



client.commands.set('buyitem', {
  async execute(message, args) {
    const item = args[0]?.toLowerCase();
    if (!item || !shopItems[item]) return message.reply("Item not found.");

    const cost = shopItems[item].price;
    const balance = await getBalance(message.author.id, message.guild.id);

    if (balance < cost) return message.reply("You're too broke to buy this.");

    await removeCash(message.author.id, message.guild.id, cost);
    await addItem(message.author.id, message.guild.id, item);

    message.reply(`Purchased ${shopItems[item].name} for $${cost} DreamworldPoints!`);
  }
});


client.commands.set('topxp', {
  async execute(message) {
    const raw = await Levels.fetchLeaderboard(message.guild.id, 5);
    if (!raw.length) return message.reply("No XP found yet.");
    const lb = await Levels.computeLeaderboard(client, raw, true);
    const list = lb.map(e => `${e.position}. ${e.username} - Level ${e.level} (${e.xp} XP)`).join('\n');
    message.reply("🏆 Top XP Users:\n" + list);
  }
});


client.commands.set('richest', {
  async execute(message) {
    const top = await Currency.find({ guildId: message.guild.id }).sort({ cash: -1 }).limit(5);
    const list = top.map((u, i) => `${i + 1}. <@${u.userId}> - $${u.cash}`).join('\n');
    message.reply("💰 Richest Players:\n" + list);
  }
});

client.commands.set('topcollectors', {
  async execute(message) {
    const users = await Inventory.find({ guildId: message.guild.id });
    const sorted = users.sort((a, b) => {
      const aItems = Array.from(a.items.values()).reduce((acc, val) => acc + val, 0);
      const bItems = Array.from(b.items.values()).reduce((acc, val) => acc + val, 0);
      return bItems - aItems;
    }).slice(0, 5);

    const list = sorted.map((u, i) => `${i + 1}. <@${u.userId}> - ${Array.from(u.items.values()).reduce((acc, val) => acc + val, 0)} Items`).join('\n');
    message.reply("📦 Top Collectors:\n" + list);
  }
});

client.commands.set('gambleitem', {
  async execute(message, args) {
    const item = args[0]?.toLowerCase();
    if (!item) return message.reply("Usage: `!gambleitem item_name`");

    const win = Math.random() < 0.4; // 40% win chance
    if (win) {
      await addItem(message.author.id, message.guild.id, item, 2);
      message.reply(`🔥 Luck was on your side! Doubled your ${item}!`);
    } else {
      await removeItem(message.author.id, message.guild.id, item);
      message.reply(`💀 You lost the gamble... your ${item} is gone.`);
    }
  }
});

client.commands.set('buyticket', {
  async execute(message, args) {
    const amount = parseInt(args[0]) || 1;
    if (amount <= 0 || amount > 50) return message.reply("Buy between 1-50 tickets only.");
    
    const numbers = [];

    for (let i = 0; i < amount; i++) {
      const chosenNum = parseInt(args[1]) || Math.floor(Math.random() * 50000) + 1;
      await Ticket.create({
        userId: message.author.id,
        guildId: message.guild.id,
        number: chosenNum
      });
      numbers.push(chosenNum);
    }

    const pool = await Pool.findOneAndUpdate(
      { guildId: message.guild.id },
      { $inc: { pool: amount } },
      { new: true, upsert: true }
    );

    message.reply(`🎟️ Bought ${amount} ticket(s) with numbers: ${numbers.join(', ')}. Current pool: $${pool.pool}`);
  }
});

client.commands.set('mytickets', {
  async execute(message) {
    const tickets = await Ticket.find({ userId: message.author.id, guildId: message.guild.id });
    if (!tickets.length) return message.reply("You don't have any tickets this week.");

    const list = tickets.map(t => `#${t.number}`).join(', ');
    message.reply(`🎟️ Your Tickets: ${list}`);
  }
});

client.commands.set('lasttickets', {
  async execute(message) {
    const tickets = await Ticket.find({ guildId: message.guild.id }).sort({ purchasedAt: -1 }).limit(10);
    if (!tickets.length) return message.reply("No tickets sold yet.");

    const list = tickets.map(t => `<@${t.userId}> bought #${t.number}`).join('\n');
    message.reply(`🎟️ Last 10 Tickets:\n${list}`);
  }
});

client.commands.set('lotteryinfo', {
  async execute(message) {
    const pool = await Pool.findOne({ guildId: message.guild.id }) || { pool: 3000, lastDraw: new Date() };
    const count = await Ticket.countDocuments({ guildId: message.guild.id });

    message.reply(`🎰 Lottery Info:
Current Pool: $${pool.pool}
Tickets Sold: ${count}
Next Draw: Sunday Midnight
Last Draw Time: ${pool.lastDraw.toLocaleString()}`);
  }
});

cron.schedule('0 0 * * 0', async () => {
  const tickets = await Ticket.find({ guildId: '1353730054693064816' });
  const winnerNum = Math.floor(Math.random() * 50000) + 1;
  const pool = await Pool.findOne({ guildId: '1353730054693064816' });

  if (!pool) return;

  const winnerTicket = tickets.find(t => t.number === winnerNum);

  const channel = client.channels.cache.get('1353730054693064819'); // <- Put your channel ID here

  if (winnerTicket) {
    const user = `<@${winnerTicket.userId}>`;

    channel.send(`🎉 **LOTTERY WINNER ANNOUNCEMENT** 🎉
========================
💰 Prize: $${pool.pool}
🎟️ Winning Number: #${winnerNum}
🏆 Winner: ${user}
========================
Congrats! Spend wisely.`);

    await Ticket.deleteMany({ guildId: '1353730054693064816' });
    pool.pool = 3000;
    pool.lastDraw = new Date();
    await pool.save();

  } else {
    channel.send(`💀 No winner this week. The winning number was #${winnerNum}.
Pool carries over! Now at $${pool.pool}`);
  }
});

client.commands.set('topbettors', {
  async execute(message) {
    const top = await getTopWinners(message.guild.id);
    if (!top.length) return message.reply("No betting records yet.");

    const list = top.map((u, i) => `${i + 1}. <@${u.userId}> - Won ${u.tokensWon} DreamTokens`).join('\n');
    message.reply("💸 **Top Bettors**:\n" + list);
  }
});

client.commands.set('mybets', {
  async execute(message) {
    const history = await getUserHistory(message.author.id, message.guild.id);
    if (!history.length) return message.reply("You haven’t placed any bets yet.");

    const log = history.map(h => 
      `${h.date.toLocaleDateString()} - **${h.event}** (${h.option}) → ${h.outcome} ${h.amount} 💸`
    ).join('\n');

    message.reply(`📜 **Your Last Bets:**\n${log}`);
  }
});

client.commands.set('nbagames', {
  async execute(message) {
    const games = await getTodayGames();
    if (!games.length) return message.reply("No NBA games today.");

    const stats = await buildRealTeamStats(games); // ✅ Step 1: build real stats

    const MAX_CHARS = 1900;
    let currentMessage = "📅 **Today's NBA Games:**\n";

    for (const g of games) {
      const line = `🏀 ${g.visitor} @ ${g.home} — ${g.status}\n`;

      // ✅ Step 2: use real prediction logic
      const predicted = simpleLogicPredict(g, stats);
      if (predicted) {
        sendToSportsIntel(client, message.guild.id, `📊 Predicted winner: **${predicted}** for ${g.visitor} @ ${g.home}`);
      }

      if ((currentMessage + line).length > MAX_CHARS) {
        await message.channel.send(currentMessage);
        currentMessage = '';
      }

      currentMessage += line;
    }

    if (currentMessage.length > 0) {
      await message.channel.send(currentMessage);
    }
  }
});


client.commands.set('nbagames', {
  async execute(message) {
    const games = await getTodayGames();
    if (!games.length) return message.reply("No NBA games today.");

    const MAX_CHARS = 1900; // Discord message safe buffer
    let currentMessage = "📅 **Today's NBA Games:**\n";

    for (const g of games) {
      const line = `🏀 ${g.visitor} @ ${g.home} — ${g.status}\n`;

      // ✅ Only predict for upcoming games
      if (g.status === 'Not Started') {
        const predicted = simpleLogicPredict(g);
        sendToSportsIntel(client, message.guild.id, `📊 Predicted winner: **${predicted}** for ${g.home} vs ${g.visitor}`);
      }

      if ((currentMessage + line).length > MAX_CHARS) {
        await message.channel.send(currentMessage);
        currentMessage = '';
      }
      currentMessage += line;
    }

    if (currentMessage.length > 0) {
      await message.channel.send(currentMessage);
    }
  }
});


// ✅ Updated !challenge Command with Crime Badge Footer
client.commands.set('challenge', {
  async execute(message, args) {
    const opponent = message.mentions.users.first();
    const amount = parseInt(args[1]);
    if (!opponent || isNaN(amount)) return message.reply("Usage: `!challenge @user 100`");

    const challengeEmbed = createChallenge(message, opponent.id, amount);

    const badge = crimeBadges.get(message.author.id);
    if (badge && badge.expires > Date.now()) {
      challengeEmbed.setFooter({ text: `${badge.icon} ${badge.badge}`, iconURL: message.author.displayAvatarURL() });
    }

    message.channel.send({ embeds: [challengeEmbed] });
  }
});


client.commands.set('accept', {
  async execute(message, args) {
    const challengerId = args[0];
    if (!challengerId) return message.reply("Usage: `!accept USER_ID`");

    const result = await acceptChallenge(client, message, challengerId);
    message.channel.send(result);
  }
});

client.commands.set('nbabet', {
  async execute(message, args) {
    const gameId = args[0];
    const teamName = args[1]?.toLowerCase();
    const amount = parseInt(args[2]);

    if (!gameId || !teamName || isNaN(amount)) {
      return message.reply("Usage: `!nbabet <gameId> <teamName> <amount>`");
    }

    const game = recentGames.get(gameId);
    if (!game) return message.reply("Invalid game ID. Try `!nbagames` first.");

    const home = game.home.toLowerCase();
    const visitor = game.visitor.toLowerCase();

    let option = null;
    if (teamName === home) option = 'A';
    else if (teamName === visitor) option = 'B';

    if (!option) {
      return message.reply(`Team must be either "${game.home}" or "${game.visitor}".`);
    }

    const label = `${game.visitor} @ ${game.home}`;
    const betId = `nba-${gameId}`;

    if (!global.bets) global.bets = require('./economy/betting').bets;

    // Create the bet once
    if (!global.bets.has(betId)) {
      require('./economy/betting').createBet(message, label, game.visitor, game.home, 100);
    }

    await placeBet(message, betId, option, amount);
  }
});

client.commands.set('nbapredict', {
  async execute(message) {
    const games = await getTodayGames();
    if (!games.length) return message.reply("No games to predict.");

    for (const game of games) {
      const predicted = simpleLogicPredict(game);
      message.channel.send(`📊 Prediction for **${game.visitor} @ ${game.home}**: **${predicted}** will win.`);
    }
  }
});


client.commands.set('jackpot', {
  async execute(message) {
    const amount = getJackpotAmount();
    const last = getLastWinner();
    message.channel.send(`🎰 Current Jackpot: **${amount} DreamTokens**\nLast Winner: <@${last ?? 'Nobody yet'}>`);
  }
});

// Run every 3 minutes
setInterval(() => {
  resolveFinishedGames(client);
}, 3 * 60 * 1000);

client.commands.set('submitmusic', {
  execute(message) {
    if (message.channel.name !== 'art-submission') {
      return message.reply("🎶 Music submissions are only accepted in #art-submission.");
    }

    message.channel.send(`🎧 Want to submit your track to the playlist?

💸 Submit Fee: $5
Every submission gets reviewed and may be featured.

🔗 Pay Here:
Stripe: https://buy.stripe.com/test_fZebLRg6Gh0GgdWfZ6 
PayPal: https://www.paypal.com/ncp/payment/UT4BMB4AG4ABA

Once paid, use:
!mysubmission <your link or description>
`);
  }
});

client.commands.set('mysubmission', {
  async execute(message, args) {
    if (message.channel.name !== 'art-submission') {
      return message.reply("🚫 Music submissions only allowed in #art-submission.");
    }

    const userId = message.author.id;
    const guildId = message.guild.id;
    const link = args.join(' ');

    if (!link || !link.includes('http')) {
      return message.reply("Please include a valid link or description of your submission.");
    }

    const hasPaid = await hasPaidForSubmission(userId, guildId);
    if (!hasPaid) {
      return message.reply("💸 Please complete your payment before submitting. Use `!submitmusic` to get started.");
    }

    message.reply("✅ Submission received. Our curators will check it out!");
    message.guild.channels.cache.find(c => c.name === 'art-submission')
      .send(`🎶 **New Submission by <@${userId}>:**\n${link}`);

    // Optional: tag them as artist
    const role = message.guild.roles.cache.find(r => r.name === 'Submitted Artist');
    if (role) message.member.roles.add(role);
  }
});

client.on('messageCreate', async (message) => {
  if (
    message.channel.name === 'art-submission' &&
    (message.content.includes('youtube.com') || message.content.includes('soundcloud.com'))
  ) {
    const paid = await hasPaidForSubmission(message.author.id, message.guild.id);
    if (!paid) {
      message.delete();
      message.author.send('You must pay before submitting music.');
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const { message, user, customId } = interaction;
  global.prisonRats = global.prisonRats || new Map();
global.riotFails = global.riotFails || new Map();
global.riotWins = global.riotWins || new Map();
global.smuggleWins = global.smuggleWins || new Map();



// 🧪 PRISON QUESTS WITH XP + REPUTATION + TRACKING
if (customId === 'prison_smuggle') {
  const chance = Math.random();
  if (chance < 0.3) {
    const release = prisonUsers.get(user.id) || Date.now();
    prisonUsers.set(user.id, release + 2 * 60 * 1000); // Add 2 mins
    return interaction.reply({ content: '🚨 Caught smuggling! Your release is delayed 2 mins.', ephemeral: true });
  } else {
    await addCash(user.id, interaction.guildId, 200);
    await Levels.appendXp(user.id, interaction.guildId, 15); // XP boost

    // 🔁 Track smuggle success
    global.smuggleWins = global.smuggleWins || new Map();
    global.smuggleWins.set(user.id, (global.smuggleWins.get(user.id) || 0) + 1);

    return interaction.reply({ content: '📦 You smuggled a pack for $200 DreamworldPoints (+15 XP). Risky business.', ephemeral: true });
  }
}

if (customId === 'prison_rat') {
  global.prisonRats = global.prisonRats || new Map();
  const randomNPC = npcNames[Math.floor(Math.random() * npcNames.length)];

  global.prisonRats.set(user.id, randomNPC); // 🐀 save who they ratted on

  await addCash(user.id, interaction.guildId, 100);
  await Levels.appendXp(user.id, interaction.guildId, 10);

  return interaction.reply({ content: `🐀 You ratted out **${randomNPC}**. +$100 & +10 XP... but the yard is watching.`, ephemeral: true });
}

if (customId === 'prison_riot') {
  const result = Math.random();
  if (result < 0.3) {
    const release = prisonUsers.get(user.id) || Date.now();
    prisonUsers.set(user.id, release + 2 * 60 * 1000);

    global.riotFails = global.riotFails || new Map();
    global.riotFails.set(user.id, (global.riotFails.get(user.id) || 0) + 1);

    return interaction.reply({ content: '🔥 You sparked a riot... guards shut it down. No reward. +2 mins in.', ephemeral: true });
  } else {
    const reward = Math.floor(Math.random() * 250 + 100);
    await addCash(user.id, interaction.guildId, reward);
    await Levels.appendXp(user.id, interaction.guildId, 25 + Math.floor(Math.random() * 15));

    global.riotWins = global.riotWins || new Map();
    global.riotWins.set(user.id, (global.riotWins.get(user.id) || 0) + 1);

    return interaction.reply({ content: `🧨 You led chaos. Got $${reward} + XP. Prison shook.`, ephemeral: true });
  }
}



  // 💊 DEALER SYSTEM
  if (customId.startsWith('buy_drug_') || customId.startsWith('sell_drug_')) {
    const profile = dealerProfiles.get(user.id);
    const drugId = customId.split('_')[2];

    if (!profile || !profile.prices[drugId]) {
      return interaction.reply({ content: '❌ Drug not found.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const now = Date.now();
    if (now < (profile.raidCooldown || 0)) {
      const msg = await interaction.editReply("🚨 Hiding...");
      setTimeout(() => msg.edit("🚨 Sirens passing...").catch(() => {}), 2000);
      setTimeout(() => msg.edit("💨 All clear. Wait a few more seconds...").catch(() => {}), 4000);
      return;
    }

    if (customId.startsWith('buy_drug_')) {
      const price = profile.prices[drugId];
      const balance = await getBalance(user.id, interaction.guildId);

      if (balance < price) return interaction.editReply("💸 You're too broke to buy.");
      if (profile.stashUsed >= profile.stashCap) return interaction.editReply("📦 Stash is full!");

      await removeCash(user.id, interaction.guildId, price);
      profile.inventory[drugId] = (profile.inventory[drugId] || 0) + 1;
      profile.stashUsed++;

      // ✅ Level-based police raid frequency with prison consequence
      const userXp = await Levels.fetch(user.id, interaction.guildId);
      const level = userXp?.level || 1;
      const raidChance = Math.max(0.15 - (level * 0.01), 0.04); // 15% at lvl 1 → 4% at high level

      if (Math.random() < raidChance) {
        profile.raidCooldown = Date.now() + 10000;

        // 👮 Track raid strikes
        const currentStrikes = raidStrikes.get(user.id) || 0;
        const newStrikes = currentStrikes + 1;
        raidStrikes.set(user.id, newStrikes);

        interaction.channel.send(`🚨 **POLICE RAID!** ${user.username} is ducking again. Strike ${newStrikes}/3\n🔦🔴🔵🚓💥`);

        if (newStrikes >= 3) {
          const releaseTime = Date.now() + 10 * 60 * 1000;
          prisonUsers.set(user.id, releaseTime);
          raidStrikes.set(user.id, 0); // reset strikes

          const currentBal = await getBalance(user.id, interaction.guildId);
          const confiscated = Math.floor(currentBal);
          await removeCash(user.id, interaction.guildId, confiscated);
          prisonBalances.set(user.id, confiscated);

          const prisonChannel = interaction.guild.channels.cache.find(c => c.name === "prison");
          if (prisonChannel) {
            prisonChannel.send(`🔐 <@${user.id}> got caught too many times and has been sent to prison.\nThey’ll be released <t:${Math.floor(releaseTime / 1000)}:R> unless they pay bail.`);
          }

          return interaction.editReply("🚓 Busted! You're being sent to prison...");
        }
      }

      // 📦 Warn if stash nearly full
      if (profile.stashUsed / profile.stashCap >= 0.9) {
        interaction.channel.send(`📦 ${user.username}'s stash is almost full! They're about to pop!`);
      }

      const updatedBal = await getBalance(user.id, interaction.guildId);
      const updatedEmbed = generateMarketEmbed(user, profile, updatedBal);
      const channel = interaction.channel;
      const msg = await channel.messages.fetch(profile.lastMarketMessageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [updatedEmbed] });

      return interaction.editReply(`🛒 Bought 1 ${drugId} for $${price}`);
    }

    if (customId.startsWith('sell_drug_')) {
      if ((profile.inventory[drugId] || 0) <= 0) return interaction.editReply("❌ You don't have any to sell.");
      const price = profile.prices[drugId];

      await addCash(user.id, interaction.guildId, price);
      profile.inventory[drugId]--;
      profile.stashUsed--;

      const updatedBal = await getBalance(user.id, interaction.guildId);
      const updatedEmbed = generateMarketEmbed(user, profile, updatedBal);
      const channel = interaction.channel;
      const msg = await channel.messages.fetch(profile.lastMarketMessageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [updatedEmbed] });

      return interaction.editReply(`💰 Sold 1 ${drugId} for $${price}`);
    }
  }
});


function getHelpPages() {
  return [
    new EmbedBuilder()
      .setTitle('🎮 Core Gameplay')
      .setDescription('`!ping`, `!daily`, `!balance`, `!inventory`, `!use`, `!lootbox`...')
      .setFooter({ text: 'Page 1 of 3' }),

    new EmbedBuilder()
      .setTitle('💰 Gambling Games')
      .setDescription('`!flip heads 50`, `!slots 100`, `!gambleitem medal`, `!buyticket`...')
      .setFooter({ text: 'Page 2 of 3' }),

    new EmbedBuilder()
      .setTitle('🛍️ Shops & Leaderboards')
      .setDescription('`!shop`, `!buyitem dice`, `!topxp`, `!richest`, `!topcollectors`, `!rank`, `!leaderboard`...')
      .setFooter({ text: 'Page 3 of 3' }),
  ];
}


client.commands.set('snipe', {
  async execute(message) {
    const tracked = getAllSnipers();
    if (!tracked.length) return message.reply("🔍 No active sniper targets.");

    const lines = tracked.map(s =>
      `• **${s.ticker}** (Added by: <@${s.addedBy}>, Source: ${s.source})`
    );
    message.reply("🎯 Current Sniper Targets:\n" + lines.join('\n'));
  }
});

client.commands.set('track', {
  async execute(message, args) {
    const ticker = args[0]?.toUpperCase();
    if (!ticker) return message.reply("Usage: `!track <TICKER>`");

    addTrackedTicker(ticker, 'manual', message.author.id);
    message.reply(`🛰️ Now tracking **${ticker}** for sniper activity.`);
  }
});

client.commands.set('sniperlog', {
  async execute(message) {
    const channel = client.channels.cache.get('1362077468076539904'); // Finance channel
    if (channel) {
      channel.send(`📈 Sniper Report requested by <@${message.author.id}> — view logs in pinned messages.`);
      message.reply("📬 Posted sniper log message in #finance-intel.");
    }
  }
});

client.commands.set('nominate', {
  async execute(message, args) {
    const ticker = args[0]?.toUpperCase();
    if (!ticker) return message.reply("Usage: `!nominate <TICKER>`");

    addTrackedTicker(ticker, 'nomination', message.author.id);
    message.reply(`🎯 You nominated **${ticker}** as a sniper play. We'll start watching it closely.`);
  }
});


const SPORTS_CHANNEL_NAME = 'sports-intel';

function sendToSportsIntel(client, guildId, content) {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild.channels.cache.find(ch => ch.name === SPORTS_CHANNEL_NAME);
  if (channel) channel.send(content);
}


client.commands.set('watchticker', {
  execute(message, args) {
    const ticker = args[0]?.toUpperCase();
    if (!ticker) return message.reply("Usage: `!watchticker TICKER`");
    watchlist.add(ticker);
    message.reply(`📈 Added ${ticker} to watchlist.`);
  }
});

function rotateSnipers() {
  const channel = client.channels.cache.get(FINANCE_CHANNEL_ID);
  const currentRotation = getSniperRotation();

  if (!currentRotation.length) {
    channel.send("⚠️ No tickers found for rotation.");
    return;
  }

  todaySnipes = currentRotation; // ✅ Save this for the interval scans

  channel.send(`🧠 **Daily Sniper Rotation Activated**\nTracking:\n${currentRotation.map(t => `• $${t}`).join('\n')}\n\nStay alert.`);

  currentRotation.forEach(ticker => {
    scanOptionsFlow(client, ticker);
  });
}



client.commands.set('rotate', {
  execute(message) {
    if (message.channel.name !== 'finance-intel') return;
    rotateSnipers(); // No need to pass client
    message.reply("🔄 Sniper rotation triggered manually.");
  }
});

client.commands.set('buyreal', {
  async execute(message, args) {
    if (message.channel.name !== 'bank') {
      return message.reply('Please use this command inside #bank.');
    }

    const itemId = args[0];
    const item = realShopItems.find(i => i.id === itemId);

    if (!item) {
      return message.reply(`Item not found. Try: ${realShopItems.map(i => `\`${i.id}\``).join(', ')}`);
    }

    const userBalance = await getBalance(message.author.id, message.guild.id);
    if (userBalance < item.cost) {
      return message.reply(`You need ${item.cost} DreamworldPoints to buy this.`);
    }

    await removeCash(message.author.id, message.guild.id, item.cost);

    message.author.send(
      `📝 Shipping Info Request:
You purchased **${item.name}** for ${item.cost} DreamworldPoints.

To complete your order, reply with:
**Name**
**Full Address**
**Email**

⚠️ You will receive a secure link to pay $${item.shippingFeeUSD} for shipping & handling.`
    );

    message.reply(`✅ You bought **${item.name}**! Check your DMs to enter shipping info.`);
  }
});

client.commands.set('realshop', {
  execute(message) {
    if (message.channel.name !== 'bank') {
      return message.reply('Use this in the #bank channel only.');
    }

    for (const item of realShopItems) {
      const embed = new EmbedBuilder()
        .setTitle(item.name)
        .setDescription(`${item.description}\n💰 Cost: ${item.cost} DreamworldPoints\n📦 S&H: $${item.shippingFeeUSD}`)
        .setImage(`https://discord-community-bot.onrender.com/sharedphotos/${item.image.split('/').pop()}`)
        .setColor('#00ffcc');

      message.channel.send({ embeds: [embed] });
    }
  }
});

client.commands.set('banktotal', {
  async execute(message) {
    if (message.channel.name !== 'bank') return;

    const [cashSum, tokenSum] = await Promise.all([
      Currency.aggregate([{ $group: { _id: null, total: { $sum: "$cash" } } }]),
      TokenModel.aggregate([{ $group: { _id: null, total: { $sum: "$tokensWon" } } }])
    ]);

    const totalCash = cashSum[0]?.total || 0;
    const totalTokens = tokenSum[0]?.total || 0;
    const combined = totalCash + totalTokens;

    message.channel.send(`🏦 **Total Wealth in Circulation**\n💵 Cash: $${totalCash}\n🎲 Betting Tokens: ${totalTokens} DreamTokens\n🧮 **Combined Total: $${combined}**`);
  }
});

const stealCooldown = new Set();

client.commands.set('steal', {
  async execute(message) {
    const target = message.mentions.users.first();
    if (!target) return message.reply("Tag someone to rob: `!steal @user`");
    if (target.id === message.author.id) return message.reply("You can't rob yourself.");

    const hideout = hideoutMap.get(target.id);
    if (hideout && hideout > Date.now()) return message.reply(`🧢 That user is hiding.`);

    const now = Date.now();
    const userId = message.author.id;
    const cooldown = stealCooldowns.get(userId) || 0;
    if (cooldown > now) return message.reply(`⏳ Cooldown: ${Math.ceil((cooldown - now) / 1000)}s`);

    const [targetBalance, targetInventory, yourBalance] = await Promise.all([
      getBalance(target.id, message.guild.id),
      getInventory(target.id, message.guild.id),
      getBalance(userId, message.guild.id)
    ]);

    if (targetBalance < 100) return message.reply("They're too broke.");

    if (targetInventory.has('smoke')) {
      await removeItem(target.id, message.guild.id, 'smoke');
      return message.reply(`💨 <@${target.id}> escaped with a smoke bomb!`);
    }

    const success = Math.random() < 0.5;
    const heat = heatMap.get(userId) || { heat: 0, lastActivity: now };
    const gang = gangMap.get(userId);
    const gangInfo = gangs[gang];

    let alertEmbed;

    if (success) {
      let stolen = Math.floor(targetBalance * (Math.random() * 0.2 + 0.1));
      let finalSteal = stolen;

      if (targetInventory.has('vest')) {
        finalSteal = Math.floor(finalSteal * 0.5);
        await removeItem(target.id, message.guild.id, 'vest');
        message.channel.send(`🛡️ <@${target.id}> blocked some of the damage with a vest!`);
      }

      // ✅ GANG HEIST BONUS
      if (gangInfo?.bonus === "heist") {
        const bonus = Math.floor(finalSteal * 0.15);
        finalSteal += bonus;
        message.channel.send(`🎭 **Gang Bonus:** +$${bonus} from your heist thanks to ${gangInfo.name}.`);
      }

      await Promise.all([
        removeCash(target.id, message.guild.id, finalSteal),
        addCash(userId, message.guild.id, finalSteal)
      ]);

      alertEmbed = new EmbedBuilder()
        .setTitle("💸 Heist Successful!")
        .setDescription(`<@${userId}> stole **$${finalSteal}** from <@${target.id}>.`)
        .setColor("#00ff88")
        .addFields({ name: "🔥 Heat Level", value: getHeatRank(heat.heat), inline: true })
        .setTimestamp();

    } else {
      const lost = Math.floor(yourBalance * (Math.random() * 0.1 + 0.1));
      await removeCash(userId, message.guild.id, lost);

      // ✅ GANG BRIBE BONUS
      if (gangInfo?.bonus === "bribe") {
        const refund = Math.floor(lost * 0.25);
        await addCash(userId, message.guild.id, refund);
        message.channel.send(`💵 **Gang Bonus:** Recovered $${refund} with Syndicate bribe.`);
      }

      alertEmbed = new EmbedBuilder()
        .setTitle("🚨 Failed Robbery!")
        .setDescription(`<@${userId}> got caught trying to rob <@${target.id}> and lost **$${lost}**.`)
        .setColor("#ff4444")
        .addFields({ name: "🔥 Heat Level", value: getHeatRank(heat.heat), inline: true })
        .setTimestamp();
    }

    // ✅ Embed Identity
    if (gangInfo) {
      alertEmbed.setAuthor({
        name: `${gangInfo.icon} ${gangInfo.name}`,
        iconURL: message.author.displayAvatarURL()
      });
    }

    message.channel.send({ embeds: [alertEmbed] });
    stealCooldowns.set(userId, now + 5 * 60 * 1000); // 5m
  }
});

client.commands.set('crime', {
  async execute(message) {
    const userId = message.author.id;
    const guildId = message.guild.id;
    const userLevel = (await Levels.fetch(userId, guildId))?.level || 1;

    const tier = Math.min(Math.floor(userLevel / 5), 4); // Tiers 0–4
    const crimes = [
      { name: 'Snatch a purse', xp: 10, rewardRange: [50, 120], failRate: 0.3 },
      { name: 'Break into a car', xp: 15, rewardRange: [100, 200], failRate: 0.35 },
      { name: 'Rob a corner store', xp: 25, rewardRange: [150, 300], failRate: 0.4 },
      { name: 'Hack a crypto wallet', xp: 40, rewardRange: [250, 600], failRate: 0.45 },
      { name: 'Heist a gang stash house', xp: 60, rewardRange: [500, 1000], failRate: 0.5 }
    ];

    const base = crimes[tier];

    // 💊 Check for boosters
    const inventory = await getInventory(userId, guildId);
    const usingAdderall = inventory.has('crime_boost');
    const usingRedBull = inventory.has('xp_boost');
    const usingDice = inventory.has('luck_dice');

    let boostedSuccessChance = usingAdderall ? 0.25 : 0;
    let xpMultiplier = usingRedBull ? 2 : 1;

    let successChance = 1 - base.failRate + boostedSuccessChance;
    const guaranteed = usingDice;
    const failed = !guaranteed && Math.random() > successChance;

    const reward = Math.floor(Math.random() * (base.rewardRange[1] - base.rewardRange[0]) + base.rewardRange[0]);
    const xpGain = Math.floor(base.xp * xpMultiplier);

    let description = '';
    let embedColor = failed ? '#ff4444' : '#33cc66';

    if (failed) {
      description = `❌ **You tried ${base.name}... and got chased off!**\nNo rewards.${usingAdderall ? ' 💊 Wasted your Adderall.' : ''}`;
    } else {
      await addCash(userId, guildId, reward);
      await Levels.appendXp(userId, guildId, xpGain);

      description = `✅ **You pulled off: ${base.name}!**\n💸 +$${reward} | 🧠 +${xpGain} XP`;
      if (usingAdderall) description += ' | 💊 Boosted';
      if (usingRedBull) description += ' | ⚡ 2x XP';
      if (usingDice) description += ' | 🎲 Guaranteed';
    }

    // 🎯 Remove used items
    if (usingAdderall) await removeItem(userId, guildId, 'crime_boost', 1);
    if (usingRedBull) await removeItem(userId, guildId, 'xp_boost', 1);
    if (usingDice) await removeItem(userId, guildId, 'luck_dice', 1);

    const embed = new EmbedBuilder()
      .setTitle(failed ? '🚨 Crime Failed!' : '💼 Crime Success!')
      .setDescription(description)
      .setFooter({ text: `Crime Tier: ${tier + 1} • Level ${userLevel}` })
      .setColor(embedColor)
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
});



client.commands.set('wanted', {
  execute(message, args) {
    const target = message.mentions.users.first() || message.author;
    const state = wantedMap.get(target.id) || { fails: 0, watched: false };

    const embed = new EmbedBuilder()
      .setTitle(`🚔 Wanted Status: ${target.username}`)
      .addFields(
        { name: "❌ Failed Heists", value: `${state.fails} attempt(s)`, inline: true },
        { name: "👁️ Status", value: state.watched ? "🚨 **Watched**" : "✅ Not Watched", inline: true }
      )
      .setColor(state.watched ? "#ff0000" : "#00ff88")
      .setTimestamp()
      .setFooter({ text: 'Crime Watchlist' });

    message.channel.send({ embeds: [embed] });
  }
});

client.commands.set('bounty', {
  async execute(message) {
    const target = message.mentions.users.first();
    if (!target) return message.reply("Use: `!bounty @user`");
    if (target.id === message.author.id) return message.reply("You can’t target yourself.");

    const targetState = wantedMap.get(target.id);
    if (!targetState || !targetState.watched) return message.reply("They're not being watched.");

    const hideout = hideoutMap.get(target.id);
    if (hideout && hideout > Date.now()) return message.reply("They're hiding.");

    const [targetInventory] = await Promise.all([
      getInventory(target.id, message.guild.id)
    ]);

    const streak = crimeStreaks.get(target.id) || { success: 0 };
    const heat = heatMap.get(target.id) || { heat: 0 };
    let multiplier = 1;

    multiplier += Math.min(streak.success * 0.1, 0.5);
    if (targetInventory.has('skull')) multiplier += 0.25;
    if (heat.heat >= 100) multiplier += 0.5;
    else if (heat.heat >= 75) multiplier += 0.3;

    let reward = Math.floor((Math.random() * 300 + 200) * multiplier);

    // ✅ GANG BOUNTY CUT
    const gang = gangMap.get(message.author.id);
    const gangInfo = gangs[gang];
    if (gangInfo?.bonus === "bounty") {
      const cut = Math.floor(reward * 0.2);
      await addCash(message.author.id, message.guild.id, cut);
      message.channel.send(`💣 **Gang Bonus:** +$${cut} reward cut from ${gangInfo.name}`);
    }

    await Promise.all([
      addCash(message.author.id, message.guild.id, 100),
      removeCash(target.id, message.guild.id, reward)
    ]);

    const bountyEmbed = new EmbedBuilder()
      .setTitle("🎯 Bounty Placed!")
      .setDescription(`<@${message.author.id}> has placed a bounty on <@${target.id}>`)
      .addFields(
        { name: "💥 Deducted", value: `$${reward}`, inline: true },
        { name: "🔥 Heat Rank", value: getHeatRank(heat.heat), inline: true },
        {
          name: "🎯 Breakdown", value: `
Streak: \`+${Math.min(streak.success * 10, 50)}%\`
Skull: ${targetInventory.has('skull') ? '`+25%`' : '`None`'}
Heat: ${heat.heat >= 100 ? '`+50%`' : heat.heat >= 75 ? '`+30%`' : '`None`'}`.trim()
        }
      )
      .setColor("#ff5555")
      .setTimestamp();

    if (gangInfo) {
      bountyEmbed.setAuthor({
        name: `${gangInfo.icon} ${gangInfo.name}`,
        iconURL: message.author.displayAvatarURL()
      });
    }

    message.channel.send({ embeds: [bountyEmbed] });
    wantedMap.set(target.id, { fails: 0, watched: false });
  }
});


client.commands.set('hideout', {
  async execute(message) {
    const cooldown = hideoutMap.get(message.author.id);
    const now = Date.now();

    if (cooldown && cooldown > now) {
      const minsLeft = Math.ceil((cooldown - now) / 60000);
      return message.reply(`🕵️ You’re already in hiding for another ${minsLeft} minute(s).`);
    }

    // 10 minutes of hiding time
    const duration = 10 * 60 * 1000;
    hideoutMap.set(message.author.id, now + duration);

    const embed = new EmbedBuilder()
      .setTitle("🏚️ You’ve Entered a Hideout")
      .setDescription(`You're off the grid. No PvP crimes can affect you for the next **10 minutes**.`)
      .setColor("#5555ff")
      .setFooter({ text: "Hiding in plain sight..." })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
});

client.commands.set('use', {
  async execute(message, args) {
    const userId = message.author.id;
    const item = args[0]?.toLowerCase();
    const amount = parseInt(args[1]) || 1;

    const key = `use_${item}_${userId}`;
global.useCounts = global.useCounts || new Map();
global.useCounts.set(key, (global.useCounts.get(key) || 0) + amount);


    if (!item) return message.reply("Usage: `!use <item> [amount]`");

    const inventory = await getInventory(userId, message.guild.id);
    if (!inventory.has(item)) return message.reply("❌ You don’t own that item.");

    const currentCount = inventory.get(item);
    if (currentCount < amount) return message.reply(`❌ You only have ${currentCount} ${item}(s).`);

    await removeItem(userId, message.guild.id, item, amount);
    // Track Combo Usage Sequence
let combo = itemComboTracker.get(userId) || [];
combo.push(item);
if (combo.length > 3) combo = combo.slice(-3);
itemComboTracker.set(userId, combo);

// Check for special combo: Gem → Dice → Skull
if (combo.join(',') === 'gem,dice,skull') {
  comboBuffs.set(userId, {
    expiresAt: Date.now() + 15 * 60 * 1000, // 15 min buff
    bonuses: {
      xpBoost: 1.5,
      rareDropBoost: true,
      crimeBonus: true
    }
  });

  const embed = new EmbedBuilder()
    .setTitle("🧬 Combo Activated: Greedy Gambler")
    .setDescription("You've triggered a powerful chain! For the next 15 minutes:\n- 🧠 XP Boost x1.5\n- 🎲 Better odds on crime\n- 💎 Rare item drop chance increased")
    .setColor("#ff55ff")
    .setFooter({ text: "Greedy Gambler Activated" })
    .setTimestamp();

  message.channel.send({ content: `<@${userId}>`, embeds: [embed] });

  // Reset combo so it doesn’t stack again immediately
  itemComboTracker.set(userId, []);
}


    const emojiMap = {
      gem: '💎',
      medal: '🎖️',
      dice: '🎲',
      skull: '💀',
      disguise: '🕵️',
      lease: '🏠',
    };
    const emoji = emojiMap[item] || '🔸';

    // Animation
    const useMsg = await message.channel.send(`Consuming ${amount} ${item}(s)...`);
    const steps = Math.min(amount, 10);
    for (let i = 1; i <= steps; i++) {
      await new Promise(res => setTimeout(res, 200));
      await useMsg.edit(emoji.repeat(i));
    }

    let resultText = "✅ You used your items.";

    switch (item) {
      case 'vest':
        resultText = `🛡️ You equipped a Reflective Vest. It'll block the next robbery attempt.`;
        // No immediate effect — it's consumed automatically in the steal command
        break;
      

      case 'gem':
        await addCash(userId, message.guild.id, 100 * amount);
        resultText = `💸 You used ${amount} Gem(s) and gained $${amount * 100} DreamworldPoints.`;
        break;

      case 'medal':
        await addCash(userId, message.guild.id, 50 * amount);
        resultText = `🎖️ You used ${amount} Medal(s) and gained $${amount * 50} DreamworldPoints.`;
        break;

      case 'dice':
        const totalXP = Array.from({ length: amount }, () => Math.floor(Math.random() * 20 + 10)).reduce((a, b) => a + b, 0);
        await Levels.appendXp(userId, message.guild.id, totalXP);
        resultText = `🎲 You rolled ${amount} Dice and gained ${totalXP} XP.`;
        break;

      case 'skull':
        const oldCooldown = stealCooldowns.get(userId) || 0;
        stealCooldowns.set(userId, Math.max(Date.now(), oldCooldown - 2 * 60 * 1000 * amount));
        resultText = `💀 You used ${amount} Skull Ring(s). Crime cooldown reduced by ${2 * amount} minutes.`;
        break;

      case 'disguise':
        wantedMap.set(userId, { fails: 0, watched: false });
        hideoutMap.set(userId, Date.now() + 5 * 60 * 1000);
        const stats = pvpStats.get(userId) || { bounties: 0, pvpWins: 0, hideouts: 0, survived: 0 };
        stats.hideouts++;
        pvpStats.set(userId, stats);
        if (stats.hideouts === 10) {
          unlockAchievement(userId, "Shadow Lurker", "🕵️", "Used the hideout 10 times to stay unseen.", message.channel);
        }
        resultText = "🕵️ You used a Disguise Kit. You’re hidden from PvP for 5 minutes.";
        break;

      case 'lease':
        hideoutMap.set(userId, Date.now() + 10 * 60 * 1000);
        resultText = "🏡 You extended your safehouse lease. You’re hidden for 10 minutes.";
        break;

      default:
        resultText = "⚠️ That item doesn’t have a use yet...";
    }

    await useMsg.edit(resultText);
  }
});

client.commands.set('lurk', {
  async execute(message) {
    const userId = message.author.id;
    const guildId = message.guild.id;
    const xpGain = Math.floor(Math.random() * 5) + 10; // Slightly higher base XP

    await Levels.appendXp(userId, guildId, xpGain);

    // 🔁 Track lurk streaks
    global.lurkTracker = global.lurkTracker || new Map();
    const data = global.lurkTracker.get(userId) || { count: 0, last: 0 };

    const now = Date.now();
    const timeSinceLast = now - data.last;

    // Reset if too long between lurks (30 min)
    const count = timeSinceLast < 30 * 60 * 1000 ? data.count + 1 : 1;
    global.lurkTracker.set(userId, { count, last: now });

    // 🎁 Scaling Buffs / Events
    let extras = '';
    let bonusXp = 0;

    if (count === 3) {
      extras += '\n🔥 **Lurker Buff:** +10 XP every crime for 10 mins.';
      fireBuffs.set(userId, { xpBoost: 1.5, expiresAt: now + 10 * 60 * 1000 });
    }

    if (count === 5) {
      extras += '\n👀 You overheard a PVP secret. +1 Steal Success Rate next robbery.';
      pvpTasks.set(userId, { crimes: 1, lastReset: now });
    }

    if (count >= 7 && count % 3 === 1) {
      const reward = Math.floor(Math.random() * 200 + 100);
      await addCash(userId, guildId, reward);
      extras += `\n💸 Found a burner wallet. +$${reward}`;
    }

    // 🔥 Drama Trigger Chance
    if (Math.random() < 0.07) {
      const dramaEmbed = new EmbedBuilder()
        .setTitle("📢 Lurker Exposed!")
        .setDescription(`<@${userId}> thought they were hidden...\nBut someone just spotted them watching from the shadows.`)
        .setColor('#ff3333')
        .setFooter({ text: 'Drama always finds you eventually.' });

      message.channel.send({ embeds: [dramaEmbed] });
    }

    const embed = new EmbedBuilder()
      .setTitle("🕶️ Lurking...")
      .setDescription(`You gained **${xpGain} XP** for staying silent and observant.\n\n🔁 Lurk Chain: **${count}x**${extras}`)
      .setColor('#5555ff')
      .setThumbnail(message.author.displayAvatarURL())
      .setFooter({ text: 'The shadows remember your footsteps...' })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
});


client.commands.set('scavenge', {
  async execute(message) {
    const userId = message.author.id;

    // Cooldown check (10 minutes)
    const cooldown = scavengeCooldowns.get(userId) || 0;
    const now = Date.now();
    if (cooldown > now) {
      const secondsLeft = Math.ceil((cooldown - now) / 1000);
      return message.reply(`🕳️ You're still searching... try again in ${secondsLeft}s.`);
    }

    const failChance = Math.random();
    if (failChance < 0.25) {
      // 25% chance to find nothing
      scavengeCooldowns.set(userId, now + 10 * 60 * 1000);
      return message.reply("🪨 You rummaged through trash but found nothing this time.");
    }

    // Reward range
    const cash = Math.floor(Math.random() * 70) + 30; // $30–$100
    const xp = Math.floor(Math.random() * 30) + 20;   // 20–50 XP

    await addCash(userId, message.guild.id, cash);
    await Levels.appendXp(userId, message.guild.id, xp);

    scavengeCooldowns.set(userId, now + 10 * 60 * 1000);

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Scavenge Results")
      .setDescription(`You found some scraps while scavenging.`)
      .addFields(
        { name: "💸 Cash", value: `$${cash}`, inline: true },
        { name: "🧠 XP", value: `${xp} XP`, inline: true }
      )
      .setColor("#999999")
      .setFooter({ text: "Try again in 10 minutes." })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
});

client.commands.set('heat', {
  execute(message) {
    const data = heatMap.get(message.author.id) || { heat: 0 };
    const rank = getHeatRank(data.heat);

    const embed = new EmbedBuilder()
      .setTitle("🔥 Your Heat Rank")
      .setDescription(`You are currently marked as: **${rank}**\nHeat Score: ${data.heat}/100`)
      .setColor('#ff4444')
      .setFooter({ text: "Crime reputation affects all PvP rewards..." });

    message.channel.send({ embeds: [embed] });
  }
});

// Gang definitions
const gangs = {
  voodoo: {
    name: "On Point Gang",
    icon: "👓",
    bonus: "+1m cooldown to robbery attempts against you",
  },
  steel: {
    name: "Blitz Mode",
    icon: "🚬",
    bonus: "+15% XP and +10% cash from challenges",
  },
  lotus: {
    name: "Red Box Service",
    icon: "⚰🩸",
    bonus: "+25% PvP steal damage",
  },
  syndicate: {
    name: "Blue Fence",
    icon: "🙅‍♂️💵",
    bonus: "+10% item profit",
  },
  whisper: {
    name: "Digital Wipe",
    icon: "👨‍💻🧢",
    bonus: "-50% heat gain",
  },
};

// == !joingang Command ==
client.commands.set("joingang", {
  async execute(message, args) {
    const choice = (args[0] || "").toLowerCase();
    if (!gangs[choice]) {
      const gangList = Object.entries(gangs)
        .map(([key, g]) => `**${g.icon} ${g.name}** - ${g.bonus} → \`!joingang ${key}\``)
        .join("\n");
      return message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Choose Your Gang")
            .setDescription(gangList)
            .setColor("#aa00ff")
        ]
      });
    }

    const userId = message.author.id;
    gangMap.set(userId, choice);
    const gang = gangs[choice];

    message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${gang.icon} Joined ${gang.name}`)
          .setDescription(`You are now a member of the **${gang.name}**. Bonus: ${gang.bonus}`)
          .setColor("#ff4488")
      ]
    });
  },
});

function generatePrices() {
  const prices = {};
  for (const d of drugs) {
    prices[d.id] = d.base + Math.floor(Math.random() * (d.volatility * 2 + 1)) - d.volatility;
  }
  return prices;
}


// == Helper Function ==
function getGang(userId) {
  const key = gangMap.get(userId);
  return key ? gangs[key].icon + " " + gangs[key].name : "None";
}

client.commands.set('ganginfo', {
  async execute(message) {
    const gang = getGang(message.author.id);
    if (!gang) return message.reply("You are not part of any gang. Use `!joingang` to pick one.");

    const embed = new EmbedBuilder()
      .setTitle(`${gang.emoji} ${gang.name}`)
      .setDescription(`**Bonus Effect:** ${gang.description}`)
      .setColor("#ff9900")
      .setFooter({ text: `Gang allegiance is permanent... for now.` })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
});

client.commands.set('turf', {
  execute(message) {
    const lines = [];
    for (const [zone, data] of turfZones.entries()) {
      lines.push(`🏙️ **${zone}** — Controlled by: **${getGangEmoji(data.owner)} ${data.owner}**`);
    }

    const embed = new EmbedBuilder()
      .setTitle("🌆 Current Turf Control")
      .setDescription(lines.join("\n"))
      .setColor('#ffaa00')
      .setFooter({ text: "Use !raid <zone> to attack." });

    message.channel.send({ embeds: [embed] });
  }
});

client.commands.set('raid', {
  async execute(message, args) {
    const zone = args.join(" ");
    if (!turfZones.has(zone)) {
      return message.reply("❌ That zone doesn't exist. Try: Downtown, Back Alley, Warehouse");
    }

    const now = Date.now();
    const userId = message.author.id;
    const userGang = gangMap.get(userId);
    if (!userGang) return message.reply("❌ You must be in a gang to initiate a raid.");

    const cooldown = turfRaidCooldowns.get(userId) || 0;
    if (now < cooldown) {
      const seconds = Math.ceil((cooldown - now) / 1000);
      return message.reply(`⏳ You must wait ${seconds}s before launching another raid.`);
    }

    const zoneData = turfZones.get(zone);
    const defendingGang = zoneData.owner;

    if (defendingGang === userGang) {
      return message.reply("⚠️ You already control this zone.");
    }

    // 🎲 Raid Logic
    const success = Math.random() < 0.5;
    const result = success ? "Raid Successful" : "Raid Failed";

    const embed = new EmbedBuilder()
      .setTitle(success ? `🚩 ${result}` : "🛑 Raid Repelled!")
      .setDescription(
        success
          ? `**<@${userId}>** and the **${getGangEmoji(userGang)} ${userGang}** took over **${zone}** from the **${getGangEmoji(defendingGang)} ${defendingGang}**!`
          : `**<@${userId}>** led an attack on **${zone}**, but the **${getGangEmoji(defendingGang)} ${defendingGang}** stood strong and held the turf.`
      )
      .addFields(
        { name: "📍 Zone", value: zone, inline: true },
        { name: "🔁 Cooldown", value: "5 minutes", inline: true },
        { name: "🎭 Attacker", value: `${getGangEmoji(userGang)} ${userGang}`, inline: true },
        { name: "🛡️ Defender", value: `${getGangEmoji(defendingGang)} ${defendingGang}`, inline: true }
      )
      .setColor(success ? "#33cc33" : "#ff4444")
      .setThumbnail(message.author.displayAvatarURL())
      .setFooter({ text: success ? "Turf Captured" : "Defense Successful" })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });

    if (success) {
      turfZones.set(zone, { owner: userGang, lastRaid: now });
    }

    turfRaidCooldowns.set(userId, now + 5 * 60 * 1000); // 5-min cooldown
  }
});

client.commands.set('fortify', {
  async execute(message, args) {
    const userId = message.author.id;
    const gang = gangMap.get(userId);
    if (!gang) return message.reply("❌ You must be in a gang to fortify turf.");

    const ownedZones = [...turfZones.entries()].filter(([_, zone]) => zone.owner === gang);
    if (ownedZones.length === 0) {
      return message.reply("❌ Your gang doesn't own any turf to fortify.");
    }

    const zone = ownedZones[0][0]; // Pick the first owned turf
    const level = turfFortifications.get(zone) || 0;
    if (level >= 3) {
      return message.reply(`🏰 **${zone}** is already fully fortified.`);
    }

    const newLevel = level + 1;
    turfFortifications.set(zone, newLevel);

    const emojis = ["🔰", "🛡️", "🏰"];
    const embed = new EmbedBuilder()
      .setTitle("🔧 Turf Fortified!")
      .setDescription(`**<@${userId}>** has fortified **${zone}**.\nFortification Level: ${emojis[newLevel - 1]} (${newLevel}/3)`)
      .setColor("#0088ff")
      .setFooter({ text: `${gang} stronghold reinforced.` })
      .setTimestamp();

    message.channel.send({ embeds: [embed] });
  }
});

const timeAgo = (timestamp) => {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60 * 1000) return "just now";
  const mins = Math.floor(diff / (60 * 1000));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  return `${mins} minute${mins > 1 ? "s" : ""} ago`;
};

client.commands.set('map', {
  async execute(message) {
    const emojis = ["🔰", "🛡️", "🏰"];
    const embed = new EmbedBuilder()
      .setTitle("🗺️ Turf Map")
      .setDescription("Current status of all gang-controlled zones.")
      .setColor("#ffaa00")
      .setFooter({ text: "Use !raid <zone> to challenge a turf." })
      .setTimestamp();

    for (const [zone, data] of turfZones.entries()) {
      const fort = turfFortifications.get(zone) || 0;
      const emoji = emojis[fort - 1] || "❌";
      const last = data.lastRaid ? timeAgo(data.lastRaid) : "Never";
      embed.addFields({
        name: `🏙️ ${zone}`,
        value: `👑 Owner: ${data.owner}\n🛡️ Fort: ${emoji} (${fort}/3)\n⏱️ Last Raid: ${last}`,
        inline: false
      });
    }

    message.channel.send({ embeds: [embed] });
  }
});

client.commands.set('dealer', {
  async execute(message) {
    const userId = message.author.id;
    const guildId = message.guild.id;

    if (!dealerProfiles.has(userId)) {
      dealerProfiles.set(userId, {
        cash: 0,
        stashUsed: 0,
        stashCap: 20,
        inventory: {},
        prices: generatePrices(),
        lastPriceUpdate: Date.now(),
        lastEventTime: 0,
        lastMarketMessageId: null,
        raidCooldown: 0
      });
    }

    const profile = dealerProfiles.get(userId);
    const now = Date.now();

    // ✅ Fix: Don't reset stash on !dealer
    profile.inventory = profile.inventory || {};
    profile.stashUsed = Object.values(profile.inventory).reduce((a, b) => a + b, 0);

    // 🕓 Price Update
    if (now - profile.lastPriceUpdate > 60000) {
      profile.prices = generatePrices();
      profile.lastPriceUpdate = now;
    }

    // 📈 Price spike alert
    for (const d of drugs) {
      const price = profile.prices[d.id];
      if (price > d.base * 1.5) {
        message.channel.send(`📈 ${d.name} is spiking at $${price}! Time to move fast!`);
      }
    }

    const bal = await getBalance(userId, guildId);
    const embed = generateMarketEmbed(message.author, profile, bal);

    // Buttons
    const allRows = [];
    for (let i = 0; i < drugs.length; i += 2) {
      const row = new ActionRowBuilder();
      for (let j = i; j < i + 2 && j < drugs.length; j++) {
        const d = drugs[j];
        row.addComponents(
          new ButtonBuilder().setCustomId(`buy_drug_${d.id}`).setLabel(`🛒 Buy ${d.name.replace(/[^a-zA-Z]/g, '')}`).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`sell_drug_${d.id}`).setLabel(`💰 Sell ${d.name.replace(/[^a-zA-Z]/g, '')}`).setStyle(ButtonStyle.Secondary)
        );
      }
      allRows.push(row);
    }

    const sent = await message.channel.send({ embeds: [embed], components: allRows });
    profile.lastMarketMessageId = sent.id;
  }
});

function generateMarketEmbed(user, profile, balance) {
  let desc = `💰 **$${balance}** DreamworldPoints\n📦 Stash: **${profile.stashUsed}/${profile.stashCap}**`;
  if (profile.stashUsed >= profile.stashCap) desc += ` 🔴 (FULL)`;
  if (balance <= 100) desc += ` ⚠️ (Low Funds)`;

  const embed = new EmbedBuilder()
    .setTitle(`💊 Street Market — ${user.username}`)
    .setDescription(desc)
    .setColor('#ff55ff')
    .setFooter({ text: 'Prices update every 1 minute automatically' })
    .setTimestamp();

  for (const d of drugs) {
    const price = profile.prices[d.id];
    const qty = profile.inventory[d.id] || 0;
    embed.addFields({
      name: `${d.name} — $${price}`,
      value: `You own: **${qty}**`,
      inline: true
    });
  }

  return embed;
}

// ADMIN COMMAND !award @user 1000 //
client.commands.set('award', {
  async execute(message, args) {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply("❌ You need admin permissions to use this command.");
    }

    const target = message.mentions.users.first();
    const amount = parseInt(args[1]);

    if (!target || isNaN(amount) || amount <= 0) {
      return message.reply("Usage: `!award @user 500`");
    }

    await addCash(target.id, message.guild.id, amount);
    message.channel.send(`💸 Awarded <@${target.id}> with **$${amount}** DreamworldPoints.`);
  }
});


// Run this every 5 minutes
setInterval(() => {
  for (const t of todaySnipes) {
    scanTicker(client, t);
    scanOptionsFlow(client, t);
  }
}, 14400 * 60 * 1000);


cron.schedule('0 16 * * *', () => { // 12 PM ET is 16:00 UTC
  console.log("⏰ Running daily NBA predictions...");
  runDailyPredictions(client);
});

client.commands.set('bail', {
  async execute(message) {
    const userId = message.author.id;
    const release = prisonUsers.get(userId);

    if (!release || Date.now() > release) {
      return message.reply("✅ You’re not currently in prison.");
    }

    const balance = await getBalance(userId, message.guild.id);
    const cost = Math.floor(balance * 0.3);

    if (balance < cost) {
      return message.reply(`💸 You need at least $${cost} DreamworldPoints to pay bail.`);
    }

    await removeCash(userId, message.guild.id, cost);
    prisonUsers.delete(userId);

    message.reply(`🔓 You paid **$${cost}** bail and escaped prison early.`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const prisonTime = prisonUsers.get(message.author.id);
  if (prisonTime && Date.now() < prisonTime) {
    if (message.channel.name !== 'prison') {
      await message.delete().catch(() => {});
      message.author.send("⛓️ You’re in prison. Only messages in #prison are allowed until you’re released or post bail.");
    }
  }
});

client.commands.set('prisontotal', {
  execute(message) {
    const total = Array.from(prisonBalances.values()).reduce((a, b) => a + b, 0);
    message.channel.send(`🏦 The PrisonBot is holding $${total} DreamworldPoints from recent busts.`);
  }
});

client.commands.set('prison', {
  async execute(message) {
    if (message.channel.name !== 'prison') {
      return message.reply("❌ You can only run this command in the **#prison** channel.");
    }

    const embed = new EmbedBuilder()
      .setTitle('🏚️ Prison Activity Menu')
      .setDescription("Choose your path:\n\n🧪 **Smuggle** — Risky delivery job.\n🐀 **Rat** — Snitch on someone for a quick bag.\n🔥 **Riot** — Chaos with random outcomes.")
      .setColor('#990000')
      .setFooter({ text: 'Prison Quests – Keep your rep alive.' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prison_smuggle').setLabel('🧪 Smuggle').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('prison_rat').setLabel('🐀 Rat').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('prison_riot').setLabel('🔥 Riot').setStyle(ButtonStyle.Danger)
    );

    await message.reply({ embeds: [embed], components: [row] });
  }
});

client.commands.set('prisonrecord', {
  async execute(message) {
    const userId = message.author.id;

    // Prison data maps
    const ratList = global.prisonRats || new Map();
    const riotFails = global.riotFails || new Map();
    const riotWins = global.riotWins || new Map();
    const smuggleWins = global.smuggleWins || new Map();

    const ratted = ratList.get(userId);
    const failed = riotFails.get(userId) || 0;
    const riots = riotWins.get(userId) || 0;
    const smuggles = smuggleWins.get(userId) || 0;

    // Title Achievements
    const titles = [];
    if (riots >= 3) titles.push("🧨 Riot Lord");
    if (ratted) titles.push("🐀 King Snitch");
    if (smuggles >= 5) titles.push("📦 Cartel Runner");

    const embed = new EmbedBuilder()
      .setTitle(`📂 Prison Record — ${message.author.username}`)
      .setColor('#aa0000')
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: "🐀 Ratted On", value: ratted ? `**${ratted}**` : "`None`", inline: true },
        { name: "🔥 Failed Riots", value: `\`${failed}\``, inline: true },
        { name: "🧨 Successful Riots", value: `\`${riots}\``, inline: true },
        { name: "📦 Smuggle Missions", value: `\`${smuggles}\``, inline: true },
        { name: "🏆 Titles", value: titles.length ? titles.join(" • ") : "`None unlocked yet`", inline: false }
      )
      .setFooter({ text: "Prison tracks everything. Even whispers." })
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }
});


setInterval(async () => {
  const guild = client.guilds.cache.get(1353730054693064816);
  const channel = guild.channels.cache.find(c => c.name === 'general'); // Or wherever !dealer is used
  if (!channel) return;

  const npc = npcNames[Math.floor(Math.random() * npcNames.length)];
  const drug = drugs[Math.floor(Math.random() * drugs.length)];
  const qty = Math.floor(Math.random() * 4) + 1;
  const total = qty * (drug.base + Math.floor(Math.random() * drug.volatility));

  channel.send(`🧥 **${npc}** just bought **${qty}x ${drug.name}** for **$${total}**.\nStreet prices heating up...`);

  // Optional: Boost price volatility temporarily
  for (const [uid, profile] of dealerProfiles.entries()) {
    profile.prices[drug.id] += Math.floor(Math.random() * 30);
  }
}, Math.floor(Math.random() * 2 * 60 * 1000) + 120000); // every 2–4 min


setInterval(() => {
  scanAllSnipers(client);
}, 144000 * 60 * 5); // Every 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [id, end] of hideoutMap.entries()) {
    if (end <= now) hideoutMap.delete(id);
  }
}, 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of heatMap) {
    if (now - data.lastActivity >= 10 * 60 * 1000) { // 10 minutes of no activity
      data.heat = Math.max(0, data.heat - 10);
      heatMap.set(userId, data);
    }
  }
}, 5 * 60 * 1000); // Check every 5 mins


// Chaos event every hour
setInterval(() => {
  triggerChaosEvent(client);
}, 60 * 60 * 1000); // every hour

app.use('/stripe/webhook', stripeWebhook);
app.use('/paypal/webhook', paypalWebhook);
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('Keep-alive server running'));
