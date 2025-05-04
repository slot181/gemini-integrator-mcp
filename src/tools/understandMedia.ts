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

// --- Constants ---
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB limit for this tool

// Schema for a single file source (URL or Path)
const fileSourceSchema = z.object({
    url: z.string().url().optional().describe("URL of the file (image, video, audio, pdf, text, code) OR a YouTube video URL (e.g., https://www.youtube.com/watch?v=...)."),
    path: z.string().optional().describe("Local path to the file (image, video, audio, pdf, text, code)."),
    // Added file_uri as an alternative input
    file_uri: z.string().url().regex(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-zA-Z0-9]+$/, "file_uri must be a valid Google File API URI (e.g., https://generativelanguage.googleapis.com/v1beta/files/xxxxxx)").optional()
        .describe("Optional. Pre-uploaded file URI (the full HTTPS URL returned as 'uri' by the Files API, e.g., 'https://generativelanguage.googleapis.com/v1beta/files/xxxxxx'). If provided, 'url' and 'path' for this file object will be ignored."),
    // Added mime_type, required only if file_uri is provided
    mime_type: z.string().optional()
        .describe("Required only if 'file_uri' (the full URI) is provided. The MIME type of the pre-uploaded file (e.g., 'video/mp4', 'application/pdf')."),
}).refine(data => {
    const sources = [data.url, data.path, data.file_uri].filter(Boolean).length;
    if (sources !== 1) return false; // Exactly one source must be provided
    if (data.file_uri && !data.mime_type) return false; // mime_type is required if file_uri is used
    return true;
}, {
    message: "For each file, provide exactly one of 'url', 'path', or 'file_uri'. If 'file_uri' is provided, 'mime_type' is also required.",
});


// Define the base object schema first, accepting an array of files
const understandMediaBaseSchema = z.object({
    text: z.string().min(1).describe("Required. The specific question or instruction for the Google Gemini multimodal model about the content of the provided file(s). E.g., 'Summarize this document', 'Describe this image', 'Transcribe this audio'. This field must contain the textual prompt."),
    // Updated description for 'files'
    files: z.array(fileSourceSchema).min(1).describe("Required. An array containing one or more file objects for Gemini to analyze. Each object *must* specify either a 'url', 'path', or ('file_uri' and 'mime_type') key pointing to a supported file. Example: [{path: '/path/to/report.pdf'}, {url: '...'}, {file_uri: 'https://generativelanguage.googleapis.com/v1beta/files/abcde', mime_type: 'image/png'}]"),
});

// Refined schema (though base shape is used for registration)
export const understandMediaSchema = understandMediaBaseSchema; // No top-level refine needed now

