import { z } from 'zod';
import axios from 'axios'; // Default import
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { GEMINI_API_KEY, GEMINI_API_URL, GEMINI_UNDERSTANDING_MODEL, REQUEST_TIMEOUT, DEFAULT_OUTPUT_DIR } from '../config.js';
import { generateUniqueFilename, deleteFile, downloadFile } from '../utils/fileUtils.js';

// Schema for a single file source (URL or Path)
const fileSourceSchema = z.object({
    url: z.string().url().optional().describe("URL of the file (image, video, audio, pdf, text, code)."),
    path: z.string().optional().describe("Local path to the file (image, video, audio, pdf, text, code)."),
}).refine(data => !!data.url !== !!data.path, {
    message: "Provide either 'url' or 'path' for each file, but not both.",
});

// Define the base object schema first, accepting an array of files
const understandMediaBaseSchema = z.object({
    // Updated description for 'text'
    text: z.string().min(1).describe("Required. The specific question or instruction for the AI model about the content of the provided file(s). E.g., 'Summarize this document', 'Describe this image', 'Transcribe this audio'. This field must contain the textual prompt."),
    // Updated description for 'files'
    files: z.array(fileSourceSchema).min(1).describe("Required. An array containing one or more file objects. Each object *must* specify either a 'url' or a 'path' key pointing to a supported file (image, video, audio, PDF, text, code). Example: [{path: '/path/to/report.pdf'}, {url: 'https://example.com/image.png'}]"),
});

// Refined schema (though base shape is used for registration)
export const understandMediaSchema = understandMediaBaseSchema; // No top-level refine needed now

// Export the base shape specifically for tool registration
export const understandMediaShape = understandMediaBaseSchema.shape;

// Type definition for the validated parameters
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

// Interface to store processed file info
interface ProcessedFileInfo {
    uri: string;
    mimeType: string;
    originalSource: string; // URL or path for logging/errors
}

// Set of supported MIME types based on user feedback
const SUPPORTED_MIME_TYPES = new Set([
    // Video
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
    // Audio
    'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
    // Image
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    // Document/Text/Code
    'application/pdf',
    'application/x-javascript', 'text/javascript',
    'application/x-python', 'text/x-python',
    'text/plain',
    'text/html',
    'text/css',
    'text/markdown', // Note: Gemini docs might use text/md, but text/markdown is more standard
    'text/csv',
    'text/xml', 'application/xml', // Allow both common XML types
    'text/rtf', 'application/rtf' // Allow both common RTF types
]);


/**
 * Uploads a file to the Google File API using the global axios instance.
 */
async function uploadFileToGoogleApi(filePath: string, mimeType: string, displayName: string): Promise<string> {
    console.log(`[uploadFileToGoogleApi] Starting upload for: ${filePath}, MIME: ${mimeType}`);
    const stats = await fs.stat(filePath);
    const numBytes = stats.size;

    if (numBytes === 0) {
        throw new Error(`File is empty and cannot be uploaded: ${filePath}`);
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
        const err = error as any;
        let message = 'Failed to initiate resumable upload.';
        if (err.response && err.message) {
            message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadFileToGoogleApi] Axios error initiating resumable upload:', err.response?.data || err.message);
        } else if (err.message) {
             message += ` Error: ${err.message}`;
            console.error('[uploadFileToGoogleApi] Error initiating resumable upload:', err.message);
        } else {
            console.error('[uploadFileToGoogleApi] Unknown error initiating resumable upload:', error);
        }
        throw new Error(message);
    }

    // 2. Upload File Data
    console.log('[uploadFileToGoogleApi] Uploading file data...');
    try {
        const fileData = await fs.readFile(filePath);
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
        const uploadResponse = await axios.post<FileApiResponse>(uploadUrl, fileData, uploadConfig);

        if (uploadResponse.status !== 200 || !uploadResponse.data?.file?.uri) {
            console.error('[uploadFileToGoogleApi] File upload failed or URI missing:', uploadResponse.data);
            throw new Error(`File upload failed with status ${uploadResponse.status}. Response: ${JSON.stringify(uploadResponse.data)}`);
        }

        const fileUri = uploadResponse.data.file.uri;
        console.log(`[uploadFileToGoogleApi] File uploaded successfully. URI: ${fileUri}`);
        return fileUri;

    } catch (error: unknown) {
         const err = error as any;
         let message = 'Failed to upload file data.';
         if (err.response && err.message) {
             message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadFileToGoogleApi] Axios error uploading file data:', err.response?.data || err.message);
        } else if (err.message) {
             message += ` Error: ${err.message}`;
            console.error('[uploadFileToGoogleApi] Error uploading file data:', err.message);
        } else {
            console.error('[uploadFileToGoogleApi] Unknown error uploading file data:', error);
        }
        throw new Error(message);
    }
}


/**
 * Handles the media understanding tool request for multiple files.
 */
