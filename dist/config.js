import dotenv from 'dotenv';
// Load environment variables from .env file
dotenv.config();
// Helper function to parse command-line arguments (optional, but good practice)
// Example: node dist/index.js -e GEMINI_API_KEY your_key -e REQUEST_TIMEOUT 60000
function parseCliArgs(argv) {
    const args = argv.slice(2); // Skip node executable and script path
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-e' && i + 2 < args.length) {
            const key = args[i + 1];
            const value = args[i + 2];
            parsed[key] = value;
            i += 2; // Move index past the key and value
        }
    }
    return parsed;
}
const cliArgs = parseCliArgs(process.argv);
// --- Gemini Configuration ---
export const GEMINI_API_KEY = cliArgs.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
export const GEMINI_API_URL = cliArgs.GEMINI_API_URL || process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com';
// Add model selection for image generation
export const GEMINI_IMAGE_GEN_MODEL = cliArgs.GEMINI_IMAGE_GEN_MODEL || process.env.GEMINI_IMAGE_GEN_MODEL || 'gemini-2.0-flash-exp-image-generation'; // Default model
// Add model selection for media understanding
export const GEMINI_UNDERSTANDING_MODEL = cliArgs.GEMINI_UNDERSTANDING_MODEL || process.env.GEMINI_UNDERSTANDING_MODEL || 'gemini-2.0-flash'; // Default model
// Add model selection for web search
export const GEMINI_SEARCH_MODEL = cliArgs.GEMINI_SEARCH_MODEL || process.env.GEMINI_SEARCH_MODEL || 'gemini-1.5-flash'; // Default model for search
// --- Cloudflare ImgBed Configuration ---
export const CF_IMGBED_UPLOAD_URL = cliArgs.CF_IMGBED_UPLOAD_URL || process.env.CF_IMGBED_UPLOAD_URL;
export const CF_IMGBED_API_KEY = cliArgs.CF_IMGBED_API_KEY || process.env.CF_IMGBED_API_KEY;
// --- Output Configuration ---
export const DEFAULT_OUTPUT_DIR = cliArgs.DEFAULT_OUTPUT_DIR || process.env.DEFAULT_OUTPUT_DIR || './output';
// --- Request Configuration ---
export const REQUEST_TIMEOUT = parseInt(cliArgs.REQUEST_TIMEOUT || process.env.REQUEST_TIMEOUT || '180000', 10); // Default 180 seconds (3 minutes)
// --- File Handling Configuration ---
// Export the raw user-configured limit string (MB) for the understandMedia tool.
// The tool itself will handle parsing, validation, and defaulting.
export const RAW_UNDERSTAND_MEDIA_SIZE_LIMIT_MB = cliArgs.UNDERSTAND_MEDIA_SIZE_LIMIT_MB || process.env.UNDERSTAND_MEDIA_SIZE_LIMIT_MB;
// --- Notification Configuration (Optional) ---
// OneBot v11 HTTP Notification
export const ONEBOT_HTTP_URL = cliArgs.ONEBOT_HTTP_URL || process.env.ONEBOT_HTTP_URL;
export const ONEBOT_ACCESS_TOKEN = cliArgs.ONEBOT_ACCESS_TOKEN || process.env.ONEBOT_ACCESS_TOKEN; // Optional access token
export const ONEBOT_MESSAGE_TYPE = cliArgs.ONEBOT_MESSAGE_TYPE || process.env.ONEBOT_MESSAGE_TYPE; // 'private' or 'group'
export const ONEBOT_TARGET_ID = cliArgs.ONEBOT_TARGET_ID || process.env.ONEBOT_TARGET_ID; // User ID (for private) or Group ID (for group)
// Telegram Bot Notification
export const TELEGRAM_BOT_TOKEN = cliArgs.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = cliArgs.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
// --- Validation ---
if (!GEMINI_API_KEY) {
    console.error('[gemini-integrator-mcp] Error: Gemini API key (GEMINI_API_KEY) is not configured.');
    // process.exit(1); // Consider exiting if the key is absolutely essential
}
//# sourceMappingURL=config.js.map