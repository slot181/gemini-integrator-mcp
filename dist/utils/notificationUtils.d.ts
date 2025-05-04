/**
 * Sends a notification message using OneBot v11 HTTP API based on configuration.
 */
export declare function sendOneBotNotification(message: string): Promise<void>;
/**
 * Sends a notification message using Telegram Bot API.
 */
export declare function sendTelegramNotification(message: string): Promise<void>;
/**
 * Checks if at least one notification method (OneBot or Telegram) is configured.
 */
export declare function isNotificationConfigured(): boolean;
/**
 * Gets a string indicating which notification methods are configured.
 */
export declare function getConfiguredNotifiers(): string;
