import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  AutoModerationRuleKeywordPresetType,
  AutoModerationActionType,
  AutoModerationRuleTriggerType,
  ChannelSelectMenuBuilder,
  AttachmentBuilder,
  type Interaction,
  type Guild,
  type GuildMember,
  type TextChannel,
  type CategoryChannel,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type ChatInputCommandInteraction,
  type ChannelSelectMenuInteraction,
} from "discord.js";

import { logger } from "../lib/logger.js";
import {
  OWNER_ID,
  REGULAR_CATEGORIES,
  FARM_CATEGORY,
  ALL_CATEGORIES,
  BOT_COLOR,
  SUCCESS_COLOR,
  ERROR_COLOR,
  WARNING_COLOR,
  GOLD_COLOR,
  BUILD_TICKET_ROLE_ID,
  GIVEAWAY_ROLE_ID,
  TICKET_LOG_CHANNEL_ID,
  TRANSCRIPT_CHANNEL_ID,
  MOD_ROLE_IDS,
  STAFF_ROLE_IDS,
  SKELLY_CATEGORY,
} from "./config.js";
import { storage, type GiveawayEntry } from "./storage.js";

const TOKEN = process.env["DISCORD_BOT_TOKEN"];
const DONUTSMP_API_KEY = process.env["DONUTSMP_API_KEY"];

const ONLINE_COLOR = 0x57f287;
const OFFLINE_COLOR = 0xed4245;
const CLAIM_HOURS = 12;
const BLACKLISTED_ROLE_ID = "1518639268925407373";

let _client: Client | null = null;

const activeGiveawayTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeClaimTimers = new Map<string, ReturnType<typeof setTimeout>>();

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return String(n);
}

function fmtPlaytime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}


function ticketTag(n: number) {
  return `#${String(n).padStart(4, "0")}`;
}

// ─── Giveaway Utilities ────────────────────────────────────────────────────

function genGiveawayId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function parseDuration(input: string): number | null {
  const cleaned = input.trim().replace(/\s+/g, "");
  const match = cleaned.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || cleaned === "") return null;
  const [, d, h, m, s] = match;
  const ms =
    (parseInt(d ?? "0") * 86400 +
      parseInt(h ?? "0") * 3600 +
      parseInt(m ?? "0") * 60 +
      parseInt(s ?? "0")) *
    1000;
  return ms > 0 ? ms : null;
}

function doublePrize(prize: string): string {
  const match = prize.trim().match(/^(\d+(?:\.\d+)?)\s*([mb])$/i);
  if (!match) return `2x ${prize}`;
  const suffix = match[2].toLowerCase();
  let num = parseFloat(match[1]) * 2;
  let unit = suffix;
  // Normalise: 1000m+ → b
  if (unit === "m" && num >= 1000) {
    num = num / 1000;
    unit = "b";
  }
  const formatted = Number.isInteger(num) ? num.toString() : parseFloat(num.toFixed(2)).toString();
  return `${formatted}${unit}`;
}

function buildGiveawayEmbed(gw: GiveawayEntry): EmbedBuilder {
  const endTs = Math.floor(new Date(gw.endTime).getTime() / 1000);
  const winnerLabel = gw.winnersCount === 1 ? "Winner" : "Winners";
  let desc = `**Ends:** <t:${endTs}:R> (<t:${endTs}:f>)\n`;
  desc += `**${winnerLabel}:** ${gw.winnersCount}\n`;
  desc += `**Entries:** ${gw.entries.length}\n`;
  desc += `**Hosted by:** <@${gw.hostId}>`;
  if (gw.description) desc += `\n\n${gw.description}`;
  return new EmbedBuilder()
    .setColor(0xf47bff)
    .setTitle(gw.prize)
    .setDescription(desc)
    .setFooter({ text: `Giveaway • ID: ${gw.id}` })
    .setTimestamp(new Date(gw.endTime));
}

function buildGiveawayEndedEmbed(gw: GiveawayEntry): EmbedBuilder {
  const endTs = Math.floor(new Date(gw.endTime).getTime() / 1000);
  const winnersStr =
    gw.winners.length > 0 ? gw.winners.map((id) => `<@${id}>`).join(", ") : "No winners";
  const winnerLabel = gw.winnersCount === 1 ? "Winner" : "Winners";
  let desc = `**${winnerLabel}:** ${winnersStr}\n\n`;
  desc += `**Ended:** <t:${endTs}:R>\n`;
  desc += `**Total Entries:** ${gw.entries.length}\n`;
  desc += `**Hosted by:** <@${gw.hostId}>`;
  if (gw.description) desc += `\n\n${gw.description}`;
  return new EmbedBuilder()
    .setColor(0x747f8d)
    .setTitle(`${gw.prize} — Ended`)
    .setDescription(desc)
    .setFooter({ text: `Giveaway • ID: ${gw.id}` })
    .setTimestamp(new Date(gw.endTime));
}

function scheduleGiveaway(gw: GiveawayEntry) {
  const remaining = new Date(gw.endTime).getTime() - Date.now();
  if (remaining <= 0) {
    void endGiveaway(gw);
    return;
  }
  const timer = setTimeout(() => void endGiveaway(gw), remaining);
  activeGiveawayTimers.set(gw.id, timer);
}

function scheduleClaimExpiry(gw: GiveawayEntry) {
  if (!gw.claimExpiry) return;
  const remaining = new Date(gw.claimExpiry).getTime() - Date.now();
  if (remaining <= 0) {
    void expireGiveawayClaims(gw.id);
    return;
  }
  const timer = setTimeout(() => void expireGiveawayClaims(gw.id), remaining);
  activeClaimTimers.set(gw.id, timer);
}

async function endGiveaway(gw: GiveawayEntry) {
  activeGiveawayTimers.delete(gw.id);
  const client = _client;
  if (!client) return;

  const guild = client.guilds.cache.get(gw.guildId);
  if (!guild) return;

  const ch = guild.channels.cache.get(gw.channelId) as TextChannel | undefined;
  if (!ch) return;

  const shuffled = [...gw.entries].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(gw.winnersCount, shuffled.length));

  storage.endGiveaway(gw.id, winners);
  const updatedGw = storage.getGiveaway(gw.id);
  if (!updatedGw) return;

  try {
    const msg = await ch.messages.fetch(gw.messageId);
    await msg.edit({ embeds: [buildGiveawayEndedEmbed(updatedGw)], components: [] });
  } catch {}

  if (winners.length === 0) {
    await ch
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(ERROR_COLOR)
            .setDescription(`Giveaway for **${gw.prize}** ended with no entries.`)
            ,
        ],
        reply: { messageReference: gw.messageId, failIfNotExists: false },
      })
      .catch(() => {});
    return;
  }

  const gwType = updatedGw.type ?? "normal";

  if (gwType === "simple") {
    for (const winnerId of winners) {
      await ch
        .send({
          content: `Congratulations <@${winnerId}>, you won **${gw.prize}**!`,
          reply: { messageReference: gw.messageId, failIfNotExists: false },
        })
        .catch(() => {});
    }
    return;
  }

  const claimExpiry = new Date(Date.now() + CLAIM_HOURS * 60 * 60 * 1000);
  storage.setClaimExpiry(gw.id, claimExpiry.toISOString());

  for (const winnerId of winners) {
    try {
      const components =
        gwType === "double"
          ? [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`giveaway_claim_${gw.id}_${winnerId}`)
                  .setLabel("Claim")
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`giveaway_double_${gw.id}_${winnerId}`)
                  .setLabel("Double It")
                  .setStyle(ButtonStyle.Danger),
              ),
            ]
          : [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`giveaway_claim_${gw.id}_${winnerId}`)
                  .setLabel("Claim")
                  .setStyle(ButtonStyle.Primary),
              ),
            ];
      const winMsg = await ch.send({
        content: `Congratulations <@${winnerId}>, you won **${gw.prize}**!`,
        components,
        reply: { messageReference: gw.messageId, failIfNotExists: false },
      });
      storage.addWinMessage(gw.id, winnerId, winMsg.id);
    } catch {}
  }

  scheduleClaimExpiry(updatedGw);
}

async function expireGiveawayClaims(giveawayId: string) {
  activeClaimTimers.delete(giveawayId);
  const client = _client;
  if (!client) return;

  const gw = storage.getGiveaway(giveawayId);
  if (!gw) return;

  const guild = client.guilds.cache.get(gw.guildId);
  if (!guild) return;

  const ch = guild.channels.cache.get(gw.channelId) as TextChannel | undefined;
  if (!ch) return;

  for (const [winnerId, msgId] of Object.entries(gw.winMessages ?? {})) {
    if (gw.claimedBy.includes(winnerId)) continue;
    try {
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({
        content: msg.content,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`giveaway_claim_expired`)
              .setLabel("Claim Expired")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
          ),
        ],
      });
    } catch {}
  }
}

// ─── Bot Client ────────────────────────────────────────────────────────────

