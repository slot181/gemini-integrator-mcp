import { z } from 'zod';
// Remove AxiosInstance and AxiosError type imports
import * as path from 'path';
// Import shared utilities and config
import { saveFile, generateUniqueFilename } from '../utils/fileUtils.js'; // Add .js extension
import { uploadToCfImgbed } from '../utils/cfUtils.js'; // Add .js extension
// Import the new model config and API key
import { GEMINI_API_KEY, DEFAULT_OUTPUT_DIR, GEMINI_IMAGE_GEN_MODEL } from '../config.js';
// Define the input schema for the generateImage tool using Zod
export const generateImageSchema = z.object({
    prompt: z.string().min(1, "Descriptive text prompt for image generation."),
    // Add aspectRatio as it's used by imagen-3.0
    aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).optional().default("1:1").describe("Aspect ratio for the generated image (ignored by gemini-2.0 model)."),
});
/**
 * Handles the image generation tool request.
 * Calls the Gemini API, saves the image locally, uploads to CF ImgBed if configured,
 * and returns the results.
 */
export async function handleGenerateImage(params, axiosInstance // Use 'any' for now to bypass the type issue
// Update return signature to only use TextContent
) {
    // Destructure aspectRatio from params as well
    const { prompt, aspectRatio } = params;
    const imageOutputDir = path.join(DEFAULT_OUTPUT_DIR, 'image'); // Specific subfolder for generated images
    const selectedModel = GEMINI_IMAGE_GEN_MODEL; // Get the configured model
    let apiUrl = '';
    let requestPayload = {};
    let response; // To store the API response
    try {
        console.log(`[generateImage] Received request with prompt: "${prompt}", aspectRatio: ${aspectRatio}, using model: ${selectedModel}`);
        // --- Construct API URL and Payload based on Model ---
        if (selectedModel === 'imagen-3.0-generate-002') {
            apiUrl = `/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_API_KEY}`;
            requestPayload = {
                instances: [{ prompt: prompt }],
                parameters: {
                    sampleCount: 1, // Hardcoded as requested (corresponds to numberOfImages: 1)
                    aspectRatio: aspectRatio,
                    personGeneration: "ALLOW_ADULT" // Hardcoded as requested
                }
            };
            console.log(`[generateImage] Calling Imagen 3 API at: ${axiosInstance.defaults.baseURL}${apiUrl}`);
            response = await axiosInstance.post(apiUrl, requestPayload);
        }
        else { // Default to gemini-2.0-flash or other similar models
            // Use the selectedModel in the URL
            apiUrl = `/v1beta/models/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;
            requestPayload = {
                contents: [{
                        parts: [{ text: prompt }]
                    }],
                // Specify that we want an IMAGE response modality
                generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
            };
            console.log(`[generateImage] Calling Gemini API at: ${axiosInstance.defaults.baseURL}${apiUrl}`);
            response = await axiosInstance.post(apiUrl, requestPayload);
        }
        // --- Process Gemini/Imagen Response ---
        let imagePart = null;
        if (selectedModel === 'imagen-3.0-generate-002') {
            // Adjust response parsing for Imagen 3's 'predict' endpoint structure
            // This structure needs verification based on actual API response
            // Assuming it might be in response.data.predictions[0].bytesBase64Encoded or similar
            const prediction = response.data?.predictions?.[0];
            if (prediction?.bytesBase64Encoded && prediction?.mimeType?.startsWith('image/')) {
                imagePart = {
                    inlineData: {
                        mimeType: prediction.mimeType,
                        data: prediction.bytesBase64Encoded
                    }
                };
                console.log('[generateImage] Extracted image data from Imagen 3 prediction.');
            }
            else {
                console.error('[generateImage] Unexpected response structure from Imagen 3:', JSON.stringify(response.data));
            }
        }
        else {
            // Original parsing for generateContent endpoint
            const parts = response.data?.candidates?.[0]?.content?.parts;
            imagePart = parts?.find((part) => part.inlineData && part.inlineData.mimeType.startsWith('image/'));
            if (imagePart) {
                console.log('[generateImage] Extracted image data from Gemini candidate.');
            }
        }
        if (!imagePart || !imagePart.inlineData) {
            console.error('[generateImage] No image data found in API response:', JSON.stringify(response.data));
            throw new Error('API did not return valid image data.');
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
        let cfImageUrl = null;
        let cfUploadSuccess = false;
        try {
            cfImageUrl = await uploadToCfImgbed(localImagePath);
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