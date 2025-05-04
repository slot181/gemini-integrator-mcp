import { z } from 'zod';
import axios from 'axios'; // Keep default import
import * as path from 'path';
import * as fs from 'fs/promises';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js'; // Use TextContent

// Import shared utilities and config
import { saveFile, generateUniqueFilename } from '../utils/fileUtils.js'; // Add .js extension
import { uploadToCfImgbed } from '../utils/cfUtils.js'; // Add .js extension
import { GEMINI_API_KEY, DEFAULT_OUTPUT_DIR, GEMINI_API_URL, REQUEST_TIMEOUT } from '../config.js'; // Add .js extension

// Define the input schema for the generateVideo tool using Zod
export const generateVideoSchema = z.object({
    prompt: z.string().min(1).describe("Required. Descriptive text prompt for the Google Gemini video generation service (Veo). (English is recommended for best results)."),
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9").describe("Optional. Aspect ratio for the generated video. Defaults to 16:9."),
    personGeneration: z.enum(["dont_allow", "allow_adult"]).optional().default("dont_allow").describe("Optional. Control generation of people ('dont_allow', 'allow_adult'). Defaults to dont_allow."),
});

// Type definition for the validated parameters
type GenerateVideoParams = z.infer<typeof generateVideoSchema>;

// --- Gemini API Response Interfaces (Simplified) ---
// Response from polling the operation status URL
interface GeminiVideoOperationStatusResponse {
    name: string;
    done: boolean;
    error?: { // Structure might vary
        code: number;
        message: string;
        details?: any[];
    };
    response?: { // Updated structure based on provided JSON
        "@type"?: string; // e.g., "type.googleapis.com/google.ai.generativelanguage.v1beta.PredictLongRunningResponse"
        generateVideoResponse?: {
            generatedSamples?: Array<{
                video?: {
                    uri?: string; // The direct download URI
                };
            }>;
        };
        // Keep candidates structure in case other models use it, but make optional
        candidates?: Array<{
            content: {
                parts: Array<{
                    text?: string;
                    uri?: string;
                    inlineData?: {
                        mimeType: string;
                        data: string;
                    };
                }>;
            };
        }>;
        videoUri?: string; // Keep this optional field too
    };
}

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Polling configuration
const POLLING_INTERVAL_MS = 5000; // Check every 5 seconds
const MAX_POLLING_ATTEMPTS = 60; // Max attempts (e.g., 60 * 5s = 5 minutes timeout)


/**
 * Handles the video generation tool request.
 * Initiates async generation, polls for completion, saves the video locally,
 * uploads to CF ImgBed if configured, and returns the results.
 */