export function createBotClient(): Client | null {
  if (!TOKEN) {
    logger.warn("DISCORD_BOT_TOKEN not set — bot disabled. Set the secret to enable it.");
    return null;
  }
  if (!DONUTSMP_API_KEY) {
    logger.warn("DONUTSMP_API_KEY not set — /stats command will not work.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  _client = client;

  client.once("ready", async () => {
    logger.info({ tag: client.user?.tag }, "Bot ready");
    await registerCommands(client);
    for (const guild of client.guilds.cache.values()) {
      await setupAutoMod(guild).catch((e) =>
        logger.warn({ err: e, guild: guild.name }, "AutoMod failed"),
      );
    }
    // Restore timers for active giveaways
    for (const gw of storage.getActiveGiveaways()) {
      scheduleGiveaway(gw);
    }
    // Restore claim expiry timers for ended giveaways with active claims
    const allGiveaways = Object.values(storage.getData().giveaways ?? {});
    for (const gw of allGiveaways) {
      if (gw.ended && gw.claimExpiry && !activeClaimTimers.has(gw.id)) {
        scheduleClaimExpiry(gw);
      }
    }
  });

  client.on("guildCreate", async (guild) => {
    await setupAutoMod(guild).catch(() => {});
  });

  client.on("interactionCreate", (i) => {
    handleInteraction(i).catch((e) => logger.error({ err: e }, "Interaction error"));
  });

  client.login(TOKEN).catch((e) => logger.error({ err: e }, "Login failed"));
  return client;
}

async function registerCommands(client: Client) {
  if (!client.user) return;
  const rest = new REST().setToken(TOKEN!);
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Owner control panel"),
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Look up a DonutSMP player's statistics")
      .addStringOption((o) =>
        o.setName("username").setDescription("Minecraft username").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Close this ticket")
      .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false)),
    new SlashCommandBuilder()
      .setName("rename")
      .setDescription("Rename this ticket channel")
      .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true)),
    new SlashCommandBuilder()
      .setName("add")
      .setDescription("Add a user to this ticket")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Remove a user from this ticket")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("tickets").setDescription("List active tickets (staff)"),
    new SlashCommandBuilder()
      .setName("giveaway")
      .setDescription("Giveaway commands")
      .addSubcommand((sub) =>
        sub.setName("create").setDescription("Create a new giveaway in this channel"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reroll")
          .setDescription("Pick a new random winner for an ended giveaway")
          .addStringOption((opt) =>
            opt.setName("id").setDescription("Giveaway ID").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("end")
          .setDescription("Force-end a running giveaway early")
          .addStringOption((opt) =>
            opt.setName("id").setDescription("Giveaway ID").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("info")
          .setDescription("Look up full details of a giveaway by ID")
          .addStringOption((opt) =>
            opt.setName("id").setDescription("Giveaway ID").setRequired(true),
          ),
      ),
  ].map((c) => c.toJSON());

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    for (const guild of client.guilds.cache.values()) {
      await rest
        .put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: cmds })
        .catch(() => {});
    }
    logger.info("Commands registered");
  } catch (e) {
    logger.error({ err: e }, "Command registration failed");
  }
}

async function setupAutoMod(guild: Guild) {
  const existing = await guild.autoModerationRules.fetch();
  if (!existing.some((r) => r.name === "Bot – Keyword Filter")) {
    await guild.autoModerationRules
      .create({
        name: "Bot – Keyword Filter",
        eventType: 1,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: {
          keywordFilter: [],
          regexPatterns: [],
          presets: [
            AutoModerationRuleKeywordPresetType.Profanity,
            AutoModerationRuleKeywordPresetType.SexualContent,
            AutoModerationRuleKeywordPresetType.Slurs,
          ],
        },
        actions: [
          { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: "Your message was blocked." } },
        ],
        enabled: true,
        reason: "Bot AutoMod",
      })
      .catch(() => {});
  }
  if (!existing.some((r) => r.name === "Bot – Mention Spam")) {
    await guild.autoModerationRules
      .create({
        name: "Bot – Mention Spam",
        eventType: 1,
        triggerType: AutoModerationRuleTriggerType.MentionSpam,
        triggerMetadata: { mentionTotalLimit: 6, mentionRaidProtectionEnabled: true },
        actions: [
          { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: "Too many mentions." } },
        ],
        enabled: true,
        reason: "Bot AutoMod",
      })
      .catch(() => {});
  }
}

async function handleInteraction(i: Interaction) {
  if (i.isChatInputCommand()) return handleCommand(i);
  if (i.isButton()) return handleButton(i);
  if (i.isStringSelectMenu()) return handleStringSelect(i);
  if (i.isChannelSelectMenu()) return handleChannelSelect(i);
  if (i.isModalSubmit()) return handleModal(i);
}

function isOwner(id: string) { return id === OWNER_ID; }
function isStaff(m: GuildMember) {
  return isOwner(m.id)
    || m.permissions.has(PermissionFlagsBits.ManageChannels)
    || m.permissions.has(PermissionFlagsBits.Administrator)
    || STAFF_ROLE_IDS.some((id) => m.roles.cache.has(id));
}
function isMod(m: GuildMember) {
  return isOwner(m.id) || MOD_ROLE_IDS.some((id) => m.roles.cache.has(id));
}
function canManageGiveaway(m: GuildMember) {
  return isOwner(m.id) || m.roles.cache.has(GIVEAWAY_ROLE_ID);
}

async function logToChannel(guild: Guild, channelId: string, embed: EmbedBuilder) {
  const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

async function closeTicket(
  guild: Guild,
  ticket: NonNullable<ReturnType<typeof storage.getTicket>>,
  channel: TextChannel,
  closedByTag: string,
  closedById: string,
  reason: string,
) {
  const cat = ALL_CATEGORIES.find((c) => c.id === ticket.categoryId);

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const lines: string[] = [
    `=== Ticket ${ticketTag(ticket.ticketNumber)} | ${cat?.label ?? ticket.categoryId} ===`,
    `Opened: ${ticket.username} | Closed: ${closedByTag} | Reason: ${reason}`,
    `Date: ${new Date().toUTCString()}`,
    `${"─".repeat(40)}`,
  ];
  if (messages) {
    for (const msg of [...messages.values()].reverse()) {
      if (msg.author.bot) continue;
      const time = new Date(msg.createdTimestamp).toISOString().slice(11, 19);
      let line = `[${time}] ${msg.author.username}: ${msg.content.slice(0, 300)}`;
      if (msg.attachments.size > 0) line += ` [+${msg.attachments.size} file(s)]`;
      lines.push(line);
    }
  }
  const transcript = lines.join("\n");

  storage.saveTranscript(ticket.ticketNumber, transcript);

  const transcriptCh = guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID) as TextChannel | undefined;
  const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;

  const openedTs = Math.floor(new Date(ticket.createdAt).getTime() / 1000);

  const closeEmbed = new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle("Ticket Closed")
    .addFields(
      { name: "# Ticket ID",     value: `${ticket.ticketNumber}`,                                        inline: true },
      { name: "✅ Opened By",    value: `<@${ticket.userId}>`,                                           inline: true },
      { name: "🔴 Closed By",   value: `<@${closedById}>`,                                              inline: true },
      { name: "⏰ Open Time",    value: `<t:${openedTs}:F>`,                                             inline: true },
      { name: "👤 Claimed By",   value: ticket.claimedById ? `<@${ticket.claimedById}>` : "Not claimed", inline: true },
      { name: "❓ Reason",       value: reason },
    )
    
    .setTimestamp();

  const showTranscriptBtn = new ButtonBuilder()
    .setCustomId(`show_transcript_${ticket.ticketNumber}`)
    .setLabel("Show Transcript")
    .setStyle(ButtonStyle.Secondary);

  if (transcriptCh) {
    const transcriptMsg = await transcriptCh
      .send({ embeds: [closeEmbed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(showTranscriptBtn)] })
      .catch(() => null);
    if (transcriptMsg) {
      const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`show_transcript_${ticket.ticketNumber}`)
          .setLabel("Show Transcript")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`edit_reason_${guild.id}_${transcriptCh.id}_${transcriptMsg.id}`)
          .setLabel("Edit Reason")
          .setStyle(ButtonStyle.Secondary),
      );
      await transcriptMsg.edit({ components: [editRow] }).catch(() => {});
    }
  }

  if (logCh) {
    await logCh.send({ embeds: [closeEmbed] }).catch(() => {});
  }
}

