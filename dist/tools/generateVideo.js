import { z } from 'zod';
import axios from 'axios'; // Keep default import
import * as path from 'path';
// Import shared utilities and config
import { saveFile, generateUniqueFilename } from '../utils/fileUtils.js'; // Add .js extension
import { uploadToCfImgbed } from '../utils/cfUtils.js'; // Add .js extension
import { GEMINI_API_KEY, DEFAULT_OUTPUT_DIR, GEMINI_API_URL, REQUEST_TIMEOUT } from '../config.js'; // Add .js extension
// Define the input schema for the generateVideo tool using Zod
export const generateVideoSchema = z.object({
    prompt: z.string().min(1, "Descriptive text prompt detailing the desired video content."),
    negativePrompt: z.string().optional().describe("Text prompt describing content to avoid in the video."),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9").describe("Aspect ratio for the generated video."),
    personGeneration: z.enum(["dont_allow", "allow_adult"]).optional().default("dont_allow").describe("Control generation of people ('dont_allow', 'allow_adult')."),
    numberOfVideos: z.number().int().min(1).max(2).optional().default(1).describe("Number of videos to generate (1 or 2)."),
    durationSeconds: z.number().int().min(5).max(8).optional().default(5).describe("Duration of each video in seconds (5-8)."),
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
export async function handleGenerateVideo(params, axiosInstance // Use 'any' to bypass Axios type issues
) {
    const { prompt, aspectRatio, personGeneration, negativePrompt, numberOfVideos, durationSeconds } = params; // Include new params
    const videoOutputDir = path.join(DEFAULT_OUTPUT_DIR, 'video'); // Specific subfolder
    try {
        console.log(`[generateVideo] Received request with prompt: "${prompt}"`);
        // --- 1. Initiate Async Video Generation ---
        // Adjust model name based on Gemini docs (e.g., 'veo-2.0-generate-001')
        const startApiUrl = `/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${GEMINI_API_KEY}`;
        // Correct the payload structure based on the error message (remove 'instances' and 'parameters' nesting)
        const startRequestPayload = {
            prompt: prompt,
            aspectRatio: aspectRatio,
            personGeneration: personGeneration,
            numberOfVideos: numberOfVideos,
            durationSeconds: durationSeconds,
        };
        // Conditionally add negativePrompt if provided
        if (negativePrompt) {
            startRequestPayload.negativePrompt = negativePrompt;
        }
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
        const operationStatusUrl = `${GEMINI_API_URL}/v1beta/${operationName}?key=${GEMINI_API_KEY}`; // Construct polling URL
        while (attempts < MAX_POLLING_ATTEMPTS) {
            attempts++;
            console.log(`[generateVideo] Polling status for ${operationName} (Attempt ${attempts}/${MAX_POLLING_ATTEMPTS})... URL: ${operationStatusUrl}`);
            try {
                // Use a direct axios call for polling as it might have different base URL/auth needs if operation URL is absolute
                const pollResponse = await axios.get(operationStatusUrl, { timeout: REQUEST_TIMEOUT }); // Use configured timeout
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
                const downloadResponse = await axios.get(videoUri, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT * 2 }); // Longer timeout for download
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
                const downloadResponse = await axios.get(videoUri, { responseType: 'arraybuffer', timeout: REQUEST_TIMEOUT * 2 });
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
        const uniqueFilename = generateUniqueFilename('gemini-vid', `.${fileExtension}`);
        const localVideoPath = await saveFile(DEFAULT_OUTPUT_DIR, 'video', uniqueFilename, videoData);
        console.log(`[generateVideo] Video saved locally to: ${localVideoPath}`);
        // --- 5. Upload to CF ImgBed (if configured) ---
        let cfVideoUrl = null;
        let cfUploadSuccess = false;
        try {
            cfVideoUrl = await uploadToCfImgbed(localVideoPath);
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