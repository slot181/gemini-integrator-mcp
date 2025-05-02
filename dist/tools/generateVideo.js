"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateVideoSchema = void 0;
exports.handleGenerateVideo = handleGenerateVideo;
const zod_1 = require("zod");
const axios_1 = __importDefault(require("axios")); // Keep default import
const path = __importStar(require("path"));
// Import shared utilities and config
const fileUtils_1 = require("../utils/fileUtils");
const cfUtils_1 = require("../utils/cfUtils");
const config_1 = require("../config"); // Added REQUEST_TIMEOUT import
// Define the input schema for the generateVideo tool using Zod
exports.generateVideoSchema = zod_1.z.object({
    prompt: zod_1.z.string().min(1, "Prompt cannot be empty"),
    aspectRatio: zod_1.z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"), // Example parameter
    personGeneration: zod_1.z.enum(["allow", "dont_allow"]).optional().default("dont_allow"), // Example parameter
    // Add other potential video parameters
});
// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Polling configuration
const POLLING_INTERVAL_MS = 10000; // Check every 10 seconds
const MAX_POLLING_ATTEMPTS = 360; // Max attempts (e.g., 360 * 10s = 1 hour timeout)
/**
 * Handles the video generation tool request.
 * Initiates async generation, polls for completion, saves the video locally,
 * uploads to CF ImgBed if configured, and returns the results.
 */
