#!/usr/bin/env node
// Use the base Server class which seems to have setRequestHandler
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Import request schemas and error types for manual handling
// Also import CallToolRequest type
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios'; // Remove AxiosInstance import
// Import configuration variables (removed unused ones)
import { GEMINI_API_KEY, GEMINI_API_URL, REQUEST_TIMEOUT, } from './config.js'; // Add .js extension
// Note: CF_ACCOUNT_ID and CF_PUBLIC_URL_BASE were removed from config.ts, so removed here too.
import { getEffectiveMediaSizeLimit } from './utils/mediaLimitUtils.js'; // Import the new utility function
// --- Calculate effective limit for descriptions using the utility function ---
const { limitMB: EFFECTIVE_LIMIT_MB_FOR_DESC } = getEffectiveMediaSizeLimit('index');
// --- Tool Schemas and Handlers ---
// Import shapes, full schemas (where different), and handlers
import { generateImageSchema, handleGenerateImage } from './tools/generateImage.js';
// Import both shape and the full schema for editImage
import { editImageSchema, handleEditImage } from './tools/editImage.js';
import { generateVideoSchema, handleGenerateVideo } from './tools/generateVideo.js';
// Import both shape and the full schema for understandMedia
import { understandMediaSchema, handleUnderstandMedia } from './tools/understandMedia.js';
import { listFilesSchema, handleListFiles } from './tools/listFiles.js'; // Import listFiles tool
import { deleteFileSchema, handleDeleteFile } from './tools/deleteFile.js'; // Import deleteFile tool
import { webSearchSchema, handleWebSearch } from './tools/webSearch.js'; // Import webSearch tool
// Import the new large media upload tool
import { uploadLargeMediaSchema, handleUploadLargeMedia } from './tools/uploadLargeMedia.js';
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
    version: '1.3.9' // Initial version
    // Declare tool capability to allow setRequestHandler for tool schemas
}, { capabilities: { tools: {} } });
// --- Tool Definitions with Descriptions ---
// Define tools manually, using detailed JSON Schema literals matching openapi-integrator-mcp structure
const toolDefinitions = [
    {
        name: 'gemini_generate_image',
        description: "Generates an image based on a text prompt using the Google Gemini image generation service (Imagen 3 or Gemini 2.0 Flash).",
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: "Required. Descriptive text prompt for the Google Gemini image generation service. (English is recommended for best results)." },
                aspectRatio: { type: 'string', enum: ["1:1", "3:4", "4:3", "9:16", "16:9"], default: "1:1", description: "Optional. Aspect ratio for the generated image (ignored by gemini-2.0 model)." },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'gemini_edit_image',
        description: "Edits an image based on a text prompt using the Google Gemini image editing service.",
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: "Required. Instructions for how the Google Gemini service should edit the provided image. (English is recommended for best results)." },
                image_url: { type: 'string', format: 'url', description: "Optional. URL of the image to edit using Gemini." },
                image_path: { type: 'string', description: "Optional. Local path to the image to edit using Gemini." },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'gemini_generate_video',
        description: "Generates a video based on a text prompt using the Google Gemini video generation service (Veo). This is an asynchronous operation.",
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: "Required. Descriptive text prompt for the Google Gemini video generation service (Veo). (English is recommended for best results)." },
                aspectRatio: { type: 'string', enum: ["16:9", "9:16", "1:1"], default: "16:9", description: "Optional. Aspect ratio for the generated video. Defaults to 16:9." },
                personGeneration: { type: 'string', enum: ["dont_allow", "allow_adult"], default: "dont_allow", description: "Optional. Control generation of people ('dont_allow', 'allow_adult'). Defaults to dont_allow." },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'gemini_understand_media',
        description: "Analyzes the content of a provided media file (image, audio, video, document) using the Google Gemini multimodal understanding service and answers questions about it. Provide exactly one file source: 'file_url', 'file_path', or ('file_api_uri' and 'file_mime_type'). Do not use Base64 encoded strings.",
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: "Required. The specific question or instruction for the Google Gemini multimodal model about the content of the provided file." },
                file_url: { type: 'string', format: 'url', description: "Optional. URL of the file (image, video, audio, pdf, text, code) OR a YouTube video URL. Provide only one file source." },
                file_path: { type: 'string', description: "Optional. Local path to the file (image, video, audio, pdf, text, code). Provide only one file source." },
                file_api_uri: { type: 'string', format: 'url', pattern: '^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-zA-Z0-9]+$', description: "Optional. Pre-uploaded file URI. If provided, 'file_mime_type' is also required. Provide only one file source." },
                file_mime_type: { type: 'string', description: "Required only if 'file_api_uri' is provided. The MIME type." },
            },
            required: ['text'], // 'text' is always required. File source requirement handled by refine in the schema itself.
        },
    },
    {
        name: 'gemini_list_files',
        description: "Lists files previously uploaded to the Google Gemini File API service.",
        inputSchema: {
            type: 'object',
            properties: {}, // No specific properties needed for listFiles input
            required: [],
        },
    },
    {
        name: 'gemini_delete_file',
        description: "Deletes a specific file from the Google Gemini File API storage using its relative name.",
        inputSchema: {
            type: 'object',
            properties: {
                fileName: { type: 'string', pattern: '^files\/[a-zA-Z0-9]+$', description: "Required. The relative name of the file (e.g., 'files/kch7l0eddn96')." },
            },
            required: ['fileName'],
        },
    },
    {
        name: 'gemini_web_search',
        description: "Performs a web search using the Google Gemini Search Retrieval tool and returns the answer along with search sources.",
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: "Required. The search query or question." },
            },
            required: ['query'],
        },
    },
    {
        name: 'gemini_upload_large_media',
        description: `Uploads a large media file (larger than the configured ${EFFECTIVE_LIMIT_MB_FOR_DESC}MB limit for 'understandMedia') to the Google Gemini File API in the background. Returns an immediate confirmation and sends a notification (via configured OneBot/Telegram) upon completion or failure. Requires notification setup.`,
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', format: 'url', description: `Optional. URL of the large media file (larger than ${EFFECTIVE_LIMIT_MB_FOR_DESC}MB) to upload.` },
                path: { type: 'string', description: `Optional. Local path to the large media file (larger than ${EFFECTIVE_LIMIT_MB_FOR_DESC}MB) to upload.` },
            },
            required: [], // The refine function in the schema handles the one-of logic
        },
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
        'gemini_upload_large_media': uploadLargeMediaSchema, // Add the new schema
    };
    const schema = toolSchemas[name];
    if (!schema) {
        // Should be caught earlier, but safety check
        throw new McpError(ErrorCode.MethodNotFound, `Schema not found for tool '${name}'.`);
    }
    // Validate arguments against the schema
    // Ensure args is at least an empty object before parsing, in case client sends null/undefined
    const argsToValidate = args || {};
    const validationResult = schema.safeParse(argsToValidate);
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
            case 'gemini_upload_large_media':
                return await handleUploadLargeMedia(validatedArgs); // Does not need axiosInstance directly
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