import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import {
    ONEBOT_HTTP_URL,
    ONEBOT_ACCESS_TOKEN,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    ONEBOT_MESSAGE_TYPE,
    ONEBOT_TARGET_ID,
    REQUEST_TIMEOUT
} from '../config.js';

/**
 * Sends a notification message using OneBot v11 HTTP API based on configuration.
 */
export async function sendOneBotNotification(message: string): Promise<void> {
    // Check if essential OneBot config is present
    if (!ONEBOT_HTTP_URL || !ONEBOT_MESSAGE_TYPE || !ONEBOT_TARGET_ID) {
        // console.log('[OneBot Notification] URL, Message Type, or Target ID not configured, skipping.');
        return;
    }

    // Validate message type
    if (ONEBOT_MESSAGE_TYPE !== 'private' && ONEBOT_MESSAGE_TYPE !== 'group') {
        console.error(`[OneBot Notification] Invalid ONEBOT_MESSAGE_TYPE configured: '${ONEBOT_MESSAGE_TYPE}'. Must be 'private' or 'group'. Skipping.`);
        return;
    }

    console.log(`[OneBot Notification] Sending ${ONEBOT_MESSAGE_TYPE} notification to target ${ONEBOT_TARGET_ID} via ${ONEBOT_HTTP_URL}...`);

    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (ONEBOT_ACCESS_TOKEN) {
            headers['Authorization'] = `Bearer ${ONEBOT_ACCESS_TOKEN}`;
        }

        let action: string;
        let params: Record<string, string | number>;

        if (ONEBOT_MESSAGE_TYPE === 'private') {
            action = 'send_private_msg';
            params = {
                user_id: parseInt(ONEBOT_TARGET_ID, 10), // Convert ID to number
                message: message
            };
        } else { // ONEBOT_MESSAGE_TYPE === 'group'
            action = 'send_group_msg';
            params = {
                group_id: parseInt(ONEBOT_TARGET_ID, 10), // Convert ID to number
                message: message
            };
        }

        // Construct URL with action as path, removing potential trailing slash from base URL
        const requestUrl = `${ONEBOT_HTTP_URL.replace(/\/$/, '')}/${action}`;
        console.log(`[OneBot Notification] Sending POST to ${requestUrl}`);

        // Send params directly as the request body
        await axios.post(requestUrl, params, {
            headers,
            timeout: REQUEST_TIMEOUT / 2 // Use a shorter timeout for notifications
        });
        console.log('[OneBot Notification] Notification sent successfully.');

    } catch (error: any) {
        console.error(`[OneBot Notification] Failed to send notification:`, error.response?.data || error.message || error);
    }
}

/**
 * Sends a notification message using Telegram Bot API.
 */
export async function sendTelegramNotification(message: string): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        // console.log('[Telegram Notification] Token or Chat ID not configured, skipping.');
        return;
    }
    console.log(`[Telegram Notification] Sending notification to Chat ID ${TELEGRAM_CHAT_ID}...`);
    try {
        const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' }); // Use Markdown for potential formatting
        console.log('[Telegram Notification] Notification sent successfully.');
    } catch (error: any) {
        console.error(`[Telegram Notification] Failed to send notification:`, error.response?.body || error.message || error);
    }
}

/**
 * Checks if at least one notification method (OneBot or Telegram) is configured.
 */
export function isNotificationConfigured(): boolean {
    const isOneBotConfigured = !!(ONEBOT_HTTP_URL && ONEBOT_MESSAGE_TYPE && ONEBOT_TARGET_ID);
    const isTelegramConfigured = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
    return isOneBotConfigured || isTelegramConfigured;
}

/**
 * Gets a string indicating which notification methods are configured.
 */
export function getConfiguredNotifiers(): string {
    const configured: string[] = [];
    if (!!(ONEBOT_HTTP_URL && ONEBOT_MESSAGE_TYPE && ONEBOT_TARGET_ID)) {
        configured.push('OneBot');
    }
    if (!!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)) {
        configured.push('Telegram');
    }
    if (configured.length === 0) {
        return 'none';
    }
    return configured.join('/');
}