async function handleCommand(i: ChatInputCommandInteraction) {
  const { commandName, user, channel, guild } = i;

  if (commandName === "stats") {
    const username = i.options.getString("username", true).trim();
    await i.deferReply();

    type StatsResult = {
      money?: string | number;
      shards?: string | number;
      kills?: string | number;
      deaths?: string | number;
      playtime?: string | number;
      placed_blocks?: string | number;
      broken_blocks?: string | number;
      mobs_killed?: string | number;
      money_spent_on_shop?: string | number;
      money_made_from_sell?: string | number;
    };

    let result: StatsResult;
    let online = false;

    try {
      const [statsRes, lookupRes] = await Promise.all([
        fetch(`https://api.donutsmp.net/v1/stats/${encodeURIComponent(username)}`, {
          headers: { Authorization: `Bearer ${DONUTSMP_API_KEY}` },
        }),
        fetch(`https://api.donutsmp.net/v1/lookup/${encodeURIComponent(username)}`, {
          headers: { Authorization: `Bearer ${DONUTSMP_API_KEY}` },
        }),
      ]);

      if (!statsRes.ok) {
        await i.editReply({ embeds: [errEmbed(`**${username}** doesn't exist on DonutSMP.`)] });
        return;
      }

      const statsJson = (await statsRes.json()) as { status: number; result?: StatsResult };
      if (!statsJson.result) {
        await i.editReply({ embeds: [errEmbed(`**${username}** doesn't exist on DonutSMP.`)] });
        return;
      }
      result = statsJson.result;

      if (lookupRes.ok) {
        const lookupJson = (await lookupRes.json()) as { status?: number };
        online = lookupJson.status === 200;
      }
    } catch {
      await i.editReply({ embeds: [errEmbed("Failed to reach the DonutSMP API. Try again later.")] });
      return;
    }

    const embedColor = online ? ONLINE_COLOR : OFFLINE_COLOR;
    const statusLabel = online ? "Online" : "Offline";

    function parseNum(v: string | number | undefined): number {
      if (v === undefined || v === null) return 0;
      return typeof v === "number" ? v : parseFloat(v);
    }

    const money        = fmtNum(parseNum(result.money));
    const shards       = fmtNum(parseNum(result.shards));
    const kills        = fmtNum(parseNum(result.kills));
    const deaths       = fmtNum(parseNum(result.deaths));
    const playtimeMs   = parseNum(result.playtime);
    const playtime     = fmtPlaytime(Math.floor(playtimeMs / 1000));
    const blocksPlaced = fmtNum(parseNum(result.placed_blocks));
    const blocksBroken = fmtNum(parseNum(result.broken_blocks));
    const mobsKilled   = fmtNum(parseNum(result.mobs_killed));
    const moneyShop    = fmtNum(parseNum(result.money_spent_on_shop));
    const moneySell    = fmtNum(parseNum(result.money_made_from_sell));

    const kdr = parseNum(result.deaths) > 0
      ? (parseNum(result.kills) / parseNum(result.deaths)).toFixed(2)
      : parseNum(result.kills).toFixed(2);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`${username}'s Statistics`)
      .setThumbnail(`https://minotar.net/avatar/${encodeURIComponent(username)}/80`)
      .addFields(
        { name: "Balance",            value: `\`${money}\``,        inline: true },
        { name: "Shards",             value: `\`${shards}\``,       inline: true },
        { name: "Playtime",           value: `\`${playtime}\``,     inline: true },
        { name: "Kills",              value: `\`${kills}\``,        inline: true },
        { name: "Deaths",             value: `\`${deaths}\``,       inline: true },
        { name: "K/D Ratio",          value: `\`${kdr}\``,          inline: true },
        { name: "Blocks Placed",      value: `\`${blocksPlaced}\``, inline: true },
        { name: "Blocks Broken",      value: `\`${blocksBroken}\``, inline: true },
        { name: "Mobs Killed",        value: `\`${mobsKilled}\``,   inline: true },
        { name: "Money Spent (Shop)", value: `\`${moneyShop}\``,    inline: true },
        { name: "Money Made (Sell)",  value: `\`${moneySell}\``,    inline: true },
        { name: "Status",             value: `\`${statusLabel}\``,  inline: true },
      )
      .setFooter({ text: `DonutSMP Stats • ${username}` })
      .setTimestamp();

    await i.editReply({ embeds: [embed] });
    return;
  }

  if (commandName === "panel") {
    if (!isOwner(user.id)) {
      await i.reply({ embeds: [errEmbed("You are not authorized.")], flags: 64 });
      return;
    }
    await i.reply({ embeds: [panelEmbed()], components: [panelRow()], flags: 64 });
    return;
  }

  if (commandName === "giveaway") {
    const sub = i.options.getSubcommand();
    if (sub === "create") {
      const member = i.member as GuildMember;
      if (!canManageGiveaway(member)) {
        await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to create giveaways.")], flags: 64 });
        return;
      }
      const modal = new ModalBuilder().setCustomId("mod_giveaway_create").setTitle("Create Giveaway");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("prize")
            .setLabel("Prize")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 20m")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("duration")
            .setLabel("Duration")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 30s, 5m, 1h, 1d, 2h30m")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("winners")
            .setLabel("Number of Winners")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. 1")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("type")
            .setLabel("Type")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("normal  |  simple (no claim)  |  double (gamble)")
            .setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("description")
            .setLabel("Description (optional)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false),
        ),
      );
      await i.showModal(modal);
      return;
    }

    if (sub === "info") {
      const member = i.member as GuildMember;
      if (!canManageGiveaway(member)) {
        await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to look up giveaways.")], flags: 64 });
        return;
      }
      const gwId = i.options.getString("id", true).trim();
      const gw = storage.getGiveaway(gwId);
      if (!gw) {
        await i.reply({ embeds: [errEmbed(`No giveaway found with ID \`${gwId}\`.`)], flags: 64 });
        return;
      }

      const endTs = Math.floor(new Date(gw.endTime).getTime() / 1000);
      const status = gw.ended ? "Ended" : "Active";
      const statusColor = gw.ended ? 0x747f8d : 0xf47bff;
      const typeLabel = gw.type === "simple" ? "Simple (no claim)" : gw.type === "double" ? "Double (gamble)" : "Normal";
      const winnersStr = gw.winners.length > 0 ? gw.winners.map((id) => `<@${id}>`).join(", ") : "None yet";
      const claimedStr = gw.claimedBy.length > 0 ? gw.claimedBy.map((id) => `<@${id}>`).join(", ") : "None";
      const entriesStr = gw.entries.length > 0
        ? gw.entries.slice(0, 30).map((id) => `<@${id}>`).join(", ") + (gw.entries.length > 30 ? ` + ${gw.entries.length - 30} more` : "")
        : "No entries";

      const embed = new EmbedBuilder()
        .setColor(statusColor)
        .setTitle(`${gw.prize}`)
        .addFields(
          { name: "Status",    value: status,                              inline: true },
          { name: "Type",      value: typeLabel,                           inline: true },
          { name: "Winners",   value: `${gw.winnersCount}`,               inline: true },
          { name: "Hosted by", value: `<@${gw.hostId}>`,                  inline: true },
          { name: "Ends",      value: `<t:${endTs}:f> (<t:${endTs}:R>)`, inline: true },
          { name: "Channel",   value: `<#${gw.channelId}>`,               inline: true },
          { name: `Entries (${gw.entries.length})`, value: entriesStr },
          { name: `Winners (${gw.winners.length})`, value: winnersStr,    inline: true },
          { name: `Claimed (${gw.claimedBy.length})`, value: claimedStr,  inline: true },
          ...(gw.description ? [{ name: "Description", value: gw.description }] : []),
        )
        .setFooter({ text: `Giveaway ID: ${gw.id}` })
        .setTimestamp();

      await i.reply({ embeds: [embed], flags: 64 });
      return;
    }

    if (sub === "reroll") {
      const member = i.member as GuildMember;
      if (!canManageGiveaway(member)) {
        await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to reroll giveaways.")], flags: 64 });
        return;
      }
      const gwId = i.options.getString("id", true).trim();
      const gw = storage.getGiveaway(gwId);
      if (!gw) {
        await i.reply({ embeds: [errEmbed(`No giveaway found with ID \`${gwId}\`.`)], flags: 64 });
        return;
      }
      if (!gw.ended) {
        await i.reply({ embeds: [errEmbed("That giveaway is still running.")], flags: 64 });
        return;
      }
      if (gw.entries.length === 0) {
        await i.reply({ embeds: [errEmbed("No entries to reroll from.")], flags: 64 });
        return;
      }
      await i.deferReply({ flags: 64 });
      const pool = gw.entries.filter((id) => !gw.claimedBy.includes(id));
      const eligible = pool.length > 0 ? pool : gw.entries;
      const newWinner = eligible[Math.floor(Math.random() * eligible.length)];
      const ch = i.channel as TextChannel;
      await ch.send({ content: `Reroll — Congratulations <@${newWinner}>, you won **${gw.prize}**!` });
      await i.editReply({ embeds: [new EmbedBuilder().setColor(BOT_COLOR).setDescription(`New winner: <@${newWinner}>`)] });
      return;
    }

    if (sub === "end") {
      const member = i.member as GuildMember;
      if (!canManageGiveaway(member)) {
        await i.reply({ embeds: [errEmbed("You need the Giveaway Manager role to end giveaways.")], flags: 64 });
        return;
      }
      const gwId = i.options.getString("id", true).trim();
      const gw = storage.getGiveaway(gwId);
      if (!gw) {
        await i.reply({ embeds: [errEmbed(`No giveaway found with ID \`${gwId}\`.`)], flags: 64 });
        return;
      }
      if (gw.ended) {
        await i.reply({ embeds: [errEmbed("That giveaway has already ended.")], flags: 64 });
        return;
      }
      // Cancel the scheduled timer and end immediately
      const timer = activeGiveawayTimers.get(gwId);
      if (timer) { clearTimeout(timer); activeGiveawayTimers.delete(gwId); }
      await i.deferReply({ flags: 64 });
      await endGiveaway(gw);
      await i.editReply({ embeds: [okEmbed("Giveaway ended.")] });
      return;
    }
  }

  if (commandName === "tickets") {
    if (!guild) return;
    const member = i.member as GuildMember;
    if (!isStaff(member)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const list = storage.getTicketsByGuild(guild.id);
    const embed = new EmbedBuilder()
      .setColor(BOT_COLOR)
      .setTitle(`Active Tickets — ${list.length} open`)
      .setDescription(
        list.length === 0
          ? "No open tickets."
          : list.slice(0, 25).map((t) => {
              const cat = ALL_CATEGORIES.find((c) => c.id === t.categoryId);
              return `**${ticketTag(t.ticketNumber)}** <#${t.channelId}> — ${cat?.label ?? t.categoryId} — <@${t.userId}>`;
            }).join("\n"),
      )
      
      .setTimestamp();
    await i.reply({ embeds: [embed], flags: 64 });
    return;
  }

  if (commandName === "close") {
    if (!channel || !guild) return;
    const ticket = storage.getTicket(channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    if (!isStaff(member) && ticket.userId !== user.id) {
      await i.reply({ embeds: [errEmbed("No permission to close this ticket.")], flags: 64 }); return;
    }
    const reason = i.options.getString("reason") ?? "No reason specified";
    await i.reply({ embeds: [infoEmbed("Closing ticket in 5 seconds. A transcript will be saved.")] });
    await closeTicket(guild, ticket, channel as TextChannel, user.username, user.id, reason);
    setTimeout(async () => {
      storage.removeTicket(channel.id);
      await (channel as TextChannel).delete("Ticket closed").catch(() => {});
    }, 5000);
    return;
  }

  if (commandName === "rename") {
    if (!channel || !guild) return;
    const ticket = storage.getTicket(channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    if (!isStaff(i.member as GuildMember)) { await i.reply({ embeds: [errEmbed("Staff only.")], flags: 64 }); return; }
    const newName = i.options.getString("name", true).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 90);
    await (channel as TextChannel).setName(newName);
    await i.reply({ embeds: [okEmbed(`Channel renamed to **${newName}**`)] });
    return;
  }

  if (commandName === "add") {
    if (!channel || !guild) return;
    if (!storage.getTicket(channel.id)) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const target = i.options.getUser("user", true);
    await (channel as TextChannel).permissionOverwrites.edit(target.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    });
    await i.reply({ embeds: [okEmbed(`Added <@${target.id}> to this ticket.`)] });
    return;
  }

  if (commandName === "remove") {
    if (!channel || !guild) return;
    if (!storage.getTicket(channel.id)) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const target = i.options.getUser("user", true);
    await (channel as TextChannel).permissionOverwrites.delete(target.id);
    await i.reply({ embeds: [okEmbed(`Removed <@${target.id}> from this ticket.`)] });
    return;
  }
}

