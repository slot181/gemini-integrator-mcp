#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios'; // Remove AxiosInstance import
// Import configuration variables (removed unused ones)
import { GEMINI_API_KEY, GEMINI_API_URL, REQUEST_TIMEOUT } from './config.js'; // Add .js extension
// Note: CF_ACCOUNT_ID and CF_PUBLIC_URL_BASE were removed from config.ts, so removed here too.
// --- Tool Schemas and Handlers ---
// Import only the shape and handler for each tool
import { generateImageSchema, handleGenerateImage } from './tools/generateImage.js';
import { editImageShape, handleEditImage } from './tools/editImage.js';
import { generateVideoSchema, handleGenerateVideo } from './tools/generateVideo.js';
import { understandMediaShape, handleUnderstandMedia } from './tools/understandMedia.js';
import { listFilesSchema, handleListFiles } from './tools/listFiles.js'; // Import listFiles tool
import { deleteFileSchema, handleDeleteFile } from './tools/deleteFile.js'; // Import deleteFile tool
// --- Initialization ---
// Validate essential configuration
if (!GEMINI_API_KEY) {
    console.error('[gemini-integrator-mcp] Error: Gemini API key (GEMINI_API_KEY) is not configured.');
    process.exit(1); // Exit if key is missing
}
if (!GEMINI_API_URL) {
    console.error('[gemini-integrator-mcp] Error: Gemini API URL (GEMINI_API_URL) is not configured.');
    process.exit(1); // Exit if URL is missing
}
// Create a shared Axios instance for Gemini API calls
// Note: Gemini API uses API Key in the URL query parameter, not usually in headers like OpenAI
const axiosInstance = axios.create({
    baseURL: GEMINI_API_URL, // Base URL is set, key will be added per request
    timeout: REQUEST_TIMEOUT,
    headers: {
        'Content-Type': 'application/json',
        // Gemini often uses x-goog-api-key header or key in query param
        // We'll add the key in the request URL itself later
    }
});
// Create the MCP Server instance
const server = new McpServer({
    name: 'gemini-integrator-mcp',
    version: '1.1.0' // Initial version
});
// --- Tool Registration ---
// Register the gemini_generate_image tool
server.tool('gemini_generate_image', generateImageSchema.shape, // Use .shape for basic object schema
// Remove 'any', let TS infer params type from schema shape
(validatedParams, extra) => handleGenerateImage(validatedParams, axiosInstance));
// Register the gemini_edit_image tool
server.tool('gemini_edit_image', editImageShape, // Use the explicitly exported shape
(validatedParams, extra) => handleEditImage(validatedParams, axiosInstance));
// Register the gemini_generate_video tool
server.tool('gemini_generate_video', generateVideoSchema.shape, // Use .shape for basic object schema
(validatedParams, extra) => handleGenerateVideo(validatedParams, axiosInstance));
// Register the gemini_understand_media tool
server.tool('gemini_understand_media', understandMediaShape, // Use the exported base shape for registration
(validatedParams, extra) => handleUnderstandMedia(validatedParams, axiosInstance));
// Register the gemini_list_files tool
server.tool('gemini_list_files', listFilesSchema.shape, // Empty schema, use .shape
(validatedParams, extra) => handleListFiles(validatedParams, axiosInstance));
// Register the gemini_delete_file tool
server.tool('gemini_delete_file', deleteFileSchema.shape, // Use .shape for basic object schema
(validatedParams, extra) => handleDeleteFile(validatedParams, axiosInstance));
// --- Server Connection ---
// Create the transport (stdio in this case)
const transport = new StdioServerTransport();
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