export async function handleGenerateVideo(
    params: GenerateVideoParams,
    axiosInstance: any // Use 'any' to bypass Axios type issues
): Promise<{ content: Array<TextContent> }> { // Update return signature
    // Destructure remaining params
    const { prompt, aspectRatio, personGeneration } = params;
    // const videoOutputDir = path.join(DEFAULT_OUTPUT_DIR, 'video'); // Removed unused variable

    try {
        console.log(`[generateVideo] Received request with prompt: "${prompt}"`);

        // --- 1. Initiate Async Video Generation ---
        // Adjust model name based on Gemini docs (e.g., 'veo-2.0-generate-001')
        const startApiUrl = `/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=${GEMINI_API_KEY}`;
        // Construct the payload according to the Gemini API specification (nesting required)
        const startRequestPayload: any = {
            instances: [{
                prompt: prompt,
            }],
            parameters: {
                aspectRatio: aspectRatio,
                personGeneration: personGeneration,
                // Removed other parameters
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
        let operationStatus: GeminiVideoOperationStatusResponse | null = null;
        const operationStatusUrl = `${GEMINI_API_URL}/v1beta/${operationName}?key=${GEMINI_API_KEY}`; // Construct polling URL

        while (attempts < MAX_POLLING_ATTEMPTS) {
            attempts++;
            console.log(`[generateVideo] Polling status for ${operationName} (Attempt ${attempts}/${MAX_POLLING_ATTEMPTS})... URL: ${operationStatusUrl}`);

            try {
                // Use a direct axios call for polling as it might have different base URL/auth needs if operation URL is absolute
                 const pollResponse = await axios.get<GeminiVideoOperationStatusResponse>(operationStatusUrl, { timeout: REQUEST_TIMEOUT }); // Use configured timeout
                 operationStatus = pollResponse.data;

                if (operationStatus?.done) {
                    console.log(`[generateVideo] Operation ${operationName} completed.`);
                    break; // Exit polling loop
                }

            } catch (pollError: unknown) {
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

        // --- Extract Video Data (Updated based on provided JSON structure) ---
        const generatedSamples = operationStatus.response?.generateVideoResponse?.generatedSamples;

        if (!generatedSamples || generatedSamples.length === 0) {
            console.error('[generateVideo] No generatedSamples found in successful response:', JSON.stringify(operationStatus.response));
            throw new Error('Video generation succeeded but no generatedSamples array found.');
        }

        // Get the URI from the first sample
        const videoUri = generatedSamples[0]?.video?.uri;

        if (!videoUri) {
            console.error('[generateVideo] No video URI found in the first generated sample:', JSON.stringify(generatedSamples[0]));
            throw new Error('Video generation succeeded but no video URI found in the response.');
        }

        console.log(`[generateVideo] Found video download URI: ${videoUri}. Attempting download...`);

        let videoData: Buffer;
        let fileExtension = 'mp4'; // Default

        try {
            // Download the video using the URI
            // Note: This URI likely includes the API key or temporary credentials, handle potential expiry/auth issues if needed.
            const downloadResponse = await axios.get(videoUri, {
                responseType: 'arraybuffer',
                timeout: REQUEST_TIMEOUT * 5 // Increased timeout for potentially large video downloads
            });
            // Explicitly cast data to ArrayBuffer before passing to Buffer.from
            videoData = Buffer.from(downloadResponse.data as ArrayBuffer);

            // Try to determine extension from Content-Type header or URI path
            const contentType = downloadResponse.headers['content-type'];
            if (contentType && contentType.startsWith('video/')) {
                fileExtension = contentType.split('/')[1] || 'mp4';
            } else {
                // Fallback to URI path if Content-Type is not helpful
                try {
                    const uriPath = new URL(videoUri).pathname;
                    const ext = path.extname(uriPath).toLowerCase().substring(1);
                    if (ext) fileExtension = ext;
                } catch (urlParseError) {
                    console.warn(`[generateVideo] Could not parse video URI path to determine extension: ${urlParseError}`);
                }
            }
            console.log(`[generateVideo] Determined file extension: ${fileExtension}`);

        } catch (downloadError) {
            console.error(`[generateVideo] Failed to download video from URI ${videoUri}:`, downloadError);
            throw new Error(`Failed to download generated video from URI: ${videoUri}`);
        }

        // --- 4. Save Locally ---
        const uniqueFilename = generateUniqueFilename('gemini-vid', `.${fileExtension}`);
        const localVideoPath = await saveFile(DEFAULT_OUTPUT_DIR, 'video', uniqueFilename, videoData);
        console.log(`[generateVideo] Video saved locally to: ${localVideoPath}`);

        // --- 5. Upload to CF ImgBed (if configured) ---
        let cfVideoUrl: string | null = null;
        let cfUploadSuccess = false;
        try {
            cfVideoUrl = await uploadToCfImgbed(localVideoPath);
            cfUploadSuccess = !!cfVideoUrl;
        } catch (uploadError) {
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

    } catch (error: unknown) {
        console.error('[generateVideo] Error during video generation:', error);
        let errorMessage = 'An unknown error occurred during video generation.';

        // Generic error checking
        if (typeof error === 'object' && error !== null) {
            const err = error as any;
            if (err.response && err.message) {
                const responseInfo = ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}`;
                errorMessage = `Likely Axios error: ${err.message}.${responseInfo}`;
            } else if (err.message) {
                errorMessage = `Error: ${err.message}`;
            } else {
                 errorMessage = `Caught non-standard error object: ${JSON.stringify(error)}`;
            }
        } else {
             errorMessage = `Caught non-object error: ${String(error)}`;
        }
        // Ensure the error object matches TextContent structure
        return {
            content: [{ type: 'text', text: `Error generating video: ${errorMessage}` }]
        };
    }
}