async function handleButton(i: ButtonInteraction) {
  const { customId, user, guild } = i;

  // ─── Giveaway: Enter ────────────────────────────────────────────────────
  if (customId.startsWith("giveaway_enter_")) {
    const gwId = customId.slice("giveaway_enter_".length);
    const gw = storage.getGiveaway(gwId);
    if (!gw) {
      await i.reply({ embeds: [errEmbed("Giveaway not found. It may have been deleted.")], flags: 64 });
      return;
    }
    if (gw.ended) {
      await i.reply({ embeds: [errEmbed("This giveaway has already ended.")], flags: 64 });
      return;
    }
    const member = i.member as GuildMember | null;
    if (member?.roles.cache.has(BLACKLISTED_ROLE_ID)) {
      await i.reply({ embeds: [errEmbed("You are not allowed to enter giveaways.")], flags: 64 });
      return;
    }
    const alreadyIn = gw.entries.includes(user.id);
    if (alreadyIn) {
      const left = storage.leaveGiveaway(gwId, user.id);
      if (left) {
        const updated = storage.getGiveaway(gwId)!;
        try {
          const msg = await (i.channel as TextChannel).messages.fetch(gw.messageId);
          await msg.edit({ embeds: [buildGiveawayEmbed(updated)], components: msg.components as never });
        } catch {}
        await i.reply({ embeds: [infoEmbed("You have left the giveaway.")], flags: 64 });
      }
    } else {
      const entered = storage.enterGiveaway(gwId, user.id);
      if (entered) {
        const updated = storage.getGiveaway(gwId)!;
        try {
          const msg = await (i.channel as TextChannel).messages.fetch(gw.messageId);
          await msg.edit({ embeds: [buildGiveawayEmbed(updated)], components: msg.components as never });
        } catch {}
        await i.reply({ embeds: [okEmbed("You have entered the giveaway! Click again to leave.")], flags: 64 });
      }
    }
    return;
  }

  // ─── Giveaway: Double It ────────────────────────────────────────────────
  if (customId.startsWith("giveaway_double_")) {
    const parts = customId.slice("giveaway_double_".length).split("_");
    const winnerId = parts.pop()!;
    const gwId = parts.join("_");
    const gw = storage.getGiveaway(gwId);

    if (!gw) { await i.reply({ embeds: [errEmbed("Giveaway not found.")], flags: 64 }); return; }
    if (user.id !== winnerId) { await i.reply({ embeds: [errEmbed("Only the winner can use this.")], flags: 64 }); return; }
    if (gw.claimedBy.includes(user.id)) { await i.reply({ embeds: [errEmbed("You have already claimed this prize.")], flags: 64 }); return; }
    if (gw.claimExpiry && new Date() > new Date(gw.claimExpiry)) { await i.reply({ embeds: [errEmbed("The claim period has expired.")], flags: 64 }); return; }

    const doubled = doublePrize(gw.prize);

    // Mark as claimed so they can't come back and claim after doubling
    storage.claimGiveaway(gwId, user.id);

    // Disable buttons on the winner's message
    await i.update({
      content: i.message.content,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("giveaway_claim_expired")
            .setLabel("Doubled")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        ),
      ],
    });

    // Announce in channel
    await (i.channel as TextChannel).send({
      content: `**${user.displayName}** has doubled it! The new prize is **${doubled}**`,
    });
    return;
  }

  // ─── Giveaway: Claim ────────────────────────────────────────────────────
  if (customId.startsWith("giveaway_claim_") && customId !== "giveaway_claim_expired") {
    const parts = customId.slice("giveaway_claim_".length).split("_");
    const winnerId = parts.pop()!;
    const gwId = parts.join("_");
    const gw = storage.getGiveaway(gwId);

    if (!gw) { await i.reply({ embeds: [errEmbed("Giveaway not found.")], flags: 64 }); return; }
    const claimMember = i.member as GuildMember | null;
    if (claimMember?.roles.cache.has(BLACKLISTED_ROLE_ID)) {
      await i.reply({ embeds: [errEmbed("You are not allowed to claim giveaway prizes.")], flags: 64 });
      return;
    }
    if (user.id !== winnerId) {
      await i.reply({ embeds: [errEmbed("Only the winner can claim this prize.")], flags: 64 }); return;
    }
    if (gw.claimedBy.includes(user.id)) {
      await i.reply({ embeds: [errEmbed("You have already claimed this prize.")], flags: 64 }); return;
    }
    if (gw.claimExpiry && new Date() > new Date(gw.claimExpiry)) {
      await i.reply({ embeds: [errEmbed("The claim period has expired.")], flags: 64 }); return;
    }

    if (!guild) return;
    await i.deferReply({ flags: 64 });

    const claimed = storage.claimGiveaway(gwId, user.id);
    if (!claimed) {
      const freshGw = storage.getGiveaway(gwId);
      if (freshGw?.claimExpiry && new Date() > new Date(freshGw.claimExpiry)) {
        await i.editReply({ embeds: [errEmbed("The claim period has expired.")] });
      } else if (freshGw?.claimedBy.includes(user.id)) {
        await i.editReply({ embeds: [errEmbed("You have already claimed this prize.")] });
      } else {
        await i.editReply({ embeds: [errEmbed("Could not process claim.")] });
      }
      return;
    }

    // Disable the claim button on the win message
    try {
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`giveaway_claim_done`)
          .setLabel("Claimed ✓")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
      );
      await i.message.edit({ content: i.message.content, components: [disabledRow] });
    } catch {}

    // Create a giveaway claim ticket channel
    const claimExpiry = gw.claimExpiry ? Math.floor(new Date(gw.claimExpiry).getTime() / 1000) : null;
    let claimCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === "Giveaway Tickets",
    ) as CategoryChannel | undefined;
    if (!claimCategory) {
      claimCategory = await guild.channels.create({
        name: "Giveaway Tickets",
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

    const ticketNum = storage.nextTicketNumber();
    const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "user";
    const safePrize = gw.prize.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "prize";
    const ticketChannel = await guild.channels.create({
      name: `giveaway-${safeName}-${safePrize}`,
      type: ChannelType.GuildText,
      parent: claimCategory.id,
      topic: `Giveaway Claim | ${gw.prize} | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: guild.members.me!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ],
    });

    const claimEmbed = new EmbedBuilder()
      .setColor(SUCCESS_COLOR)
      .setTitle(`Giveaway Claim — ${ticketTag(ticketNum)}`)
      .setDescription("Welcome! Staff will process your giveaway prize shortly.")
      .addFields(
        { name: "🎉 Prize",        value: gw.prize,             inline: true },
        { name: "👤 Winner",       value: `<@${user.id}>`,      inline: true },
        { name: "🎲 Giveaway ID",  value: `\`${gw.id}\``,       inline: true },
        ...(claimExpiry
          ? [{ name: "⏰ Claim Expires", value: `<t:${claimExpiry}:R>`, inline: true }]
          : []),
      )
      
      .setTimestamp();

    await ticketChannel.send({
      content: `<@${user.id}>`,
      embeds: [claimEmbed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
        ),
      ],
    });

    storage.addTicket(ticketChannel.id, {
      userId: user.id,
      username: user.username,
      categoryId: "giveaway-claim",
      guildId: guild.id,
      channelId: ticketChannel.id,
      createdAt: new Date().toISOString(),
      ticketNumber: ticketNum,
    });

    const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
    if (logCh) {
      const joinEmbed = new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle("Giveaway Claim Ticket")
        .setDescription(`A giveaway claim ticket has been opened.`)
        .addFields(
          { name: "✅ Winner",     value: `<@${user.id}>`, inline: true },
          { name: "🎉 Prize",      value: gw.prize,        inline: true },
          { name: "🎲 ID",         value: `\`${gw.id}\``,  inline: true },
          { name: "Staff In Ticket", value: "0",           inline: true },
        )
        
        .setTimestamp();
      await logCh.send({
        embeds: [joinEmbed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`join_ticket_${ticketChannel.id}`)
              .setLabel("+ Join Ticket")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => {});
    }

    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setDescription(`Your claim ticket has been created: <#${ticketChannel.id}>`)
          ,
      ],
    });
    return;
  }

  if (customId === "ticket_close") {
    if (!guild || !i.channel) return;
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    if (!isStaff(member) && ticket.userId !== user.id) {
      await i.reply({ embeds: [errEmbed("No permission.")], flags: 64 }); return;
    }
    await i.reply({ embeds: [infoEmbed("Closing ticket in 5 seconds. A transcript will be saved.")] });
    await closeTicket(guild, ticket, i.channel as TextChannel, user.username, user.id, "No reason specified");
    setTimeout(async () => {
      storage.removeTicket(i.channel!.id);
      await (i.channel as TextChannel).delete("Ticket closed").catch(() => {});
    }, 5000);
    return;
  }

  if (customId.startsWith("show_transcript_")) {
    const ticketNumber = parseInt(customId.slice("show_transcript_".length), 10);
    const buf = storage.readTranscript(ticketNumber);
    if (!buf) {
      await i.reply({ embeds: [errEmbed("Transcript file not found.")], flags: 64 });
      return;
    }
    const file = new AttachmentBuilder(buf, { name: `transcript-${String(ticketNumber).padStart(4, "0")}.txt` });
    await i.reply({ files: [file], flags: 64 });
    return;
  }

  if (customId.startsWith("join_ticket_")) {
    const ticketChannelId = customId.slice("join_ticket_".length);
    if (!guild) return;
    const ticket = storage.getTicket(ticketChannelId);
    if (!ticket) { await i.reply({ embeds: [errEmbed("This ticket no longer exists.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    if (!isMod(member)) { await i.reply({ embeds: [errEmbed("You do not have the required moderator role.")], flags: 64 }); return; }

    const ticketCh = guild.channels.cache.get(ticketChannelId) as TextChannel | undefined;
    if (!ticketCh) { await i.reply({ embeds: [errEmbed("Ticket channel not found.")], flags: 64 }); return; }

    const joined = storage.joinTicket(ticketChannelId, user.id);
    if (!joined) {
      await i.reply({ embeds: [errEmbed("You have already joined this ticket.")], flags: 64 }); return;
    }

    await ticketCh.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
    }).catch(() => {});

    const updatedTicket = storage.getTicket(ticketChannelId);
    const staffCount = updatedTicket?.joinedStaff?.length ?? 1;

    const oldEmbed = i.message.embeds[0];
    if (oldEmbed) {
      const updatedEmbed = EmbedBuilder.from(oldEmbed);
      const fields = (updatedEmbed.data.fields ?? []).map((f) =>
        f.name === "👤 Staff In Ticket" ? { ...f, value: String(staffCount) } : f,
      );
      updatedEmbed.setFields(fields);
      await i.update({ embeds: [updatedEmbed], components: i.message.components as never }).catch(() => {});
    } else {
      await i.deferUpdate().catch(() => {});
    }

    await ticketCh.send({ embeds: [okEmbed(`<@${user.id}> has joined the ticket.`)] }).catch(() => {});
    return;
  }

  if (customId.startsWith("farm_accept_")) {
    const ticketChannelId = customId.slice("farm_accept_".length);
    if (!guild) return;
    if (!isOwner(user.id)) {
      await i.reply({ embeds: [errEmbed("Only the owner can accept farm requests.")], flags: 64 });
      return;
    }
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(customId).setLabel(`Accepted by ${user.username}`).setStyle(ButtonStyle.Success).setDisabled(true),
    );
    await i.update({ components: [disabledRow] });
    const ticketCh = guild.channels.cache.get(ticketChannelId) as TextChannel | undefined;
    if (ticketCh) {
      await ticketCh.send({
        embeds: [
          new EmbedBuilder()
            .setColor(SUCCESS_COLOR)
            .setDescription(`✅ **<@${user.id}> has accepted this farm request.**\nBuilders can now claim this ticket.`)
            
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
          ),
        ],
      }).catch(() => {});
    }
    return;
  }

  if (customId === "farm_change_price") {
    if (!guild || !i.channel) return;
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket || ticket.categoryId !== "buy-farms") return;
    if (ticket.claimedById !== user.id) {
      await i.reply({ embeds: [errEmbed("Only the builder who claimed this ticket can update the price.")], flags: 64 });
      return;
    }
    const modal = new ModalBuilder().setCustomId("mod_farm_price").setTitle("Update Farm Price");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("new_price")
          .setLabel("New Price")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 500M, $250, negotiable")
          .setRequired(true),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (customId === "skelly_buy" || customId === "skelly_sell") {
    const isBuying = customId === "skelly_buy";
    if (!guild) return;
    const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    if (existingId) storage.removeTicket(existingId);
    const modal = new ModalBuilder()
      .setCustomId(isBuying ? "mod_skelly_buy" : "mod_skelly_sell")
      .setTitle(isBuying ? "Buy Spawners" : "Sell Spawners");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("spawner")
          .setLabel("What spawner?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. Skeleton, Creeper, Iron Golem..."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel(isBuying ? "How many do you want to buy?" : "How many do you want to sell?")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 64"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("details")
          .setLabel("Additional details")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder("Price offer, IGN, anything else..."),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (customId === "ticket_claim") {
    if (!guild || !i.channel) return;
    const ticket = storage.getTicket(i.channel.id);
    if (!ticket) { await i.reply({ embeds: [errEmbed("Not a ticket channel.")], flags: 64 }); return; }
    const member = i.member as GuildMember;
    const isFarmBuilder = ticket.categoryId === "buy-farms" && member.roles.cache.has(BUILD_TICKET_ROLE_ID);
    if (!isStaff(member) && !isFarmBuilder) {
      await i.reply({ embeds: [errEmbed("You don't have permission to claim this ticket.")], flags: 64 }); return;
    }
    if (ticket.claimedById) {
      await i.reply({ embeds: [errEmbed(`This ticket is already claimed by <@${ticket.claimedById}>.`)], flags: 64 }); return;
    }
    storage.claimTicket(i.channel.id, user.username, user.id);
    if (ticket.categoryId === "buy-farms") {
      const openerSafe = ticket.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
      const claimerSafe = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "builder";
      await (i.channel as TextChannel).setName(`build-${openerSafe}-${claimerSafe}`).catch(() => {});
      await i.reply({
        embeds: [okEmbed(`Ticket claimed by <@${user.id}>.`)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("farm_change_price").setLabel("Change Price").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    } else {
      await i.reply({ embeds: [okEmbed(`Ticket claimed by <@${user.id}>.`)] });
    }
    return;
  }

  if (customId.startsWith("edit_reason_")) {
    const [, , guildId, channelId, messageId] = customId.split("_");
    const modal = new ModalBuilder()
      .setCustomId(`mod_edit_reason_${guildId}_${channelId}_${messageId}`)
      .setTitle("Edit Close Reason");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("new_reason")
          .setLabel("New Reason")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
    await i.showModal(modal);
    return;
  }

  if (!isOwner(user.id)) {
    if (customId.startsWith("panel_") || customId.startsWith("t_") || customId.startsWith("f_")) {
      await i.reply({ embeds: [errEmbed("Not authorized.")], flags: 64 }); return;
    }
  }

  switch (customId) {
    case "panel_back":
      await i.update({ embeds: [panelEmbed()], components: [panelRow()] }); return;

    case "panel_server": {
      if (!guild) return;
      const g = await guild.fetch();
      await g.members.fetch().catch(() => {});
      const online = g.members.cache.filter((m) => m.presence?.status !== "offline" && !!m.presence?.status).size;
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle(`Server Monitor — ${g.name}`)
        .setThumbnail(g.iconURL())
        .addFields(
          { name: "Members", value: `${g.memberCount}`, inline: true },
          { name: "Online", value: `${online || "N/A"}`, inline: true },
          { name: "Channels", value: `${g.channels.cache.size}`, inline: true },
          { name: "Roles", value: `${g.roles.cache.size}`, inline: true },
          { name: "Boosts", value: `${g.premiumSubscriptionCount ?? 0} (Level ${g.premiumTier})`, inline: true },
          { name: "Open Tickets", value: `${storage.getTicketsByGuild(g.id).length}`, inline: true },
          { name: "Owner", value: `<@${g.ownerId}>`, inline: true },
          { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        )
        
        .setTimestamp();
      await i.update({ embeds: [embed], components: [backRow("panel_back")] }); return;
    }

    case "panel_tickets": {
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle("Ticket Panel")
        .setDescription("Manage the ticket system. Send the ticket panel, edit category messages, or view active tickets.");
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("t_send").setLabel("Send Ticket Panel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("t_edit").setLabel("Edit Messages").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("t_active").setLabel("Active Tickets").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("t_edit_text").setLabel("Edit Panel Text").setStyle(ButtonStyle.Secondary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "panel_farms": {
      const data = storage.getData();
      const embed = new EmbedBuilder()
        .setColor(GOLD_COLOR)
        .setTitle("Farm Panel")
        .addFields(
          { name: "Description", value: data.farmDescription.slice(0, 900) },
          { name: "Farm List", value: data.farmList.slice(0, 900) },
        );
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("f_send_panel").setLabel("Send Farm Ticket Panel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("f_send_info").setLabel("Send Farm Info").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("f_edit_desc").setLabel("Edit Description").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("f_edit_list").setLabel("Edit Farm List").setStyle(ButtonStyle.Secondary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "panel_skelly": {
      const data = storage.getData();
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle("Skelly Panel")
        .addFields({ name: "Description", value: (data.skellyDescription || SKELLY_CATEGORY.description).slice(0, 900) });
      await i.update({
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("sk_send_panel").setLabel("Send Skelly Panel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("sk_edit_desc").setLabel("Edit Description").setStyle(ButtonStyle.Secondary),
          ),
          backRow("panel_back"),
        ],
      }); return;
    }

    case "t_send": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [ticketPanelEmbed()], components: ticketPanelComponents() });
      await i.editReply({ embeds: [okEmbed(`✅ Ticket panel sent to this channel.`)], components: [backRow("panel_tickets")] });
      return;
    }

    case "t_edit": {
      const options = REGULAR_CATEGORIES.map((cat) =>
        new StringSelectMenuOptionBuilder().setLabel(cat.label).setValue(cat.id).setDescription("Edit this category's message"),
      );
      const sel = new StringSelectMenuBuilder().setCustomId("sel_edit_cat").setPlaceholder("Choose a category").addOptions(options);
      await i.update({
        embeds: [new EmbedBuilder().setColor(BOT_COLOR).setTitle("Edit Category Messages").setDescription("Select a category to edit its welcome message.")],
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel), backRow("panel_tickets")],
      }); return;
    }

    case "t_edit_text": {
      const data = storage.getData();
      const modal = new ModalBuilder().setCustomId("mod_panel_text").setTitle("Edit Ticket Panel Text");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("panel_title").setLabel("Title").setStyle(TextInputStyle.Short).setValue(data.ticketPanelTitle).setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("panel_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setValue(data.ticketPanelDesc).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "t_active": {
      if (!guild) return;
      const list = storage.getTicketsByGuild(guild.id);
      const embed = new EmbedBuilder()
        .setColor(BOT_COLOR)
        .setTitle(`Active Tickets — ${list.length} open`)
        .setDescription(
          list.length === 0
            ? "No open tickets."
            : list.slice(0, 20).map((t) => {
                const cat = ALL_CATEGORIES.find((c) => c.id === t.categoryId);
                return `**${ticketTag(t.ticketNumber)}** <#${t.channelId}> — ${cat?.label ?? t.categoryId} — <@${t.userId}> — <t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>`;
              }).join("\n"),
        )
        
        .setTimestamp();
      await i.update({ embeds: [embed], components: [backRow("panel_tickets")] }); return;
    }

    case "sk_send_panel": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [skellyTicketPanelEmbed()], components: skellyTicketComponents() });
      await i.editReply({ embeds: [okEmbed("✅ Skelly ticket panel sent to this channel.")], components: [backRow("panel_skelly")] });
      return;
    }

    case "sk_edit_desc": {
      const modal = new ModalBuilder().setCustomId("mod_skelly_desc").setTitle("Edit Skelly Description");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("skelly_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setValue(storage.getData().skellyDescription || SKELLY_CATEGORY.description).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "f_send_panel": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [farmTicketPanelEmbed()], components: farmTicketComponents() });
      await i.editReply({ embeds: [okEmbed("✅ Farm ticket panel sent to this channel.")], components: [backRow("panel_farms")] });
      return;
    }

    case "f_send_info": {
      if (!i.channel) return;
      await i.deferUpdate();
      await (i.channel as TextChannel).send({ embeds: [farmInfoEmbed()] });
      await i.editReply({ embeds: [okEmbed("✅ Farm info sent to this channel.")], components: [backRow("panel_farms")] });
      return;
    }

    case "f_edit_desc": {
      const modal = new ModalBuilder().setCustomId("mod_farm_desc").setTitle("Edit Farm Description");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("farm_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setValue(storage.getData().farmDescription).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }

    case "f_edit_list": {
      const modal = new ModalBuilder().setCustomId("mod_farm_list").setTitle("Edit Farm List");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("farm_list").setLabel("Available Farms").setStyle(TextInputStyle.Paragraph).setValue(storage.getData().farmList).setRequired(true),
        ),
      );
      await i.showModal(modal); return;
    }
  }
}

async function handleStringSelect(i: StringSelectMenuInteraction) {
  const { customId, values, user, guild } = i;

  if (customId === "sel_ticket_topic") {
    if (values[0] === "skellys") {
      if (!guild) return;
      const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
      if (existingId && guild.channels.cache.get(existingId)) {
        await i.reply({
          embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
          flags: 64,
        });
        return;
      }
      await i.reply({
        embeds: [new EmbedBuilder().setColor(SKELLY_CATEGORY.color).setTitle("Spawner Tickets").setDescription(`${SKELLY_PRICE_TEXT}\n\nChoose an option below:`)],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary),
          ),
        ],
        flags: 64,
      });
      return;
    }
    await handleTicketCreate(i, values[0]!, false);
    return;
  }

  if (customId === "sel_skelly_topic") {
    if (!guild) return;
    const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    await i.reply({
      embeds: [new EmbedBuilder().setColor(SKELLY_CATEGORY.color).setTitle("Spawner Tickets").setDescription(`${SKELLY_PRICE_TEXT}\n\nChoose an option below:`)],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary),
        ),
      ],
      flags: 64,
    });
    return;
  }

  if (customId === "sel_farm_topic") {
    const sel = new StringSelectMenuBuilder()
      .setCustomId("sel_farm_schematic")
      .setPlaceholder("Choose a schematic type")
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Which one?")
          .setValue("server")
          .setDescription("Use one of our pre-made server schematics"),
        new StringSelectMenuOptionBuilder()
          .setLabel("Custom Schematic")
          .setValue("custom")
          .setDescription("Bring your own custom schematic"),
      );
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD_COLOR)
          .setTitle("Buy Farms — Schematic Type")
          .setDescription("Will you be using a **server schematic** or providing a **custom schematic**?")
          ,
      ],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sel)],
      flags: 64,
    });
    return;
  }

  if (customId === "sel_farm_schematic") {
    const schematic = values[0]!;
    if (schematic === "server") {
      const modal = new ModalBuilder()
        .setCustomId("mod_farm_server")
        .setTitle("Buy Farms — Server Schematic");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("which_schematic")
            .setLabel("Which server schematic do you want?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. Skeleton Farm, Creeper Farm...")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("mined_space")
            .setLabel("Do you have a mined out space? (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("If No, it costs 1,000 per block mined")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("due_date")
            .setLabel("When is it due?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. ASAP, 2 weeks, March 1st")
            .setRequired(true),
        ),
      );
      await i.showModal(modal);
      return;
    }
    if (schematic === "custom") {
      const modal = new ModalBuilder()
        .setCustomId("mod_farm_custom")
        .setTitle("Buy Farms — Custom Schematic");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("budget")
            .setLabel("How much are you willing to spend?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. $500, negotiable, open to offers")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("mined_space")
            .setLabel("Do you have a mined out space? (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("If No, it costs 1,000 per block mined")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("due_date")
            .setLabel("When is it due?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g. ASAP, 2 weeks, March 1st")
            .setRequired(true),
        ),
      );
      await i.showModal(modal);
      return;
    }
    return;
  }

  if (customId === "sel_edit_cat" && isOwner(user.id)) {
    const cat = ALL_CATEGORIES.find((c) => c.id === values[0]!);
    if (!cat) return;
    const current = storage.getCategoryMessage(cat.id) ?? cat.description;
    const modal = new ModalBuilder().setCustomId(`mod_cat_${cat.id}`).setTitle(`Edit: ${cat.label}`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("cat_message").setLabel("Welcome Message").setStyle(TextInputStyle.Paragraph).setValue(current).setRequired(true),
      ),
    );
    await i.showModal(modal);
    return;
  }
}

