"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUEST_TIMEOUT = exports.DEFAULT_OUTPUT_DIR = exports.CF_IMGBED_API_KEY = exports.CF_IMGBED_UPLOAD_URL = exports.GEMINI_API_URL = exports.GEMINI_API_KEY = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
// Load environment variables from .env file
dotenv_1.default.config();
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
exports.GEMINI_API_KEY = cliArgs.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
exports.GEMINI_API_URL = cliArgs.GEMINI_API_URL || process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com';
// --- Cloudflare ImgBed Configuration ---
exports.CF_IMGBED_UPLOAD_URL = cliArgs.CF_IMGBED_UPLOAD_URL || process.env.CF_IMGBED_UPLOAD_URL;
exports.CF_IMGBED_API_KEY = cliArgs.CF_IMGBED_API_KEY || process.env.CF_IMGBED_API_KEY;
// --- Output Configuration ---
exports.DEFAULT_OUTPUT_DIR = cliArgs.DEFAULT_OUTPUT_DIR || process.env.DEFAULT_OUTPUT_DIR || './output';
// --- Request Configuration ---
exports.REQUEST_TIMEOUT = parseInt(cliArgs.REQUEST_TIMEOUT || process.env.REQUEST_TIMEOUT || '180000', 10); // Default 180 seconds (3 minutes)
// --- Validation ---
if (!exports.GEMINI_API_KEY) {
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