async function handleGenerateVideo(params, axiosInstance // Use 'any' to bypass Axios type issues
) {
    const { prompt, aspectRatio, personGeneration } = params;
    const videoOutputDir = path.join(config_1.DEFAULT_OUTPUT_DIR, 'video'); // Specific subfolder
    try {
        console.log(`[generateVideo] Received request with prompt: "${prompt}"`);
        // --- 1. Initiate Async Video Generation ---
        // Adjust model name based on Gemini docs (e.g., 'veo-2.0-generate-001')
        const startApiUrl = `/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${config_1.GEMINI_API_KEY}`;
        const startRequestPayload = {
            instances: [{ prompt }],
            parameters: {
                aspectRatio,
                personGeneration,
                // Add other parameters from schema if needed
            }
        };
        console.log(`[generateVideo] Calling Gemini API to start video generation: ${axiosInstance.defaults.baseURL}${startApiUrl}`);
        // Remove type argument as axiosInstance is 'any'
        const startResponse = await axiosInstance.post(startApiUrl, startRequestPayload);
        const operationName = startResponse.data?.name;
        if (!operationName) {
            console.error('[generateVideo] No operation name received from Gemini:', JSON.stringify(startResponse.data));
            throw new Error('Failed to initiate video generation task.');
        }
        console.log(`[generateVideo] Video generation task started. Operation Name: ${operationName}`);
        // --- 2. Poll for Task Completion ---
        let attempts = 0;
        let operationStatus = null;
        const operationStatusUrl = `${config_1.GEMINI_API_URL}/v1beta/${operationName}?key=${config_1.GEMINI_API_KEY}`; // Construct polling URL
        while (attempts < MAX_POLLING_ATTEMPTS) {
            attempts++;
            console.log(`[generateVideo] Polling status for ${operationName} (Attempt ${attempts}/${MAX_POLLING_ATTEMPTS})... URL: ${operationStatusUrl}`);
            try {
                // Use a direct axios call for polling as it might have different base URL/auth needs if operation URL is absolute
                const pollResponse = await axios_1.default.get(operationStatusUrl, { timeout: config_1.REQUEST_TIMEOUT }); // Use configured timeout
                operationStatus = pollResponse.data;
                if (operationStatus?.done) {
                    console.log(`[generateVideo] Operation ${operationName} completed.`);
                    break; // Exit polling loop
                }
            }
            catch (pollError) {
                // Log polling error but continue polling unless max attempts reached
                console.error(`[generateVideo] Error polling operation status for ${operationName}:`, pollError);
                // Optional: Implement backoff strategy here
            }
            if (attempts >= MAX_POLLING_ATTEMPTS) {
                console.error(`[generateVideo] Operation ${operationName} timed out after ${MAX_POLLING_ATTEMPTS} attempts.`);
                throw new Error(`Video generation timed out after ${MAX_POLLING_ATTEMPTS * POLLING_INTERVAL_MS / 1000} seconds.`);
            }
            await delay(POLLING_INTERVAL_MS); // Wait before next poll
        }
        // --- 3. Process Completed Operation ---
        if (!operationStatus || !operationStatus.done) {
            // Should ideally be caught by timeout, but double-check
            throw new Error('Video generation did not complete successfully.');
        }
        if (operationStatus.error) {
            console.error(`[generateVideo] Operation ${operationName} failed with error:`, JSON.stringify(operationStatus.error));
            throw new Error(`Video generation failed: ${operationStatus.error.message} (Code: ${operationStatus.error.code})`);
        }
        if (!operationStatus.response) {
            console.error(`[generateVideo] Operation ${operationName} completed but response is missing:`, JSON.stringify(operationStatus));
            throw new Error('Video generation completed but no response data found.');
        }
        // --- Extract Video Data (Needs Verification based on actual API) ---
        // Prioritize inlineData if available, otherwise check for URI
        const parts = operationStatus.response.candidates?.[0]?.content?.parts;
        const videoPart = parts?.find((part) => // Use any temporarily
         (part.inlineData && part.inlineData.mimeType.startsWith('video/')) ||
            (part.uri && part.uri.toLowerCase().endsWith('.mp4')) // Example check for URI
        );
        let videoData;
        let fileExtension = 'mp4'; // Default
        if (videoPart?.inlineData) {
            console.log('[generateVideo] Found video data in inlineData.');
            const base64Data = videoPart.inlineData.data;
            const mimeType = videoPart.inlineData.mimeType;
            fileExtension = mimeType.split('/')[1] || 'mp4';
            videoData = Buffer.from(base64Data, 'base64');
        }
        else if (videoPart?.uri) {
            // If Gemini returns a URI (e.g., GCS), we need to download it
            const videoUri = videoPart.uri;
            console.log(`[generateVideo] Found video URI: ${videoUri}. Attempting download...`);
            try {
                // This might require authenticated download depending on the URI type
                const downloadResponse = await axios_1.default.get(videoUri, { responseType: 'arraybuffer', timeout: config_1.REQUEST_TIMEOUT * 2 }); // Longer timeout for download
                // Explicitly cast data to ArrayBuffer before passing to Buffer.from
                videoData = Buffer.from(downloadResponse.data);
                // Try to get extension from URI
                const uriPath = new URL(videoUri).pathname;
                const ext = path.extname(uriPath).toLowerCase().substring(1);
                if (ext)
                    fileExtension = ext;
            }
            catch (downloadError) {
                console.error(`[generateVideo] Failed to download video from URI ${videoUri}:`, downloadError);
                throw new Error(`Failed to download video from provided URI: ${videoUri}`);
            }
        }
        else if (operationStatus.response.videoUri) {
            // Handle direct videoUri if the API provides it
            const videoUri = operationStatus.response.videoUri;
            console.log(`[generateVideo] Found direct video URI: ${videoUri}. Attempting download...`);
            try {
                const downloadResponse = await axios_1.default.get(videoUri, { responseType: 'arraybuffer', timeout: config_1.REQUEST_TIMEOUT * 2 });
                // Explicitly cast data to ArrayBuffer before passing to Buffer.from
                videoData = Buffer.from(downloadResponse.data);
                const uriPath = new URL(videoUri).pathname;
                const ext = path.extname(uriPath).toLowerCase().substring(1);
                if (ext)
                    fileExtension = ext;
            }
            catch (downloadError) {
                console.error(`[generateVideo] Failed to download video from direct URI ${videoUri}:`, downloadError);
                throw new Error(`Failed to download video from provided direct URI: ${videoUri}`);
            }
        }
        else {
            console.error('[generateVideo] No video data (inlineData or URI) found in successful response:', JSON.stringify(operationStatus.response));
            throw new Error('Video generation succeeded but no video data could be extracted.');
        }
        // --- 4. Save Locally ---
        const uniqueFilename = (0, fileUtils_1.generateUniqueFilename)('gemini-vid', `.${fileExtension}`);
        const localVideoPath = await (0, fileUtils_1.saveFile)(config_1.DEFAULT_OUTPUT_DIR, 'video', uniqueFilename, videoData);
        console.log(`[generateVideo] Video saved locally to: ${localVideoPath}`);
        // --- 5. Upload to CF ImgBed (if configured) ---
        let cfVideoUrl = null;
        let cfUploadSuccess = false;
        try {
            cfVideoUrl = await (0, cfUtils_1.uploadToCfImgbed)(localVideoPath);
            cfUploadSuccess = !!cfVideoUrl;
        }
        catch (uploadError) {
            console.error(`[generateVideo] Error uploading video to CF ImgBed:`, uploadError);
        }
        // --- 6. Return Result ---
        const result = {
            localPath: localVideoPath,
            cfVideoUrl: cfVideoUrl, // Use specific key for video URL
            cfUploadSuccess: cfUploadSuccess,
            operationName: operationName, // Include operation name for reference
        };
        console.log('[generateVideo] Tool execution successful:', result);
        // Return result as stringified JSON within a TextContent object
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        console.error('[generateVideo] Error during video generation:', error);
        let errorMessage = 'An unknown error occurred during video generation.';
        // Generic error checking
        if (typeof error === 'object' && error !== null) {
            const err = error;
            if (err.response && err.message) {
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            }
            else if (err.message) {
                errorMessage = `Error: ${err.message}`;
            }
            else {
                errorMessage = `Caught non-standard error object: ${JSON.stringify(error)}`;
            }
        }
        else {
            errorMessage = `Caught non-object error: ${String(error)}`;
        }
        // Ensure the error object matches TextContent structure
        return {
            content: [{ type: 'text', text: `Error generating video: ${errorMessage}` }]
        };
    }
}
//# sourceMappingURL=generateVideo.js.map