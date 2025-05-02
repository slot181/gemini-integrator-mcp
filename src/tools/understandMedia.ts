import { z } from 'zod';
import axios from 'axios'; // Default import
// Remove AxiosInstance and AxiosRequestConfig type imports
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { GEMINI_API_KEY, GEMINI_API_URL, GEMINI_UNDERSTANDING_MODEL, REQUEST_TIMEOUT, DEFAULT_OUTPUT_DIR } from '../config.js';
// Import all needed utils
import { generateUniqueFilename, deleteFile, downloadFile } from '../utils/fileUtils.js';

// Define the base object schema first
const understandMediaBaseSchema = z.object({
    text: z.string().min(1).describe("The question or instruction for the model regarding the media content."),
    url: z.string().url().optional().describe("URL of the video or audio file to understand."),
    path: z.string().optional().describe("Local path to the video or audio file to understand."),
});

// Define the refined schema for validation logic (used internally if needed, but shape is for registration)
export const understandMediaSchema = understandMediaBaseSchema.refine(data => !!data.url !== !!data.path, { // Ensure exactly one source is provided
    message: "Provide either 'url' or 'path', but not both.",
    path: ["url", "path"], // Indicate which fields this refinement relates to
});

// Export the base shape specifically for tool registration
export const understandMediaShape = understandMediaBaseSchema.shape;


// Type definition for the validated parameters (can infer from the refined schema)
type UnderstandMediaParams = z.infer<typeof understandMediaSchema>;

// --- Google File API Response Interfaces ---
interface FileApiResponse {
    file: {
        name: string;
        uri: string;
        mimeType: string;
        createTime: string;
        updateTime: string;
        displayName: string;
        sizeBytes: string;
    };
}

// --- Gemini Generate Content Response Interface ---
interface GeminiContentResponse {
    candidates?: Array<{
        content: {
            parts: Array<{ text: string }>;
            role: string;
        };
    }>;
    error?: {
        code: number;
        message: string;
        status: string;
    };
}


/**
 * Uploads a file to the Google File API using the global axios instance.
 */