async function handleChannelSelect(i: ChannelSelectMenuInteraction) {
  const { customId, values, guild } = i;
  if (!guild || !isOwner(i.user.id)) return;
  const ch = guild.channels.cache.get(values[0]!) as TextChannel | undefined;
  if (!ch) return;

}

async function handleModal(i: ModalSubmitInteraction) {
  const { customId, user } = i;

  // ─── Giveaway Create ────────────────────────────────────────────────────
  if (customId === "mod_giveaway_create") {
    const prize = i.fields.getTextInputValue("prize").trim();
    const durationStr = i.fields.getTextInputValue("duration").trim();
    const winnersStr = i.fields.getTextInputValue("winners").trim();
    const typeRaw = i.fields.getTextInputValue("type").trim().toLowerCase();
    const gwType: "normal" | "simple" | "double" =
      typeRaw === "simple" ? "simple" : typeRaw === "double" ? "double" : "normal";
    const description = i.fields.getTextInputValue("description").trim();

    const durationMs = parseDuration(durationStr);
    if (!durationMs) {
      await i.reply({ embeds: [errEmbed("Invalid duration. Use formats like `1h`, `30m`, `1d`, `2h30m`.")], flags: 64 });
      return;
    }

    const winnersCount = parseInt(winnersStr, 10);
    if (isNaN(winnersCount) || winnersCount < 1 || winnersCount > 20) {
      await i.reply({ embeds: [errEmbed("Invalid winner count. Must be between 1 and 20.")], flags: 64 });
      return;
    }

    if (!i.channel || !i.guild) {
      await i.reply({ embeds: [errEmbed("Could not determine channel.")], flags: 64 });
      return;
    }

    await i.deferReply({ flags: 64 });

    const gwId = genGiveawayId();
    const endTime = new Date(Date.now() + durationMs).toISOString();

    const gw: GiveawayEntry = {
      id: gwId,
      guildId: i.guild.id,
      channelId: i.channel.id,
      messageId: "",
      hostId: user.id,
      prize,
      description,
      winnersCount,
      endTime,
      entries: [],
      ended: false,
      winners: [],
      claimedBy: [],
      claimExpiry: null,
      winMessages: {},
      type: gwType,
    };

    const enterRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter_${gwId}`)
        .setLabel("🎉")
        .setStyle(ButtonStyle.Primary),
    );

    const msg = await (i.channel as TextChannel).send({
      embeds: [buildGiveawayEmbed(gw)],
      components: [enterRow],
    });

    gw.messageId = msg.id;
    storage.addGiveaway(gw);
    scheduleGiveaway(gw);

    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setDescription(`✅ Giveaway created in <#${i.channel.id}>!\n\nPrize: **${prize}** | Winners: **${winnersCount}** | ID: \`${gwId}\``)
          ,
      ],
    });
    return;
  }

  if (customId === "mod_farm_server" || customId === "mod_farm_custom") {
    const { guild } = i;
    if (!guild) return;

    const isCustom       = customId === "mod_farm_custom";
    const dueDate        = i.fields.getTextInputValue("due_date");
    const budget         = isCustom ? i.fields.getTextInputValue("budget") : null;
    const whichSchematic = !isCustom ? i.fields.getTextInputValue("which_schematic") : null;
    const minedSpace     = i.fields.getTextInputValue("mined_space");

    const existingId = storage.hasOpenTicket(user.id, "buy-farms", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open farm ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    if (existingId) storage.removeTicket(existingId);

    await i.deferReply({ flags: 64 });

    let discordCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === FARM_CATEGORY.discordCategoryName,
    ) as CategoryChannel | undefined;
    if (!discordCategory) {
      discordCategory = await guild.channels.create({
        name: FARM_CATEGORY.discordCategoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

    const ticketNum = storage.nextTicketNumber();
    const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
    const channelName = `build-${safeName}`;

    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: discordCategory.id,
      topic: `Ticket ${ticketTag(ticketNum)} | Buy Farms | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
        },
        {
          id: guild.members.me!.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
        },
        {
          id: BUILD_TICKET_ROLE_ID,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
        },
      ],
    });

    const schematicType = isCustom ? "Custom Schematic" : "Server Schematic";
    const welcomeFields: { name: string; value: string; inline: boolean }[] = [
      { name: "Opened by",      value: `<@${user.id}>`,    inline: true },
      { name: "Ticket",         value: ticketTag(ticketNum), inline: true },
      { name: "Schematic Type", value: schematicType,        inline: true },
    ];
    if (whichSchematic) {
      welcomeFields.push({ name: "Schematic",    value: whichSchematic, inline: true });
    }
    welcomeFields.push({ name: "Mined Out Space", value: `${minedSpace} — (If No: 1,000 per block mined)`, inline: true });
    welcomeFields.push({ name: "Due Date",         value: dueDate,                                          inline: true });
    if (isCustom && budget) {
      welcomeFields.push({ name: "Budget", value: budget, inline: true });
    }

    const customMsg = storage.getCategoryMessage("buy-farms") ?? FARM_CATEGORY.description;
    const welcomeEmbed = new EmbedBuilder()
      .setColor(SUCCESS_COLOR)
      .setTitle(`Buy Farms — ${ticketTag(ticketNum)}`)
      .setDescription(customMsg)
      .addFields(...welcomeFields)
      
      .setTimestamp();

    const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`farm_accept_${ticketChannel.id}`).setLabel("Accept Request").setStyle(ButtonStyle.Success),
    );

    await ticketChannel.send({
      content: `<@${user.id}> <@&${BUILD_TICKET_ROLE_ID}>`,
      embeds: [welcomeEmbed],
      components: [controlRow],
    });

    storage.addTicket(ticketChannel.id, {
      userId: user.id,
      username: user.username,
      categoryId: "buy-farms",
      guildId: guild.id,
      channelId: ticketChannel.id,
      createdAt: new Date().toISOString(),
      ticketNumber: ticketNum,
    });

    const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
    if (logCh) {
      const joinEmbed = new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle("Join Ticket")
        .setDescription(`${channelName} with ID: ${ticketNum} has been opened. Press the button below to join it.`)
        .addFields(
          { name: "Opened By",       value: `<@${user.id}>`,  inline: true },
          { name: "Panel",           value: "Buy Farms",       inline: true },
          { name: "Schematic",       value: schematicType,     inline: true },
          { name: "Due Date",        value: dueDate,           inline: true },
          ...(isCustom && budget ? [{ name: "Budget", value: budget, inline: true }] : []),
          { name: "Staff In Ticket", value: "0",              inline: true },
        )
        
        .setTimestamp();
      await logCh.send({
        embeds: [joinEmbed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`join_ticket_${ticketChannel.id}`).setLabel("+ Join Ticket").setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => {});
    }

    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(SUCCESS_COLOR)
          .setTitle("Farm Ticket Created")
          .setDescription(`Your farm ticket has been created: <#${ticketChannel.id}>`)
          .addFields({ name: "Ticket Number", value: ticketTag(ticketNum), inline: true })
          ,
      ],
    });
    return;
  }

  if (customId === "mod_farm_price") {
    const newPrice = i.fields.getTextInputValue("new_price");
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(GOLD_COLOR)
          .setDescription(`<@${user.id}> updated the farm price to: **${newPrice}**`)
          
          .setTimestamp(),
      ],
    });
    return;
  }

  if (customId === "mod_skelly_desc") {
    storage.updateSkellyDescription(i.fields.getTextInputValue("skelly_desc"));
    await i.reply({ embeds: [okEmbed("Skelly description updated.")], flags: 64 }); return;
  }

  if (customId === "mod_skelly_buy" || customId === "mod_skelly_sell") {
    const isBuying = customId === "mod_skelly_buy";
    const { guild } = i;
    if (!guild) return;

    const spawner = i.fields.getTextInputValue("spawner").trim();
    const amount  = i.fields.getTextInputValue("amount").trim();
    const details = i.fields.getTextInputValue("details").trim();

    const existingId = storage.hasOpenTicket(user.id, "skellys", guild.id);
    if (existingId && guild.channels.cache.get(existingId)) {
      await i.reply({
        embeds: [new EmbedBuilder().setColor(WARNING_COLOR).setDescription(`You already have an open skelly ticket: <#${existingId}>`)],
        flags: 64,
      });
      return;
    }
    if (existingId) storage.removeTicket(existingId);

    await i.deferReply({ flags: 64 });

    let discordCategory = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === SKELLY_CATEGORY.discordCategoryName,
    ) as CategoryChannel | undefined;
    if (!discordCategory) {
      discordCategory = await guild.channels.create({
        name: SKELLY_CATEGORY.discordCategoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
      });
    }

    const ticketNum = storage.nextTicketNumber();
    const safeName  = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
    const prefix    = isBuying ? "buy" : "sell";

    const ticketChannel = await guild.channels.create({
      name: `skelly-${prefix}-${safeName}`,
      type: ChannelType.GuildText,
      parent: discordCategory.id,
      topic: `Ticket ${ticketTag(ticketNum)} | ${isBuying ? "Buying" : "Selling"} Spawners | ${user.tag}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
        },
        {
          id: guild.members.me!.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
        },
        ...MOD_ROLE_IDS.map((roleId) => ({
          id: roleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
        })),
      ],
    });

    const welcomeFields: { name: string; value: string; inline: boolean }[] = [
      { name: "Opened by",                              value: `<@${user.id}>`,                         inline: true  },
      { name: "Ticket",                                 value: ticketTag(ticketNum),                     inline: true  },
      { name: "Type",                                   value: isBuying ? "Buying" : "Selling",          inline: true  },
      { name: "Spawner",                                value: spawner,                                  inline: true  },
      { name: isBuying ? "Amount wanted" : "Amount",   value: amount,                                   inline: true  },
      { name: "Opened",                                 value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
    ];
    if (details) welcomeFields.push({ name: "Details", value: details, inline: false });

    const welcomeEmbed = new EmbedBuilder()
      .setColor(SKELLY_CATEGORY.color)
      .setTitle(`${isBuying ? "Buying" : "Selling"} Spawners — ${ticketTag(ticketNum)}`)
      .setDescription(`${SKELLY_PRICE_TEXT}\n\nSee <#1518633695404101773> for more info — [click here](${SKELLY_PRICE_CHANNEL})`)
      .addFields(...welcomeFields)
      .setTimestamp();

    const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
    );

    await ticketChannel.send({ content: `<@${user.id}>`, embeds: [welcomeEmbed], components: [controlRow] });

    storage.addTicket(ticketChannel.id, {
      userId: user.id,
      username: user.username,
      categoryId: "skellys",
      guildId: guild.id,
      channelId: ticketChannel.id,
      createdAt: new Date().toISOString(),
      ticketNumber: ticketNum,
    });

    const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
    if (logCh) {
      const joinEmbed = new EmbedBuilder()
        .setColor(SKELLY_CATEGORY.color)
        .setTitle(`New Skelly Ticket — ${isBuying ? "Buying" : "Selling"}`)
        .addFields(
          { name: "✅ Opened By", value: `<@${user.id}>`,           inline: true },
          { name: "🧱 Spawner",  value: spawner,                    inline: true },
          { name: "🔢 Amount",   value: amount,                     inline: true },
          { name: "📋 Ticket",   value: ticketTag(ticketNum),       inline: true },
        )
        .setTimestamp();
      const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`join_ticket_${ticketChannel.id}`).setLabel("+ Join Ticket").setStyle(ButtonStyle.Primary),
      );
      await logCh.send({ embeds: [joinEmbed], components: [joinRow] }).catch(() => {});
    }

    await i.editReply({ embeds: [okEmbed(`✅ Your ticket has been created: <#${ticketChannel.id}>`)] });
    return;
  }

  if (customId === "mod_farm_desc") {
    storage.updateFarmDescription(i.fields.getTextInputValue("farm_desc"));
    await i.reply({ embeds: [okEmbed("Farm description updated.")], flags: 64 }); return;
  }
  if (customId === "mod_farm_list") {
    storage.updateFarmList(i.fields.getTextInputValue("farm_list"));
    await i.reply({ embeds: [okEmbed("Farm list updated.")], flags: 64 }); return;
  }
  if (customId.startsWith("mod_edit_reason_")) {
    const parts = customId.split("_");
    const [, , , guildId, channelId, messageId] = parts;
    const newReason = i.fields.getTextInputValue("new_reason");
    if (!guildId || !channelId || !messageId) {
      await i.reply({ embeds: [errEmbed("Invalid data.")], flags: 64 }); return;
    }
    const guild = i.guild ?? _client?.guilds.cache.get(guildId);
    if (!guild) { await i.reply({ embeds: [errEmbed("Guild not found.")], flags: 64 }); return; }
    const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!ch) { await i.reply({ embeds: [errEmbed("Channel not found.")], flags: 64 }); return; }
    const msg = await ch.messages.fetch(messageId).catch(() => null);
    if (!msg) { await i.reply({ embeds: [errEmbed("Message not found.")], flags: 64 }); return; }
    const oldEmbed = msg.embeds[0];
    if (!oldEmbed) { await i.reply({ embeds: [errEmbed("No embed to edit.")], flags: 64 }); return; }
    const updatedEmbed = EmbedBuilder.from(oldEmbed);
    const fields = updatedEmbed.data.fields ?? [];
    const reasonIdx = fields.findIndex((f) => f.name === "❓ Reason");
    if (reasonIdx >= 0) {
      fields[reasonIdx]!.value = newReason;
      updatedEmbed.setFields(fields);
    }
    await msg.edit({ embeds: [updatedEmbed] }).catch(() => {});
    await i.reply({ embeds: [okEmbed(`Reason updated to: **${newReason}**`)], flags: 64 });
    return;
  }

  if (customId === "mod_panel_text") {
    storage.updatePanelText(i.fields.getTextInputValue("panel_title"), i.fields.getTextInputValue("panel_desc"));
    await i.reply({ embeds: [okEmbed("Panel text updated. Resend the panel to apply.")], flags: 64 }); return;
  }
  if (customId.startsWith("mod_cat_")) {
    storage.setCategoryMessage(customId.slice(8), i.fields.getTextInputValue("cat_message"));
    await i.reply({ embeds: [okEmbed("Category message updated.")], flags: 64 }); return;
  }
}

