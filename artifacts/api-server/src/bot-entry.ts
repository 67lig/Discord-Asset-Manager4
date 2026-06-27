import { createBotClient } from "./bot/bot.js";
import { logger } from "./lib/logger.js";

logger.info("Starting Discord bot...");
createBotClient();