async function uploadFileToGoogleApi(filePath: string, mimeType: string, displayName: string): Promise<string> {
    console.log(`[uploadFileToGoogleApi] Starting upload for: ${filePath}, MIME: ${mimeType}`);
    const stats = await fs.stat(filePath);
    const numBytes = stats.size;

    if (numBytes === 0) {
        throw new Error('File is empty and cannot be uploaded.');
    }

    // Use the full URL for the File API endpoint
    const startUploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`;

    // 1. Start Resumable Upload
    console.log('[uploadFileToGoogleApi] Initiating resumable upload...');
    let uploadUrl = '';
    try {
        const startResponse = await axios.post(startUploadUrl,
            { file: { display_name: displayName } },
            {
                headers: {
                    'X-Goog-Upload-Protocol': 'resumable',
                    'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': numBytes.toString(),
                    'X-Goog-Upload-Header-Content-Type': mimeType,
                    'Content-Type': 'application/json',
                },
                timeout: REQUEST_TIMEOUT,
            }
        );
        uploadUrl = startResponse.headers?.['x-goog-upload-url'] ?? '';
        if (!uploadUrl) {
            console.error('[uploadFileToGoogleApi] Failed to get upload URL from headers:', startResponse.headers);
            throw new Error('Failed to initiate resumable upload: No upload URL received.');
        }
        console.log('[uploadFileToGoogleApi] Got upload URL.');
    } catch (error: unknown) {
        // Revert to less type-safe error checking like other files
        const err = error as any;
        if (err.response && err.message) {
            console.error('[uploadFileToGoogleApi] Axios error initiating resumable upload:', err.response?.data || err.message);
        } else if (err.message) {
            console.error('[uploadFileToGoogleApi] Error initiating resumable upload:', err.message);
        } else {
            console.error('[uploadFileToGoogleApi] Unknown error initiating resumable upload:', error);
        }
        throw new Error(`Failed to initiate resumable upload.`);
    }

    // 2. Upload File Data
    console.log('[uploadFileToGoogleApi] Uploading file data...');
    try {
        const fileData = await fs.readFile(filePath);
        // Remove explicit AxiosRequestConfig type
        const uploadConfig = {
            headers: {
                'Content-Length': numBytes.toString(),
                'X-Goog-Upload-Offset': '0',
                'X-Goog-Upload-Command': 'upload, finalize',
                'Content-Type': mimeType,
            },
             maxBodyLength: Infinity,
             maxContentLength: Infinity,
             timeout: REQUEST_TIMEOUT * 5,
        };
        // Use global axios for the upload URL
        const uploadResponse = await axios.post<FileApiResponse>(uploadUrl, fileData, uploadConfig); // Keep type arg here for global axios


        if (uploadResponse.status !== 200 || !uploadResponse.data?.file?.uri) {
            console.error('[uploadFileToGoogleApi] File upload failed or URI missing:', uploadResponse.data);
            throw new Error(`File upload failed with status ${uploadResponse.status}.`);
        }

        const fileUri = uploadResponse.data.file.uri;
        console.log(`[uploadFileToGoogleApi] File uploaded successfully. URI: ${fileUri}`);
        return fileUri;

    } catch (error: unknown) {
         // Revert to less type-safe error checking
         const err = error as any;
         if (err.response && err.message) {
            console.error('[uploadFileToGoogleApi] Axios error uploading file data:', err.response?.data || err.message);
        } else if (err.message) {
            console.error('[uploadFileToGoogleApi] Error uploading file data:', err.message);
        } else {
            console.error('[uploadFileToGoogleApi] Unknown error uploading file data:', error);
        }
        throw new Error(`Failed to upload file data.`);
    }
}


/**
 * Handles the media understanding tool request.
 * Note: The input 'params' type might technically be inferred from the base shape used in registration,
 * but the refined schema logic is handled by the MCP SDK before this handler is called.
 */
export async function handleUnderstandMedia(
    params: UnderstandMediaParams, // Keep using the refined type here for clarity within the handler
    axiosInstance: any // Use 'any' type like other tools
): Promise<{ content: Array<TextContent> }> {
    // The refine logic (url XOR path) is enforced by the SDK before this handler runs
    const { text, url, path: localPathInput } = params;
    const mediaOutputDir = path.join(DEFAULT_OUTPUT_DIR, 'media_understanding_tmp'); // Specific subfolder for downloads

    let localFilePath: string | null = null;
    let cleanupNeeded = false; // Flag to delete downloaded file

    try {
        console.log(`[understandMedia] Received request with text: "${text}"`);

        // --- 1. Get Local File Path ---
        if (url) {
            console.log(`[understandMedia] Downloading media from URL: ${url}`);
            localFilePath = await downloadFile(url, DEFAULT_OUTPUT_DIR, 'media_understanding_tmp', 'downloaded_media');
            cleanupNeeded = true;
            console.log(`[understandMedia] Media downloaded to: ${localFilePath}`);
        } else if (localPathInput) {
            try {
                await fs.access(localPathInput);
                localFilePath = path.resolve(localPathInput);
                console.log(`[understandMedia] Using local file: ${localFilePath}`);
            } catch (err) {
                // This error might be redundant if SDK validation catches it first, but good defense
                throw new Error(`Local file path not found or inaccessible: ${localPathInput}`);
            }
        }

        // This check might also be redundant due to SDK validation based on the refined schema
        if (!localFilePath) {
            throw new Error("Internal Error: No valid media source (URL or Path) was processed.");
        }

        // --- 2. Determine MIME Type ---
        const mimeType = mime.lookup(localFilePath);
        if (!mimeType) {
            if (cleanupNeeded) await deleteFile(localFilePath).catch(e => console.error(`[understandMedia] Error cleaning up temp file ${localFilePath} after MIME type failure:`, e));
            throw new Error(`Could not determine MIME type for file: ${localFilePath}`);
        }
        console.log(`[understandMedia] Determined MIME type: ${mimeType}`);

        // --- 3. Upload to Google File API ---
        const displayName = path.basename(localFilePath);
        const fileUri = await uploadFileToGoogleApi(localFilePath, mimeType, displayName);

        // --- 4. Call Gemini Generate Content using the passed axiosInstance ---
        const generateContentUrl = `/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const requestPayload = {
            contents: [{
                parts: [
                    { text: text },
                    { file_data: { mime_type: mimeType, file_uri: fileUri } }
                ]
            }]
        };

        console.log(`[understandMedia] Calling Gemini (${GEMINI_UNDERSTANDING_MODEL}) to generate content... URL: ${axiosInstance.defaults.baseURL}${generateContentUrl}`);
        const response = await axiosInstance.post(generateContentUrl, requestPayload, { timeout: REQUEST_TIMEOUT });


        // --- 5. Process Response ---
        const responseData = response.data as GeminiContentResponse;

        if (responseData.error) {
             console.error(`[understandMedia] Gemini API returned an error:`, responseData.error);
             throw new Error(`Gemini API error: ${responseData.error.message} (Status: ${responseData.error.status})`);
        }

        const generatedText = responseData.candidates?.[0]?.content?.parts?.map((part: { text: string }) => part.text).join('\n') || '';


        if (!generatedText && !responseData.candidates) {
             console.error('[understandMedia] Gemini response is missing candidates or text parts:', responseData);
             throw new Error('Invalid response structure from Gemini API.');
        } else if (!generatedText) {
             console.warn('[understandMedia] Gemini response did not contain text parts, but candidates exist.', responseData);
             return { content: [{ type: 'text', text: '(Model returned empty text content)' }] };
        }


        console.log('[understandMedia] Tool execution successful.');
        return { content: [{ type: 'text', text: generatedText }] };

    } catch (error: unknown) {
        console.error('[understandMedia] Error during media understanding:', error);
        let errorMessage = 'An unknown error occurred during media understanding.';
        const err = error as any;
        if (err.response && err.message) {
             const responseInfo = err.response ? ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}` : 'No response data.';
             errorMessage = `API request failed: ${err.message}.${responseInfo}`;
        } else if (err.message) {
            errorMessage = err.message;
        } else {
             errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        return { content: [{ type: 'text', text: `Error understanding media: ${errorMessage}` }] };
    } finally {
        // --- 6. Cleanup Downloaded File ---
        if (cleanupNeeded && localFilePath) {
            await deleteFile(localFilePath).catch(e => console.error(`[understandMedia] Failed to clean up downloaded file ${localFilePath}:`, e));
        }
    }
}
