import { z } from 'zod';
import axios from 'axios'; // Default import
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
// TelegramBot import removed as notifications are handled elsewhere
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import {
    GEMINI_API_KEY,
    GEMINI_API_URL,
    GEMINI_UNDERSTANDING_MODEL,
    REQUEST_TIMEOUT,
    DEFAULT_OUTPUT_DIR,
    // Notification config imports removed
} from '../config.js';
import { deleteFile, downloadFile } from '../utils/fileUtils.js';
import { getEffectiveMediaSizeLimit } from '../utils/mediaLimitUtils.js'; // Import the new utility function

// --- Constants ---
// Calculate effective limits using the utility function
const { limitMB: USER_LIMIT_MB, limitBytes: USER_LIMIT_BYTES } = getEffectiveMediaSizeLimit('understandMedia');

// Define the base object schema with flattened file parameters
const understandMediaBaseSchema = z.object({
    text: z.string().min(1).describe("Required. The specific question or instruction for the Google Gemini multimodal model about the content of the provided file. E.g., 'Summarize this document', 'Describe this image', 'Transcribe this audio'."),
    file_url: z.string().url().optional().describe("Optional. URL of the file (image, video, audio, pdf, text, code) OR a YouTube video URL (e.g., https://www.youtube.com/watch?v=...). Provide only one file source."),
    file_path: z.string().optional().describe("Optional. Local path to the file (image, video, audio, pdf, text, code). Provide only one file source."),
    file_api_uri: z.string().url().regex(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-zA-Z0-9]+$/, "file_api_uri must be a valid Google File API URI (e.g., https://generativelanguage.googleapis.com/v1beta/files/xxxxxx)").optional()
        .describe("Optional. Pre-uploaded file URI (the full HTTPS URL returned by the Files API). If provided, 'file_mime_type' is also required. Provide only one file source."),
    file_mime_type: z.string().optional()
        .describe("Required only if 'file_api_uri' is provided. The MIME type of the pre-uploaded file (e.g., 'video/mp4', 'application/pdf')."),
});

// Export the shape from the base schema for tool registration
export const understandMediaShape = understandMediaBaseSchema.shape;

// Apply refinement to the base schema for validation and type inference
export const understandMediaSchema = understandMediaBaseSchema.refine(data => {
    const sources = [data.file_url, data.file_path, data.file_api_uri].filter(Boolean).length;
    if (sources !== 1) return false; // Exactly one source must be provided
    if (data.file_api_uri && !data.file_mime_type) return false; // mime_type is required if file_api_uri is used
    return true;
}, {
    message: "Provide exactly one file source: either 'file_url', 'file_path', or both 'file_api_uri' and 'file_mime_type'.",
});

// Type definition for the validated parameters
type UnderstandMediaParams = z.infer<typeof understandMediaSchema>;

