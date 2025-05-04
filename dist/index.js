#!/usr/bin/env node
// Use the base Server class which seems to have setRequestHandler
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Import request schemas and error types for manual handling
// Also import CallToolRequest type for parameter typing
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios'; // Remove AxiosInstance import
// Import configuration variables (removed unused ones)
import { GEMINI_API_KEY, GEMINI_API_URL, REQUEST_TIMEOUT } from './config.js'; // Add .js extension
// Note: CF_ACCOUNT_ID and CF_PUBLIC_URL_BASE were removed from config.ts, so removed here too.
// --- Tool Schemas and Handlers ---
// Import shapes, full schemas (where different), and handlers
import { generateImageSchema, handleGenerateImage } from './tools/generateImage.js';
// Import both shape and the full schema for editImage
import { editImageShape, editImageSchema, handleEditImage } from './tools/editImage.js';
import { generateVideoSchema, handleGenerateVideo } from './tools/generateVideo.js';
// Import both shape and the full schema for understandMedia
import { understandMediaShape, understandMediaSchema, handleUnderstandMedia } from './tools/understandMedia.js';
import { listFilesSchema, handleListFiles } from './tools/listFiles.js'; // Import listFiles tool
import { deleteFileSchema, handleDeleteFile } from './tools/deleteFile.js'; // Import deleteFile tool
import { webSearchSchema, handleWebSearch } from './tools/webSearch.js'; // Import webSearch tool
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
// Create the Server instance (using Server, not McpServer)
const server = new Server({
    name: 'gemini-integrator-mcp',
    version: '1.2.4' // Initial version
    // Declare tool capability to allow setRequestHandler for tool schemas
}, { capabilities: { tools: {} } });
// --- Tool Definitions with Descriptions ---
// Define tools manually to include descriptions
const toolDefinitions = [
    {
        name: 'gemini_generate_image',
        description: "Generates an image based on a text prompt using the Google Gemini image generation service (Imagen 3 or Gemini 2.0 Flash).",
        // IMPORTANT: Using the Zod shape directly might not be standard JSON Schema.
        // The client needs to be able to interpret this or it needs conversion.
        input_schema: generateImageSchema.shape,
    },
    {
        name: 'gemini_edit_image',
        description: "Edits an image based on a text prompt using the Google Gemini image editing service.",
        input_schema: editImageShape,
    },
    {
        name: 'gemini_generate_video',
        description: "Generates a video based on a text prompt using the Google Gemini video generation service (Veo). This is an asynchronous operation.",
        input_schema: generateVideoSchema.shape,
    },
    {
        name: 'gemini_understand_media',
        description: "Analyzes the content of provided media files (images, audio, video, documents) using the Google Gemini multimodal understanding service and answers questions about them.",
        input_schema: understandMediaShape,
    },
    {
        name: 'gemini_list_files',
        description: "Lists files previously uploaded to the Google Gemini File API service.",
        input_schema: listFilesSchema.shape,
    },
    {
        name: 'gemini_delete_file',
        description: "Deletes a specific file from the Google Gemini File API storage using its relative name.",
        input_schema: deleteFileSchema.shape,
    },
    {
        name: 'gemini_web_search',
        description: "Performs a web search using the Google Gemini Search Retrieval tool and returns the answer along with search sources.",
        input_schema: webSearchSchema.shape,
    },
];
// --- Request Handlers ---
// Handle ListTools request - return the manually defined tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
}));
// Handle CallTool request - dispatch to the correct handler
// Add type annotation for the request parameter
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Find the tool definition (optional, for potential validation or logging)
    const toolDef = toolDefinitions.find(t => t.name === name);
    if (!toolDef) {
        // Use PascalCase for ErrorCode
        throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' not found.`);
    }
    // TODO: Consider adding Zod validation here using toolDef.input_schema if needed,
    // although the handler functions might perform their own validation via Zod parse.
    console.log(`[MCP Server] Received call for tool: ${name} with args:`, JSON.stringify(args)); // Add logging including args
    // Define schemas map for easy lookup
    const toolSchemas = {
        'gemini_generate_image': generateImageSchema,
        'gemini_edit_image': editImageSchema, // Use the refined schema for validation
        'gemini_generate_video': generateVideoSchema,
        'gemini_understand_media': understandMediaSchema, // Use the refined schema
        'gemini_list_files': listFilesSchema,
        'gemini_delete_file': deleteFileSchema,
        'gemini_web_search': webSearchSchema,
    };
    const schema = toolSchemas[name];
    if (!schema) {
        // Should be caught earlier, but safety check
        throw new McpError(ErrorCode.MethodNotFound, `Schema not found for tool '${name}'.`);
    }
    // Validate arguments against the schema
    const validationResult = schema.safeParse(args);
    if (!validationResult.success) {
        console.error(`[MCP Server] Invalid arguments for tool '${name}':`, validationResult.error.errors);
        // Provide detailed validation errors if possible
        const errorDetails = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool '${name}': ${errorDetails}`);
    }
    // Use validated data
    const validatedArgs = validationResult.data;
    console.log(`[MCP Server] Arguments validated successfully for tool: ${name}`);
    try {
        switch (name) {
            case 'gemini_generate_image':
                return await handleGenerateImage(validatedArgs, axiosInstance);
            case 'gemini_edit_image':
                return await handleEditImage(validatedArgs, axiosInstance);
            case 'gemini_generate_video':
                return await handleGenerateVideo(validatedArgs, axiosInstance);
            case 'gemini_understand_media':
                return await handleUnderstandMedia(validatedArgs, axiosInstance);
            case 'gemini_list_files':
                return await handleListFiles(validatedArgs, axiosInstance);
            case 'gemini_delete_file':
                return await handleDeleteFile(validatedArgs, axiosInstance);
            case 'gemini_web_search':
                return await handleWebSearch(validatedArgs, axiosInstance);
            default:
                // This case should be caught by the check above or schema lookup
                throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' not found.`);
        }
    }
    catch (error) {
        // Catch errors from handlers and wrap them if they aren't already McpError
        console.error(`[MCP Server] Error executing tool '${name}':`, error);
        if (error instanceof McpError) {
            throw error;
        }
        else if (error instanceof Error) {
            // Wrap other errors in a generic server error
            // Use PascalCase for ErrorCode
            throw new McpError(ErrorCode.InternalError, `Error executing tool ${name}: ${error.message}`);
        }
        else {
            // Use PascalCase for ErrorCode
            throw new McpError(ErrorCode.InternalError, `Unknown error executing tool ${name}.`);
        }
    }
});
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