export async function handleUnderstandMedia(
    params: UnderstandMediaParams,
    axiosInstance: any // Use 'any' type like other tools
): Promise<{ content: Array<TextContent> }> {
    const { text, files } = params;
    const tempSubDir = 'tmp'; // Use 'tmp' subfolder consistent with other tools

    const processedFiles: ProcessedFileInfo[] = [];
    const cleanupPaths: string[] = []; // Keep track of files to delete

    try {
        console.log(`[understandMedia] Received request with text: "${text}" and ${files.length} file(s).`);

        // --- 1. Process each file input ---
        for (const fileSource of files) {
            let localFilePath: string | null = null;
            let isTemp = false;
            const originalSource = fileSource.url || fileSource.path || 'unknown'; // For logging

            if (fileSource.url) {
                console.log(`[understandMedia] Downloading media from URL: ${fileSource.url}`);
                try {
                    // Use the consistent 'tmp' subfolder
                    localFilePath = await downloadFile(fileSource.url, DEFAULT_OUTPUT_DIR, tempSubDir, 'downloaded_media');
                    isTemp = true;
                    cleanupPaths.push(localFilePath); // Mark for cleanup
                    console.log(`[understandMedia] Media downloaded to: ${localFilePath}`);
                } catch (downloadError) {
                    console.error(`[understandMedia] Failed to download ${fileSource.url}:`, downloadError);
                    throw new Error(`Failed to download file from URL: ${fileSource.url}. Error: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
                }
            } else if (fileSource.path) {
                try {
                    await fs.access(fileSource.path);
                    localFilePath = path.resolve(fileSource.path);
                    console.log(`[understandMedia] Using local file: ${localFilePath}`);
                } catch (err) {
                    throw new Error(`Local file path not found or inaccessible: ${fileSource.path}`);
                }
            }

            if (!localFilePath) {
                throw new Error(`Internal Error: Invalid file source object processed: ${JSON.stringify(fileSource)}`);
            }

            // --- 2. Determine & Validate MIME Type ---
            const mimeType = mime.lookup(localFilePath);
            if (!mimeType) {
                // Attempt cleanup before throwing
                if (isTemp) await deleteFile(localFilePath).catch(e => console.error(`[understandMedia] Error cleaning up temp file ${localFilePath} after MIME type failure:`, e));
                throw new Error(`Could not determine MIME type for file: ${localFilePath} (Source: ${originalSource})`);
            }
            // --- Use the Set for validation ---
            if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                 // Attempt cleanup before throwing
                 if (isTemp) await deleteFile(localFilePath).catch(e => console.error(`[understandMedia] Error cleaning up temp file ${localFilePath} after MIME type failure:`, e));
                 throw new Error(`Unsupported file type '${mimeType}' for file: ${localFilePath} (Source: ${originalSource}). Supported types include common image, video, audio, PDF, text, and code formats.`);
            }
            console.log(`[understandMedia] Determined MIME type: ${mimeType} for ${localFilePath}`);

            // --- 3. Upload to Google File API ---
            const displayName = path.basename(localFilePath);
            const fileUri = await uploadFileToGoogleApi(localFilePath, mimeType, displayName);

            processedFiles.push({ uri: fileUri, mimeType: mimeType, originalSource: originalSource });

        } // End loop through files

        if (processedFiles.length === 0) {
            throw new Error("No files were successfully processed for upload.");
        }

        // --- 4. Call Gemini Generate Content ---
        const generateContentUrl = `/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

        const requestParts = [
            { text: text },
            ...processedFiles.map(fileInfo => ({
                file_data: { mime_type: fileInfo.mimeType, file_uri: fileInfo.uri }
            }))
        ];

        const requestPayload = {
            contents: [{ parts: requestParts }]
        };

        console.log(`[understandMedia] Calling Gemini (${GEMINI_UNDERSTANDING_MODEL}) with ${processedFiles.length} file(s)... URL: ${axiosInstance.defaults.baseURL}${generateContentUrl}`);
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
        } else if (error instanceof Error) { // Check if it's a standard Error
             errorMessage = error.message;
        } else if (err.message) { // Fallback for other error-like objects
            errorMessage = err.message;
        } else {
             errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        // Ensure cleanup happens even if the main logic fails
        // await Promise.all(cleanupPaths.map(p => deleteFile(p).catch(e => console.error(`[understandMedia] Error during cleanup for ${p}:`, e)))); // Cleanup in catch? Risky if error is during cleanup itself.
        return { content: [{ type: 'text', text: `Error understanding media: ${errorMessage}` }] };
    } finally {
        // --- 6. Cleanup Downloaded Files ---
        if (cleanupPaths.length > 0) {
            console.log(`[understandMedia] Cleaning up ${cleanupPaths.length} downloaded temporary file(s)...`);
            // Use Promise.allSettled for cleanup to ensure all attempts are made even if some fail
            const results = await Promise.allSettled(cleanupPaths.map(tempPath => deleteFile(tempPath)));
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`[understandMedia] Failed to clean up downloaded file ${cleanupPaths[index]}:`, result.reason);
                }
            });
        }
    }
}