// --- Google File API Response Interfaces ---
interface FileInfo {
    name: string;
    uri: string; // This is the full HTTPS URI returned by the File API
    mimeType: string;
    createTime: string;
    updateTime: string;
    displayName: string;
    sizeBytes: string;
    state?: 'PROCESSING' | 'ACTIVE' | 'FAILED' | 'STATE_UNSPECIFIED'; // Added STATE_UNSPECIFIED
    videoMetadata?: {
        videoDuration: { seconds: string; nanos: number }; // Changed seconds to string based on potential API responses
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
    type: 'inline' | 'file_api' | 'youtube'; // How the file will be sent to Gemini
    originalSource: string; // URL, path, or file_uri for logging/errors
    // For inline
    mimeType?: string; // MIME type is needed for inline
    base64Data?: string;
    // For pre-uploaded file_api
    fileApiMimeType?: string; // Store mimeType specifically for pre-uploaded
    fileApiUri?: string; // Store fullUri specifically for pre-uploaded
    // For youtube
    youtubeUrl?: string; // The original YouTube URL
}

// Regex to identify YouTube video URLs
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

// Set of supported MIME types based on user feedback and Gemini docs (for non-YouTube files)
// Note: Gemini API v1beta has stricter limits than v1 for inline data (Images only currently)
// We will check size first, then decide upload vs inline based on type support if needed.
// For now, assume all SUPPORTED_MIME_TYPES *could* be inline if small enough,
// but the API call might fail later if Gemini doesn't support that type inline.
// The primary goal is to avoid *uploading* small files via the File API.
const SUPPORTED_MIME_TYPES = new Set([
    // Video
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
    // Audio
    'audio/wav', 'audio/mp3', 'audio/mpeg',
    'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
    // Image
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    // Document/Text/Code
    'application/pdf',
    'application/x-javascript', 'text/javascript',
    'application/x-python', 'text/x-python',
    'text/plain',
    'text/html',
    'text/css',
    'text/markdown',
    'text/csv',
    'text/xml', 'application/xml',
    'text/rtf', 'application/rtf',
    // Add common code types explicitly if not covered by text/*
    'application/json',
    'application/javascript', // Redundant with text/javascript but safe to include
    'application/x-typescript', 'text/typescript',
    'text/x-java-source', 'text/java',
    'text/x-c', 'text/x-csrc',
    'text/x-csharp',
    'text/x-php', 'application/x-httpd-php',
    'text/x-ruby',
    'text/x-go',
    'text/rust', 'application/rust',
    'text/swift',
    'text/kotlin',
    'text/scala',
    'text/perl',
    'text/shellscript', 'application/x-sh',
]);

// --- Notification Functions (Removed) ---
// --- File Upload and Polling Functions (Removed) ---



/**
 * Handles the media understanding tool request for multiple files.
 */
export async function handleUnderstandMedia(
    params: UnderstandMediaParams,
    axiosInstance: any
): Promise<{ content: Array<TextContent> }> {
    // Destructure parameters directly
    const { text, file_url, file_path, file_api_uri, file_mime_type } = params;
    const tempSubDir = 'tmp';

    // Use a single object to store processed info, as there's only one file now
    let processedFile: ProcessedFileInfo | null = null;
    const cleanupPaths: string[] = []; // Still needed for downloaded files

    try {
        console.log(`[understandMedia] Received request with text: "${text}". User configured size limit: ${USER_LIMIT_MB} MB.`);

        // --- 1. Process the single file input ---
        const originalSource = file_url || file_path || file_api_uri || 'unknown_source';
        let mimeType: string | undefined = file_mime_type; // Use provided mime type if file_api_uri is used
        let localFilePath: string | null = null;
        let isTemp = false;
        let fileSize = 0;

        console.log(`[understandMedia] Processing file source: ${originalSource}`);

        // --- A. Handle pre-uploaded file_api_uri ---
        if (file_api_uri && mimeType) {
            console.log(`[understandMedia] Using pre-uploaded file URI: ${file_api_uri}`);
            if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                throw new Error(`Unsupported MIME type '${mimeType}' for pre-uploaded file: ${originalSource}.`);
            }
            // Check video type (only one file, so no count needed, just check type)
            if (mimeType.startsWith('video/')) {
                 console.log(`[understandMedia] Processing pre-uploaded video file.`);
            }
            // Store pre-uploaded file info directly
            processedFile = {
                type: 'file_api',
                originalSource: originalSource,
                fileApiMimeType: mimeType,
                fileApiUri: file_api_uri,
            };
            // No size check, upload, or polling needed.
        }
        // --- B. Handle file_url (check for YouTube first) ---
        else if (file_url) {
            const url = file_url;
            console.log(`[understandMedia] Processing URL: ${url}`);

            // Check if it's a YouTube URL
            if (YOUTUBE_URL_REGEX.test(url)) {
                console.log(`[understandMedia] Detected YouTube URL: ${url}. Skipping download and upload.`);
                 // Check video type (only one file, so no count needed, just check type)
                 console.log(`[understandMedia] Processing YouTube video file.`);
                processedFile = {
                    type: 'youtube',
                    originalSource: url,
                    youtubeUrl: url
                };
                // No MIME type, size check, upload, or polling needed for YouTube URLs
            } else {
                // It's a regular URL, try HEAD request first to check size
                console.log(`[understandMedia] Checking size for URL via HEAD request: ${url}`);
                let shouldDownload = true; // Assume download is needed unless HEAD proves otherwise
                try {
                    const headResponse = await axios.head(url, { timeout: REQUEST_TIMEOUT / 2 }); // Shorter timeout for HEAD
                    const contentLengthHeader = headResponse.headers['content-length'];

                    if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
                        const headFileSize = parseInt(contentLengthHeader, 10);
                            console.log(`[understandMedia] HEAD request successful. Content-Length: ${headFileSize} bytes.`);
                            // Use the calculated USER_LIMIT_BYTES for comparison
                            if (headFileSize > USER_LIMIT_BYTES) {
                                // File is too large based on HEAD and user config, prevent download and throw error
                                console.log(`[understandMedia] File size from HEAD (${headFileSize}) exceeds user limit (${USER_LIMIT_BYTES}). Skipping download.`);
                                shouldDownload = false;
                                throw new Error(`File from URL '${originalSource}' is too large (${headFileSize} bytes > ${USER_LIMIT_BYTES} bytes based on Content-Length and user configuration). Please use the 'uploadLargeMedia' tool for files larger than ${USER_LIMIT_MB}MB.`);
                            } else {
                                // Size is OK based on HEAD and user config, proceed to download
                                console.log(`[understandMedia] File size from HEAD is within user limit. Proceeding with download.`);
                            shouldDownload = true;
                        }
                    } else {
                        // HEAD succeeded but no valid Content-Length, proceed to download for size check
                        console.warn(`[understandMedia] HEAD request for ${url} did not return a valid Content-Length header. Proceeding with download to check size.`);
                        shouldDownload = true;
                    }
                } catch (headError: any) {
                     // Check if the error is the specific "too large" error we threw above
                    if (headError instanceof Error && headError.message.includes("is too large")) {
                        // Re-throw the specific error to ensure it propagates correctly
                        throw headError;
                    }
                    // Log other HEAD request errors and proceed to download as fallback
                    console.warn(`[understandMedia] HEAD request failed for ${url} (Error: ${headError.message}). Proceeding with download to check size.`);
                    shouldDownload = true; // Proceed to download if HEAD fails for other reasons
                }

                // --- Download only if necessary ---
                if (!shouldDownload) {
                     // This should technically not be reached if the "too large" error was thrown correctly,
                     // but serves as an extra safeguard.
                     console.error("[understandMedia] Internal logic error: Download should have been skipped but wasn't.");
                     // Ensure the original error is thrown if somehow we get here without it.
                     // Use USER_LIMIT_MB in the error message
                     throw new Error(`File from URL '${originalSource}' was determined to be too large based on Content-Length (>${USER_LIMIT_MB}MB), but download was not skipped.`);
                }

                console.log(`[understandMedia] Downloading media from URL: ${url}`);
                // Use the default timeout for the actual download
                const downloadResult = await downloadFile(url, DEFAULT_OUTPUT_DIR, tempSubDir, `downloaded_media_0`); // Index 0 as there's only one file
                localFilePath = downloadResult.filePath; // Get the path from the result
                const downloadedContentType = downloadResult.contentType; // Get the Content-Type from the result
                isTemp = true;
                cleanupPaths.push(localFilePath); // Mark for cleanup
                console.log(`[understandMedia] Media downloaded to: ${localFilePath}`);

                // Determine MIME type: Prioritize Content-Type, fallback to lookup
                if (downloadedContentType) {
                    mimeType = downloadedContentType;
                    console.log(`[understandMedia] Using MIME type from Content-Type header: ${mimeType}`);
                } else {
                    console.warn(`[understandMedia] Content-Type header missing or invalid. Falling back to MIME lookup by extension.`);
                    const lookupResult = mime.lookup(localFilePath);
                    mimeType = lookupResult === false ? undefined : lookupResult;
                    if (!mimeType) {
                        throw new Error(`Could not determine MIME type for downloaded file (header missing and lookup failed): ${localFilePath}`);
                    }
                    console.log(`[understandMedia] Using MIME type from extension lookup: ${mimeType}`);
                }

                // Correct MP3 MIME type if necessary (even if from Content-Type, sometimes servers send audio/mpeg)
                const fileExt = path.extname(localFilePath).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg') {
                    console.log(`[understandMedia] Correcting MIME type for .mp3 file from 'audio/mpeg' to 'audio/mp3'.`);
                    mimeType = 'audio/mp3';
                }

                // Validate MIME type
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for source URL: ${originalSource}.`);
                }
                console.log(`[understandMedia] Validated MIME type: ${mimeType} for source URL: ${originalSource}`);

                // --- Check Video Count (after determining MIME type) ---
                if (mimeType.startsWith('video/')) {
                     console.log(`[understandMedia] Processing downloaded video file.`);
                     // No need to count > 1 as schema enforces only one file source
                }

                // Get file size *after* download (as fallback or confirmation)
                const stats = await fs.stat(localFilePath);
                fileSize = stats.size;
                if (fileSize === 0) {
                    throw new Error(`Downloaded file is empty: ${localFilePath}`);
                }
                console.log(`[understandMedia] Downloaded file size: ${fileSize} bytes for ${localFilePath}`);

                // --- Check Size Again (important if HEAD failed) ---
                // Use the calculated USER_LIMIT_BYTES for comparison
                if (fileSize > USER_LIMIT_BYTES) {
                     // This case should ideally be caught by HEAD, but handles HEAD failures or inaccurate Content-Length
                    console.warn(`[understandMedia] File size check after download indicates file is too large (${fileSize} > ${USER_LIMIT_BYTES}). This might happen if HEAD request failed or Content-Length was inaccurate.`);
                    // Use USER_LIMIT_MB in the error message
                    throw new Error(`File from URL '${originalSource}' is too large (${fileSize} bytes > ${USER_LIMIT_BYTES} bytes). Please use the 'uploadLargeMedia' tool for files larger than ${USER_LIMIT_MB}MB.`);
                }

                // --- Use Inline Data (since size is confirmed to be within limit) ---
                console.log(`[understandMedia] File size (${fileSize} bytes) is within limit. Using inline data.`);
                const fileData = await fs.readFile(localFilePath);
                const base64Data = fileData.toString('base64');
                processedFile = {
                    type: 'inline',
                    mimeType: mimeType,
                    originalSource: originalSource,
                    base64Data: base64Data
                };
                // File API upload and polling removed
            }
        }
        // --- C. Handle file_path ---
        else if (file_path) {
            await fs.access(file_path); // Check existence
            localFilePath = path.resolve(file_path);
            console.log(`[understandMedia] Using local file: ${localFilePath}`);

            // Get MIME type for local file (no Content-Type available, must use lookup)
            const lookupResult = mime.lookup(localFilePath);
            mimeType = lookupResult === false ? undefined : lookupResult;
            if (!mimeType) {
                throw new Error(`Could not determine MIME type for local file: ${localFilePath}`);
            }
            console.log(`[understandMedia] Using MIME type from extension lookup for local file: ${mimeType}`);
            // Correct MP3 MIME type if necessary
            const fileExt = path.extname(localFilePath).toLowerCase();
            if (fileExt === '.mp3' && mimeType === 'audio/mpeg') {
                console.log(`[understandMedia] Correcting MIME type for .mp3 file from 'audio/mpeg' to 'audio/mp3'.`);
                mimeType = 'audio/mp3';
            }

                // Validate MIME type
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for source path: ${originalSource}.`);
                }
                console.log(`[understandMedia] Validated MIME type: ${mimeType} for source path: ${originalSource}`);

                // --- Check Video Count (after determining MIME type) ---
                 if (mimeType.startsWith('video/')) {
                     console.log(`[understandMedia] Processing local video file.`);
                     // No need to count > 1 as schema enforces only one file source
                }

                // Get file size
            const stats = await fs.stat(localFilePath);
            fileSize = stats.size;
            if (fileSize === 0) {
                throw new Error(`File is empty: ${localFilePath}`);
            }
            console.log(`[understandMedia] File size: ${fileSize} bytes for ${localFilePath}`);

            // --- Check Size ---
            // Use the calculated USER_LIMIT_BYTES for comparison
            if (fileSize > USER_LIMIT_BYTES) {
                 // Use USER_LIMIT_MB in the error message
                throw new Error(`Local file '${originalSource}' is too large (${fileSize} bytes > ${USER_LIMIT_BYTES} bytes). Please use the 'uploadLargeMedia' tool for files larger than ${USER_LIMIT_MB}MB.`);
            }

            // --- Use Inline Data (since size is within limit) ---
            console.log(`[understandMedia] File size (${fileSize} bytes) is within limit. Using inline data.`);
            const fileData = await fs.readFile(localFilePath);
            const base64Data = fileData.toString('base64');
            processedFile = {
                type: 'inline',
                mimeType: mimeType,
                originalSource: originalSource,
                base64Data: base64Data
            };
            // File API upload and polling removed
        }
        // --- D. Handle invalid input (Should be caught by schema refine) ---
        else {
            throw new Error(`Invalid file source provided. Use 'file_url', 'file_path', or 'file_api_uri' + 'file_mime_type'.`);
        }


        // --- Validation after processing ---
        if (!processedFile) {
            // This should not happen if the logic above is correct and schema validation passed
            throw new Error("File processing failed unexpectedly.");
        }


        // --- 2. Polling Step Removed ---

        // --- 3. Call Gemini Generate Content ---
        const generateContentUrl = `${GEMINI_API_URL}/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`; // Use full URL from config

        // Construct the parts array based on the single processed file
        // Define a type for the parts array elements for clarity
        type RequestPart = { text: string } | { inline_data: { mime_type: string; data: string } } | { file_data: { mime_type?: string; file_uri: string } };

        const requestParts: RequestPart[] = [{ text: text }]; // Initialize with text part

        if (processedFile.type === 'inline') {
            if (!processedFile.mimeType || !processedFile.base64Data) {
                throw new Error(`Internal error: Missing mimeType or base64Data for inline file: ${processedFile.originalSource}`);
            }
            requestParts.push({ inline_data: { mime_type: processedFile.mimeType, data: processedFile.base64Data } });
        } else if (processedFile.type === 'file_api') { // This now only applies to pre-uploaded URIs
            if (!processedFile.fileApiMimeType || !processedFile.fileApiUri) {
                throw new Error(`Internal error: Missing fileApiMimeType or fileApiUri for pre-uploaded file: ${processedFile.originalSource}`);
            }
            requestParts.push({ file_data: { mime_type: processedFile.fileApiMimeType, file_uri: processedFile.fileApiUri } });
        } else { // type === 'youtube'
            if (!processedFile.youtubeUrl) {
                throw new Error(`Internal error: Missing youtubeUrl for youtube file: ${processedFile.originalSource}`);
            }
            // For YouTube, use file_uri without mime_type
            requestParts.push({ file_data: { file_uri: processedFile.youtubeUrl } }); // No mime_type needed for YouTube
        }

        const requestPayload = {
            contents: [{
                role: "user",
                parts: requestParts
            }]
        };

        // Log payload carefully - potentially large base64 data
        console.log(`[understandMedia] Calling Gemini (${GEMINI_UNDERSTANDING_MODEL}) with 1 file...`);
        // Avoid logging full base64 data in production if possible
        // console.log('[understandMedia] Final request payload structure:', JSON.stringify(requestPayload, (key, value) => key === 'data' ? '<base64_data_omitted>' : value, 2));


        const response = await axiosInstance.post(generateContentUrl, requestPayload, {
             timeout: REQUEST_TIMEOUT,
             // Increase max content length for potentially large inline data payloads
             maxBodyLength: Infinity,
             maxContentLength: Infinity,
        });

        // --- 4. Process Response ---
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
        } else if (error instanceof Error) {
             errorMessage = error.message;
        } else if (err.message) {
            errorMessage = err.message;
        } else {
             errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        return { content: [{ type: 'text', text: `Error understanding media: ${errorMessage}` }] };
    } finally {
        // --- 5. Cleanup Downloaded Files ---
        if (cleanupPaths.length > 0) {
            console.log(`[understandMedia] Cleaning up ${cleanupPaths.length} downloaded temporary file(s)...`);
            const results = await Promise.allSettled(cleanupPaths.map(tempPath => deleteFile(tempPath).catch(e => {
                 // Catch deletion errors within the map to prevent Promise.allSettled from hiding the original error
                 console.error(`[understandMedia] Error during cleanup of ${tempPath}:`, e);
                 throw e; // Re-throw to mark the settlement as rejected if needed, though logging might be sufficient
            })));
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    // Error already logged in the catch block above
                    // console.error(`[understandMedia] Failed to clean up downloaded file ${cleanupPaths[index]}:`, result.reason);
                } else {
                    console.log(`[understandMedia] Successfully cleaned up ${cleanupPaths[index]}`);
                }
            });
        }
    }
}
