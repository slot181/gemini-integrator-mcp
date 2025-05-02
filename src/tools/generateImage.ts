import { z } from 'zod';
import axios from 'axios'; // Keep default import
// Remove AxiosInstance and AxiosError type imports
import * as path from 'path';
import * as fs from 'fs/promises'; // Needed for Buffer operations
import type { TextContent } from '@modelcontextprotocol/sdk/types.js'; // Use TextContent, remove JsonContentPart

// Import shared utilities and config
import { saveFile, generateUniqueFilename } from '../utils/fileUtils';
import { uploadToCfImgbed } from '../utils/cfUtils';
import { GEMINI_API_KEY, DEFAULT_OUTPUT_DIR } from '../config';

// Define the input schema for the generateImage tool using Zod
export const generateImageSchema = z.object({
    prompt: z.string().min(1, "Prompt cannot be empty"),
    // Add other potential Gemini parameters as needed (optional)
    // e.g., negative_prompt: z.string().optional(),
    // e.g., style_raw: z.string().optional(),
    // e.g., aspect_ratio: z.enum(["16:9", "1:1", "9:16"]).optional(),
});

// Type definition for the validated parameters
type GenerateImageParams = z.infer<typeof generateImageSchema>;

// Define the type for a single part in the Gemini response
interface GeminiContentPart {
    text?: string;
    inlineData?: {
        mimeType: string;
        data: string; // Base64 encoded image data
    };
}

// Define the expected structure of the Gemini API response (simplified)
// Adjust based on the actual Gemini API response structure for image generation
interface GeminiImageGenerationResponse {
    candidates?: Array<{
        content: {
            parts: Array<GeminiContentPart>; // Use the defined type here
        };
    }>;
    // Include other potential fields like 'error' if applicable
}


/**
 * Handles the image generation tool request.
 * Calls the Gemini API, saves the image locally, uploads to CF ImgBed if configured,
 * and returns the results.
 */
export async function handleGenerateImage(
    params: GenerateImageParams,
    axiosInstance: any // Use 'any' for now to bypass the type issue
    // Update return signature to only use TextContent
): Promise<{ content: Array<TextContent> }> {
    const { prompt } = params;
    const imageOutputDir = path.join(DEFAULT_OUTPUT_DIR, 'image'); // Specific subfolder for generated images

    try {
        console.log(`[generateImage] Received request with prompt: "${prompt}"`);

        // Construct the API URL with the API key
        // Adjust the model name as needed (e.g., 'gemini-pro-vision', 'gemini-1.5-flash', etc.)
        // The example uses 'gemini-2.0-flash-exp-image-generation'
        const apiUrl = `/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${GEMINI_API_KEY}`;

        // Construct the request payload based on Gemini API docs
        const requestPayload = {
            contents: [{
                parts: [
                    { text: prompt }
                ]
            }],
            // Specify that we want an IMAGE response modality
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] } // Or ["TEXT", "IMAGE"] if you expect text too
        };

        console.log(`[generateImage] Calling Gemini API at: ${axiosInstance.defaults.baseURL}${apiUrl}`);
        // Remove the type argument <GeminiImageGenerationResponse> since axiosInstance is 'any'
        const response = await axiosInstance.post(apiUrl, requestPayload);

        // --- Process Gemini Response ---
        // We'll need to be careful accessing response.data as it's now 'any'
        const parts = response.data?.candidates?.[0]?.content?.parts;
        // Add explicit type for 'part' in the find callback
        const imagePart = parts?.find((part: GeminiContentPart) => part.inlineData && part.inlineData.mimeType.startsWith('image/'));

        if (!imagePart || !imagePart.inlineData) {
            console.error('[generateImage] No image data found in Gemini response:', JSON.stringify(response.data));
            throw new Error('Gemini API did not return image data.');
        }

        const base64Data = imagePart.inlineData.data;
        const mimeType = imagePart.inlineData.mimeType;
        const fileExtension = mimeType.split('/')[1] || 'png'; // Default to png if split fails
        const imageData = Buffer.from(base64Data, 'base64');

        // --- Save Locally ---
        const uniqueFilename = generateUniqueFilename('gemini-gen', `.${fileExtension}`);
        const localImagePath = await saveFile(DEFAULT_OUTPUT_DIR, 'image', uniqueFilename, imageData);
        console.log(`[generateImage] Image saved locally to: ${localImagePath}`);

        // --- Upload to CF ImgBed (if configured) ---
        let cfImageUrl: string | null = null;
        let cfUploadSuccess = false;
        try {
            cfImageUrl = await uploadToCfImgbed(localImagePath);
            cfUploadSuccess = !!cfImageUrl;
        } catch (uploadError) {
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

    } catch (error: unknown) {
        console.error('[generateImage] Error during image generation:', error);
        let errorMessage = 'An unknown error occurred during image generation.';

        // Use the generic error checking method
        if (typeof error === 'object' && error !== null) {
            const err = error as any; // Use 'any' for property checking
            if (err.response && err.message) { // Check for Axios-like properties
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            } else if (err.message) { // Generic Error object
                errorMessage = `Error: ${err.message}`;
            } else {
                 errorMessage = `Caught non-standard error object: ${JSON.stringify(error)}`;
            }
        } else {
             errorMessage = `Caught non-object error: ${String(error)}`;
        }

        // Ensure the error object matches TextContent structure
        return {
            content: [{ type: 'text', text: `Error generating image: ${errorMessage}` }]
        };
    }
}
