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
// --- Cloudflare ImgBed Configuration ---
export const CF_IMGBED_UPLOAD_URL = cliArgs.CF_IMGBED_UPLOAD_URL || process.env.CF_IMGBED_UPLOAD_URL;
export const CF_IMGBED_API_KEY = cliArgs.CF_IMGBED_API_KEY || process.env.CF_IMGBED_API_KEY;
// --- Output Configuration ---
export const DEFAULT_OUTPUT_DIR = cliArgs.DEFAULT_OUTPUT_DIR || process.env.DEFAULT_OUTPUT_DIR || './output';
// --- Request Configuration ---
export const REQUEST_TIMEOUT = parseInt(cliArgs.REQUEST_TIMEOUT || process.env.REQUEST_TIMEOUT || '180000', 10); // Default 180 seconds (3 minutes)
// --- Validation ---
if (!GEMINI_API_KEY) {
    console.error('[gemini-integrator-mcp] Error: Gemini API key (GEMINI_API_KEY) is not configured.');
    // process.exit(1); // Consider exiting if the key is absolutely essential
}
// Log loaded config (optional, for debugging)
// console.log('[gemini-integrator-mcp] Configuration loaded:');
// console.log(` - GEMINI_API_URL: ${GEMINI_API_URL}`);
// console.log(` - DEFAULT_OUTPUT_DIR: ${DEFAULT_OUTPUT_DIR}`);
// console.log(` - REQUEST_TIMEOUT: ${REQUEST_TIMEOUT}ms`);
// console.log(` - CF ImgBed Upload URL configured: ${!!CF_IMGBED_UPLOAD_URL}`);
// console.log(` - CF ImgBed API Key configured: ${!!CF_IMGBED_API_KEY}`);
//# sourceMappingURL=config.js.map