async function handleTicketCreate(
  i: StringSelectMenuInteraction,
  categoryId: string,
  isFarm: boolean,
) {
  const { user, guild } = i;
  if (!guild) return;

  const cat = ALL_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return;

  await i.deferReply({ flags: 64 });

  const existingId = storage.hasOpenTicket(user.id, categoryId, guild.id);
  if (existingId && guild.channels.cache.get(existingId)) {
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(WARNING_COLOR)
          .setDescription(`You already have an open **${cat.label}** ticket: <#${existingId}>`)
          ,
      ],
    });
    return;
  }
  if (existingId) storage.removeTicket(existingId);

  let discordCategory = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === cat.discordCategoryName,
  ) as CategoryChannel | undefined;

  if (!discordCategory) {
    discordCategory = await guild.channels.create({
      name: cat.discordCategoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
    });
  }

  const ticketNum = storage.nextTicketNumber();
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18) || "user";
  const channelName = `${cat.channelPrefix}-${safeName}`;

  const overwrites: Parameters<Guild["channels"]["create"]>[0]["permissionOverwrites"] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
    },
    {
      id: guild.members.me!.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    },
  ];

  if (isFarm) {
    overwrites.push({
      id: BUILD_TICKET_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    });
  }

  const ticketChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: discordCategory.id,
    topic: `Ticket ${ticketTag(ticketNum)} | ${cat.label} | ${user.tag}`,
    permissionOverwrites: overwrites,
  });

  const customMsg = storage.getCategoryMessage(categoryId) ?? cat.description;

  const welcomeEmbed = new EmbedBuilder()
    .setColor(cat.color)
    .setTitle(`${cat.label} — ${ticketTag(ticketNum)}`)
    .setDescription(customMsg)
    .addFields(
      { name: "Opened by", value: `<@${user.id}>`, inline: true },
      { name: "Ticket", value: ticketTag(ticketNum), inline: true },
      { name: "Opened", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
    )
    
    .setTimestamp();

  const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger),
  );

  const ping = isFarm ? `<@${user.id}> <@&${BUILD_TICKET_ROLE_ID}>` : `<@${user.id}>`;
  await ticketChannel.send({ content: ping, embeds: [welcomeEmbed], components: [controlRow] });

  storage.addTicket(ticketChannel.id, {
    userId: user.id,
    username: user.username,
    categoryId,
    guildId: guild.id,
    channelId: ticketChannel.id,
    createdAt: new Date().toISOString(),
    ticketNumber: ticketNum,
  });

  const logCh = guild.channels.cache.get(TICKET_LOG_CHANNEL_ID) as TextChannel | undefined;
  if (logCh) {
    const joinEmbed = new EmbedBuilder()
      .setColor(isFarm ? SUCCESS_COLOR : 0xed4245)
      .setTitle("Join Ticket")
      .setDescription(`${channelName} with ID: ${ticketNum} has been opened. Press the button below to join it.`)
      .addFields(
        { name: "✅ Opened By",     value: `<@${user.id}>`, inline: true },
        { name: "🔵 Panel",         value: cat.label,       inline: true },
        { name: "👤 Staff In Ticket", value: "0",           inline: true },
      )
      
      .setTimestamp();

    const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`join_ticket_${ticketChannel.id}`)
        .setLabel("+ Join Ticket")
        .setStyle(ButtonStyle.Primary),
    );

    await logCh.send({ embeds: [joinEmbed], components: [joinRow] }).catch(() => {});
  }

  await i.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(cat.color)
        .setTitle("Ticket Created")
        .setDescription(`Your **${cat.label}** ticket has been created: <#${ticketChannel.id}>`)
        .addFields({ name: "Ticket Number", value: ticketTag(ticketNum), inline: true })
        ,
    ],
  });
}

