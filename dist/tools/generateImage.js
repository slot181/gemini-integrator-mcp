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
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateImageSchema = void 0;
exports.handleGenerateImage = handleGenerateImage;
const zod_1 = require("zod");
// Remove AxiosInstance and AxiosError type imports
const path = __importStar(require("path"));
// Import shared utilities and config
const fileUtils_1 = require("../utils/fileUtils");
const cfUtils_1 = require("../utils/cfUtils");
const config_1 = require("../config");
// Define the input schema for the generateImage tool using Zod
exports.generateImageSchema = zod_1.z.object({
    prompt: zod_1.z.string().min(1, "Prompt cannot be empty"),
    // Add other potential Gemini parameters as needed (optional)
    // e.g., negative_prompt: z.string().optional(),
    // e.g., style_raw: z.string().optional(),
    // e.g., aspect_ratio: z.enum(["16:9", "1:1", "9:16"]).optional(),
});
/**
 * Handles the image generation tool request.
 * Calls the Gemini API, saves the image locally, uploads to CF ImgBed if configured,
 * and returns the results.
 */
async function handleGenerateImage(params, axiosInstance // Use 'any' for now to bypass the type issue
// Update return signature to only use TextContent
) {
    const { prompt } = params;
    const imageOutputDir = path.join(config_1.DEFAULT_OUTPUT_DIR, 'image'); // Specific subfolder for generated images
    try {
        console.log(`[generateImage] Received request with prompt: "${prompt}"`);
        // Construct the API URL with the API key
        // Adjust the model name as needed (e.g., 'gemini-pro-vision', 'gemini-1.5-flash', etc.)
        // The example uses 'gemini-2.0-flash-exp-image-generation'
        const apiUrl = `/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${config_1.GEMINI_API_KEY}`;
        // Construct the request payload based on Gemini API docs
        const requestPayload = {
            contents: [{
                    parts: [
                        { text: prompt }
                    ]
                }],
            // Specify that we want an IMAGE response modality
            generationConfig: { responseModalities: ["IMAGE"] } // Or ["TEXT", "IMAGE"] if you expect text too
        };
        console.log(`[generateImage] Calling Gemini API at: ${axiosInstance.defaults.baseURL}${apiUrl}`);
        // Remove the type argument <GeminiImageGenerationResponse> since axiosInstance is 'any'
        const response = await axiosInstance.post(apiUrl, requestPayload);
        // --- Process Gemini Response ---
        // We'll need to be careful accessing response.data as it's now 'any'
        const parts = response.data?.candidates?.[0]?.content?.parts;
        // Add explicit type for 'part' in the find callback
        const imagePart = parts?.find((part) => part.inlineData && part.inlineData.mimeType.startsWith('image/'));
        if (!imagePart || !imagePart.inlineData) {
            console.error('[generateImage] No image data found in Gemini response:', JSON.stringify(response.data));
            throw new Error('Gemini API did not return image data.');
        }
        const base64Data = imagePart.inlineData.data;
        const mimeType = imagePart.inlineData.mimeType;
        const fileExtension = mimeType.split('/')[1] || 'png'; // Default to png if split fails
        const imageData = Buffer.from(base64Data, 'base64');
        // --- Save Locally ---
        const uniqueFilename = (0, fileUtils_1.generateUniqueFilename)('gemini-gen', `.${fileExtension}`);
        const localImagePath = await (0, fileUtils_1.saveFile)(config_1.DEFAULT_OUTPUT_DIR, 'image', uniqueFilename, imageData);
        console.log(`[generateImage] Image saved locally to: ${localImagePath}`);
        // --- Upload to CF ImgBed (if configured) ---
        let cfImageUrl = null;
        let cfUploadSuccess = false;
        try {
            cfImageUrl = await (0, cfUtils_1.uploadToCfImgbed)(localImagePath);
            cfUploadSuccess = !!cfImageUrl;
        }
        catch (uploadError) {
            console.error(`[generateImage] Error uploading to CF ImgBed:`, uploadError);
            // Continue even if upload fails, but report it
        }
        // --- Return Result ---
        const result = {
            localPath: localImagePath,
            cfImageUrl: cfImageUrl,
            cfUploadSuccess: cfUploadSuccess,
        };
        console.log('[generateImage] Tool execution successful:', result);
        // Return result as stringified JSON within a TextContent object
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    }
    catch (error) {
        console.error('[generateImage] Error during image generation:', error);
        let errorMessage = 'An unknown error occurred during image generation.';
        // Use the generic error checking method
        if (typeof error === 'object' && error !== null) {
            const err = error; // Use 'any' for property checking
            if (err.response && err.message) { // Check for Axios-like properties
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            }
            else if (err.message) { // Generic Error object
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
            content: [{ type: 'text', text: `Error generating image: ${errorMessage}` }]
        };
    }
}
//# sourceMappingURL=generateImage.js.map