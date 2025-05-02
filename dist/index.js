#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const axios_1 = __importDefault(require("axios")); // Remove AxiosInstance import
// Import configuration variables
const config_1 = require("./config");
// Note: CF_ACCOUNT_ID and CF_PUBLIC_URL_BASE were removed from config.ts, so removed here too.
// --- Tool Schemas and Handlers ---
const generateImage_1 = require("./tools/generateImage");
// Import the exported shape for the refined schema
const editImage_1 = require("./tools/editImage");
const generateVideo_1 = require("./tools/generateVideo");
// --- Initialization ---
// Validate essential configuration
if (!config_1.GEMINI_API_KEY) {
    console.error('[gemini-integrator-mcp] Error: Gemini API key (GEMINI_API_KEY) is not configured.');
    process.exit(1); // Exit if key is missing
}
if (!config_1.GEMINI_API_URL) {
    console.error('[gemini-integrator-mcp] Error: Gemini API URL (GEMINI_API_URL) is not configured.');
    process.exit(1); // Exit if URL is missing
}
// Create a shared Axios instance for Gemini API calls
// Note: Gemini API uses API Key in the URL query parameter, not usually in headers like OpenAI
const axiosInstance = axios_1.default.create({
    baseURL: config_1.GEMINI_API_URL, // Base URL is set, key will be added per request
    timeout: config_1.REQUEST_TIMEOUT,
    headers: {
        'Content-Type': 'application/json',
        // Gemini often uses x-goog-api-key header or key in query param
        // We'll add the key in the request URL itself later
    }
});
// Create the MCP Server instance
const server = new mcp_js_1.McpServer({
    name: 'gemini-integrator-mcp',
    version: '1.0.0' // Initial version
});
// --- Tool Registration ---
// Register the gemini_generate_image tool
server.tool('gemini_generate_image', generateImage_1.generateImageSchema.shape, // Use .shape for basic object schema
// Remove 'any', let TS infer params type from schema shape
(validatedParams, extra) => (0, generateImage_1.handleGenerateImage)(validatedParams, axiosInstance));
// Register the gemini_edit_image tool
server.tool('gemini_edit_image', editImage_1.editImageShape, // Use the explicitly exported shape for refined schema
// Remove 'any'
(validatedParams, extra) => (0, editImage_1.handleEditImage)(validatedParams, axiosInstance));
// Register the gemini_generate_video tool
server.tool('gemini_generate_video', generateVideo_1.generateVideoSchema.shape, // Use .shape for basic object schema
// Remove 'any'
(validatedParams, extra) => (0, generateVideo_1.handleGenerateVideo)(validatedParams, axiosInstance));
// --- Server Connection ---
// Create the transport (stdio in this case)
const transport = new stdio_js_1.StdioServerTransport();
// Connect the server to the transport
server.connect(transport)
    .then(() => {
    console.log('[gemini-integrator-mcp] Gemini Integrator MCP Server started successfully.');
})
    .catch((error) => {
    console.error('[gemini-integrator-mcp] Error starting server:', error);
    process.exit(1);
});
console.log('[gemini-integrator-mcp] Attempting to start Gemini Integrator MCP Server...');
//# sourceMappingURL=index.js.map