function backRow(target: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(target).setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(BOT_COLOR)
    .setTitle("Owner Control Panel")
    .setDescription("Select a section below.")
    .addFields(
      { name: "Server Monitor", value: "Live server statistics", inline: true },
      { name: "Ticket Panel", value: "Manage the ticket system", inline: true },
      { name: "Farm Panel", value: "Manage farm listings", inline: true },
    )
    
    .setTimestamp();
}

function panelRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel_server").setLabel("Server Monitor").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_tickets").setLabel("Ticket Panel").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_farms").setLabel("Farm Panel").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("panel_skelly").setLabel("Skelly Panel").setStyle(ButtonStyle.Primary),
  );
}

function ticketPanelEmbed() {
  const data = storage.getData();
  const embed = new EmbedBuilder()
    .setColor(BOT_COLOR)
    .setTitle(data.ticketPanelTitle)
    
    .setTimestamp();

  let desc = data.ticketPanelDesc ? data.ticketPanelDesc + "\n\n" : "";
  for (const cat of REGULAR_CATEGORIES) {
    const msg = storage.getCategoryMessage(cat.id) ?? cat.description;
    desc += `**${cat.label}** – ${msg}\n\n`;
  }
  embed.setDescription(desc.trim());
  return embed;
}

function ticketPanelComponents() {
  const options = REGULAR_CATEGORIES.map((cat) =>
    new StringSelectMenuOptionBuilder().setLabel(cat.label).setValue(cat.id).setDescription(cat.description.slice(0, 100)),
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId("sel_ticket_topic")
    .setPlaceholder("Select A Topic")
    .addOptions(options);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

const SKELLY_PRICE_CHANNEL = "https://discord.com/channels/1450662191890956322/1518633695404101773";

const SKELLY_PRICE_TEXT = [
  "**Buying:**",
  "Skeleton — 3.3m each",
  "Creeper — 3.3m each",
  "Iron Golem — 5.5m each",
  "",
  "**Selling:**",
  "Skeleton — 3.9m each",
  "Creeper — 8m each",
  "Iron Golem — 9m each",
  "",
  "**Notes:**",
  "Our prices are possibly negotiable",
  "5x5 minimum",
  "16 spawner minimum",
].join("\n");

function skellyTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(SKELLY_CATEGORY.color)
    .setTitle("Spawner Prices")
    .setDescription(`${SKELLY_PRICE_TEXT}\n\nSee <#1518633695404101773> for more details.\nOpen a ticket below to buy or sell.`)
    .setTimestamp();
}

function skellyTicketComponents() {
  const buyBtn = new ButtonBuilder().setCustomId("skelly_buy").setLabel("Buy Spawners").setStyle(ButtonStyle.Success);
  const sellBtn = new ButtonBuilder().setCustomId("skelly_sell").setLabel("Sell Spawners").setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buyBtn, sellBtn)];
}

function farmTicketPanelEmbed() {
  const data = storage.getData();
  const desc = storage.getCategoryMessage("buy-farms") ?? FARM_CATEGORY.description;
  return new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle("Buy Farms")
    .setDescription(`**${FARM_CATEGORY.label}** – ${desc}\n\n${data.farmList}`)
    
    .setTimestamp();
}

function farmTicketComponents() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("sel_farm_topic")
    .setPlaceholder("Open a Farm Ticket")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Buy Farms")
        .setValue("buy-farms")
        .setDescription("Open a farm purchase ticket"),
    );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

function farmInfoEmbed() {
  const data = storage.getData();
  return new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle("Buy Farms")
    .setDescription(data.farmDescription)
    .addFields({ name: "Available Farms", value: data.farmList.slice(0, 1024) })
    
    .setTimestamp();
}

function okEmbed(msg: string) {
  return new EmbedBuilder().setColor(SUCCESS_COLOR).setDescription(msg);
}
function errEmbed(msg: string) {
  return new EmbedBuilder().setColor(ERROR_COLOR).setDescription(msg);
}
function infoEmbed(msg: string) {
  return new EmbedBuilder().setColor(BOT_COLOR).setDescription(msg);
}