// Export the base shape specifically for tool registration
export const understandMediaShape = understandMediaBaseSchema.shape;

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
    const { text, files } = params;
    const tempSubDir = 'tmp';

    const processedFiles: ProcessedFileInfo[] = []; // Store info for final Gemini call
    const cleanupPaths: string[] = []; // Local paths to delete after use
    // Polling/Notification list removed

    try {
        console.log(`[understandMedia] Received request with text: "${text}" and ${files.length} file(s). Max size per file: ${MAX_FILE_SIZE_BYTES} bytes.`);

        // --- Pre-check: Count video files ---
        let videoCount = 0;
        for (const fileSource of files) {
            if (fileSource.url && YOUTUBE_URL_REGEX.test(fileSource.url)) {
                videoCount++;
            } else if (fileSource.mime_type?.startsWith('video/')) { // Check pre-uploaded MIME type
                videoCount++;
            }
            // Note: We can't reliably check MIME type for non-pre-uploaded URLs/paths here without downloading/lookup first.
            // The primary check will happen after determining MIME types during processing.
            // However, checking YouTube URLs and pre-uploaded types early catches some cases.
        }

        if (videoCount > 1) {
             throw new Error("Invalid request: Only one video file (including YouTube URLs or video MIME types) can be processed per request.");
        }
        // Reset video count for the main processing loop check
        videoCount = 0;


        // --- 1. Process each file input ---
        const processingPromises = files.map(async (fileSource, index) => {
            const originalSource = fileSource.url || fileSource.path || fileSource.file_uri || `unknown_file_${index}`;
            let mimeType: string | undefined = fileSource.mime_type;
            let localFilePath: string | null = null;
            let isTemp = false;
            let fileSize = 0;

            console.log(`[understandMedia] Processing file ${index + 1}: ${originalSource}`);

            // --- A. Handle pre-uploaded file_uri ---
            if (fileSource.file_uri && mimeType) {
                console.log(`[understandMedia] Using pre-uploaded file URI: ${fileSource.file_uri}`);
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported MIME type '${mimeType}' for pre-uploaded file: ${originalSource}.`);
                }
                // Store pre-uploaded file info directly
                processedFiles.push({
                    type: 'file_api', // Still treated as file_api type for Gemini request structure
                    originalSource: originalSource,
                    fileApiMimeType: mimeType, // Use specific field
                    fileApiUri: fileSource.file_uri, // Use specific field
                });
                // No size check, upload, or polling needed.
            }
            // --- B. Handle URL (check for YouTube first) ---
            else if (fileSource.url) {
                const url = fileSource.url;
                console.log(`[understandMedia] Processing URL: ${url}`);

                // Check if it's a YouTube URL
                if (YOUTUBE_URL_REGEX.test(url)) {
                    console.log(`[understandMedia] Detected YouTube URL: ${url}. Skipping download and upload.`);
                    processedFiles.push({
                        type: 'youtube',
                        originalSource: url,
                        youtubeUrl: url // Store the URL to be used directly in file_data.file_uri
                    });
                    // No MIME type, size check, upload, or polling needed for YouTube URLs
                } else {
                    // It's a regular URL, try HEAD request first to check size
                    console.log(`[understandMedia] Checking size for URL via HEAD request: ${url}`);
                    let headFileSize: number | null = null;
                    try {
                        const headResponse = await axios.head(url, { timeout: REQUEST_TIMEOUT / 2 }); // Shorter timeout for HEAD
                        const contentLengthHeader = headResponse.headers['content-length'];
                        if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
                            headFileSize = parseInt(contentLengthHeader, 10);
                            console.log(`[understandMedia] HEAD request successful. Content-Length: ${headFileSize} bytes.`);
                            // Check size immediately if HEAD request was successful
                            if (headFileSize > MAX_FILE_SIZE_BYTES) {
                                throw new Error(`File from URL '${originalSource}' is too large (${headFileSize} bytes > ${MAX_FILE_SIZE_BYTES} bytes based on Content-Length). Please use the 'uploadLargeMedia' tool for files larger than 20MB.`);
                            }
                        } else {
                            console.warn(`[understandMedia] HEAD request for ${url} did not return a valid Content-Length header. Proceeding with download to check size.`);
                        }
                    } catch (headError: any) {
                        console.warn(`[understandMedia] HEAD request failed for ${url} (Error: ${headError.message}). Proceeding with download to check size.`);
                        // Proceed to download if HEAD fails
                    }

                    // If HEAD request didn't throw an error due to size, proceed to download
                    console.log(`[understandMedia] Downloading media from URL: ${url}`);
                    // Use the default timeout for the actual download
                    const downloadResult = await downloadFile(url, DEFAULT_OUTPUT_DIR, tempSubDir, `downloaded_media_${index}`);
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
                        videoCount++;
                        if (videoCount > 1) {
                            throw new Error("Invalid request: Only one video file can be processed per request. Multiple video files detected after processing.");
                        }
                    }

                    // Get file size *after* download (as fallback or confirmation)
                    const stats = await fs.stat(localFilePath);
                    fileSize = stats.size;
                    if (fileSize === 0) {
                        throw new Error(`Downloaded file is empty: ${localFilePath}`);
                    }
                    console.log(`[understandMedia] Downloaded file size: ${fileSize} bytes for ${localFilePath}`);

                    // --- Check Size Again (important if HEAD failed) ---
                    if (fileSize > MAX_FILE_SIZE_BYTES) {
                         // This case should ideally be caught by HEAD, but handles HEAD failures or inaccurate Content-Length
                        console.warn(`[understandMedia] File size check after download indicates file is too large (${fileSize} > ${MAX_FILE_SIZE_BYTES}). This might happen if HEAD request failed or Content-Length was inaccurate.`);
                        throw new Error(`File from URL '${originalSource}' is too large (${fileSize} bytes > ${MAX_FILE_SIZE_BYTES} bytes). Please use the 'uploadLargeMedia' tool for files larger than 20MB.`);
                    }

                    // --- Use Inline Data (since size is confirmed to be within limit) ---
                    console.log(`[understandMedia] File size (${fileSize} bytes) is within limit. Using inline data.`);
                    const fileData = await fs.readFile(localFilePath);
                    const base64Data = fileData.toString('base64');
                    processedFiles.push({
                        type: 'inline',
                        mimeType: mimeType,
                        originalSource: originalSource,
                        base64Data: base64Data
                    });
                    // File API upload and polling removed
                }
            }
            // --- C. Handle local path ---
            else if (fileSource.path) {
                await fs.access(fileSource.path); // Check existence
                localFilePath = path.resolve(fileSource.path);
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
                        videoCount++;
                        if (videoCount > 1) {
                            throw new Error("Invalid request: Only one video file can be processed per request. Multiple video files detected after processing.");
                        }
                    }

                    // Get file size
                const stats = await fs.stat(localFilePath);
                fileSize = stats.size;
                if (fileSize === 0) {
                    throw new Error(`File is empty: ${localFilePath}`);
                }
                console.log(`[understandMedia] File size: ${fileSize} bytes for ${localFilePath}`);

                // --- Check Size ---
                if (fileSize > MAX_FILE_SIZE_BYTES) {
                    throw new Error(`Local file '${originalSource}' is too large (${fileSize} bytes > ${MAX_FILE_SIZE_BYTES} bytes). Please use the 'uploadLargeMedia' tool for files larger than 20MB.`);
                }

                // --- Use Inline Data (since size is within limit) ---
                console.log(`[understandMedia] File size (${fileSize} bytes) is within limit. Using inline data.`);
                const fileData = await fs.readFile(localFilePath);
                const base64Data = fileData.toString('base64');
                processedFiles.push({
                    type: 'inline',
                    mimeType: mimeType,
                    originalSource: originalSource,
                    base64Data: base64Data
                });
                // File API upload and polling removed
            }
            // --- D. Handle invalid input ---
            else {
                throw new Error(`Invalid file source object, missing url, path, or file_uri/mime_type: ${JSON.stringify(fileSource)}`);
            }
        }); // End map

        // Wait for all initial processing (downloads, size checks, potential uploads)
        await Promise.all(processingPromises);

        // --- Validation after processing ---
        if (processedFiles.length !== files.length) {
            throw new Error("Some files failed during initial processing or upload.");
        }
        if (processedFiles.length === 0) {
            throw new Error("No files were successfully processed to be sent to Gemini.");
        }

        // --- 2. Polling Step Removed ---

        // --- 3. Call Gemini Generate Content ---
        const generateContentUrl = `${GEMINI_API_URL}/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`; // Use full URL from config

        // Construct the parts array, mixing inline_data and file_data as needed
        const requestParts = [
            { text: text }, // Always include the text prompt first
            ...processedFiles.map(fileInfo => {
                if (fileInfo.type === 'inline') {
                    if (!fileInfo.mimeType || !fileInfo.base64Data) {
                        throw new Error(`Internal error: Missing mimeType or base64Data for inline file: ${fileInfo.originalSource}`);
                    }
                    return { inline_data: { mime_type: fileInfo.mimeType, data: fileInfo.base64Data } };
                } else if (fileInfo.type === 'file_api') { // This now only applies to pre-uploaded URIs
                    if (!fileInfo.fileApiMimeType || !fileInfo.fileApiUri) {
                        throw new Error(`Internal error: Missing fileApiMimeType or fileApiUri for pre-uploaded file: ${fileInfo.originalSource}`);
                    }
                    return { file_data: { mime_type: fileInfo.fileApiMimeType, file_uri: fileInfo.fileApiUri } };
                } else { // type === 'youtube'
                    if (!fileInfo.youtubeUrl) {
                        throw new Error(`Internal error: Missing youtubeUrl for youtube file: ${fileInfo.originalSource}`);
                    }
                    // For YouTube, use file_uri without mime_type
                    return { file_data: { file_uri: fileInfo.youtubeUrl } };
                }
            })
        ];
        const requestPayload = { contents: [{ parts: requestParts }] };

        // Log payload carefully - potentially large base64 data
        console.log(`[understandMedia] Calling Gemini (${GEMINI_UNDERSTANDING_MODEL}) with ${processedFiles.length} file(s)...`);
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
