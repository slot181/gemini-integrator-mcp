import { z } from 'zod';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import {
    GEMINI_API_KEY,
    GEMINI_API_URL, // Needed for polling URL
    REQUEST_TIMEOUT,
    DEFAULT_OUTPUT_DIR,
} from '../config.js';
import { deleteFile, downloadFile } from '../utils/fileUtils.js';
import {
    sendOneBotNotification,
    sendTelegramNotification,
    isNotificationConfigured,
    getConfiguredNotifiers
} from '../utils/notificationUtils.js';
import { getEffectiveMediaSizeLimit } from '../utils/mediaLimitUtils.js'; // Import the new utility function

// --- Constants ---
// Calculate effective limits using the utility function
const { limitMB: USER_LIMIT_MB, limitBytes: USER_LIMIT_BYTES } = getEffectiveMediaSizeLimit('uploadLargeMedia');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// --- Helper function to delay execution ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Polling Configuration ---
const FILE_POLLING_INTERVAL_MS = 2000; // Check every 2 seconds
const MAX_FILE_POLLING_ATTEMPTS = 90; // Max attempts (e.g., 90 * 2s = 180 seconds timeout)

// --- Google File API Response Interfaces (Copied from original understandMedia) ---
interface FileInfo {
    name: string;
    uri: string;
    mimeType: string;
    createTime: string;
    updateTime: string;
    displayName: string;
    sizeBytes: string;
    state?: 'PROCESSING' | 'ACTIVE' | 'FAILED' | 'STATE_UNSPECIFIED';
    videoMetadata?: {
        videoDuration: { seconds: string; nanos: number };
    };
}
interface FileApiResponse {
    file: FileInfo;
}
interface GetFileApiResponse extends FileInfo {}

// Define the base object schema first
const uploadLargeMediaBaseSchema = z.object({
    url: z.string().url().optional().describe(`URL of the large media file (larger than the configured ${USER_LIMIT_MB}MB limit for 'understandMedia') to upload via Google File API.`),
    path: z.string().optional().describe(`Local path to the large media file (larger than the configured ${USER_LIMIT_MB}MB limit for 'understandMedia') to upload via Google File API.`),
});

// Export the shape from the base schema for tool registration
export const uploadLargeMediaShape = uploadLargeMediaBaseSchema.shape;

// Apply refinement to the base schema for validation and type inference
export const uploadLargeMediaSchema = uploadLargeMediaBaseSchema.refine(data => {
    const sources = [data.url, data.path].filter(Boolean).length;
    return sources === 1; // Exactly one source must be provided
}, {
    message: "Provide exactly one of 'url' or 'path'.",
});


type UploadLargeMediaParams = z.infer<typeof uploadLargeMediaSchema>;

// --- File Upload and Polling Functions (Copied/Adapted from original understandMedia) ---

/**
 * Uploads a file to the Google File API using the provided Axios instance for the initial request.
 * Returns the file name (relative path) and full URI upon successful upload.
 */
async function uploadFileToGoogleApi(
    filePath: string,
    mimeType: string,
    displayName: string,
    fileSize: number,
    axiosInstance: any // Revert to 'any' type to resolve TS error
): Promise<{ name: string, uri: string }> {
    console.log(`[uploadLargeMedia:uploadFileToGoogleApi] Starting upload for: ${filePath}, MIME: ${mimeType}, Size: ${fileSize} bytes`);
    const numBytes = fileSize;

    if (numBytes === 0) {
        throw new Error(`File is empty and cannot be uploaded: ${filePath}`);
    }
    // Check size against the *effective* user limit calculated earlier
    if (numBytes <= USER_LIMIT_BYTES) {
         console.warn(`[uploadLargeMedia:uploadFileToGoogleApi] Warning: File ${filePath} (${numBytes} bytes) is not strictly larger than the configured ${USER_LIMIT_MB}MB limit (${USER_LIMIT_BYTES} bytes). Consider using 'understandMedia' directly for smaller files.`);
    }

    // Construct the start upload URL using the configured base URL
    const startUploadUrl = `${GEMINI_API_URL.replace(/\/v1beta$/, '')}/upload/v1beta/files?key=${GEMINI_API_KEY}`;
    console.log(`[uploadLargeMedia:uploadFileToGoogleApi] Using start upload URL: ${startUploadUrl}`);

    // 1. Start Resumable Upload using the provided axiosInstance (which points to the proxy)
    console.log('[uploadLargeMedia:uploadFileToGoogleApi] Initiating resumable upload via proxy...');
    let uploadUrl = '';
    try {
        // Use the passed axiosInstance for the initial POST request
        const startResponse = await axiosInstance.post(
            // The URL path should be relative to the axiosInstance baseURL (proxy)
            `/upload/v1beta/files?key=${GEMINI_API_KEY}`,
            { file: { display_name: displayName } }, // Request body
            { // Request config
                 headers: { // Headers for the *initial* request
                     'X-Goog-Upload-Protocol': 'resumable',
                     'X-Goog-Upload-Command': 'start',
                     'X-Goog-Upload-Header-Content-Length': numBytes.toString(),
                     'X-Goog-Upload-Header-Content-Type': mimeType,
                     // Removed 'Content-Type': 'application/json', let Axios handle it
                 },
                 timeout: REQUEST_TIMEOUT,
            }
        );

        // Extract the upload URL from the 'location' header (standard for resumable uploads)
        // or potentially 'x-goog-upload-url' as a fallback
        uploadUrl = startResponse.headers?.['location'] ?? startResponse.headers?.['x-goog-upload-url'] ?? '';

        if (!uploadUrl) {
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Failed to get upload URL from headers (checked location and x-goog-upload-url):', startResponse.headers);
            throw new Error('Failed to initiate resumable upload: No upload URL received in location or x-goog-upload-url header.');
        }
        console.log(`[uploadLargeMedia:uploadFileToGoogleApi] Got upload URL: ${uploadUrl}`);
    } catch (error: unknown) {
         const err = error as any;
         let message = 'Failed to initiate resumable upload via proxy.';
         if (err.response && err.message) {
             message += ` Axios Error: ${err.message} - Status: ${err.response?.status} - Data: ${JSON.stringify(err.response?.data)}`;
             console.error('[uploadLargeMedia:uploadFileToGoogleApi] Axios error initiating resumable upload via proxy:', err.response?.status, err.response?.data || err.message);
         } else if (err.message) {
              message += ` Error: ${err.message}`;
             console.error('[uploadLargeMedia:uploadFileToGoogleApi] Error initiating resumable upload via proxy:', err.message);
         } else {
             console.error('[uploadLargeMedia:uploadFileToGoogleApi] Unknown error initiating resumable upload via proxy:', error);
         }
         throw new Error(message);
    }


    // 2. Upload File Data - **Use the direct uploadUrl from Google, NOT the proxy**
    console.log(`[uploadLargeMedia:uploadFileToGoogleApi] Uploading file data directly to Google URL: ${uploadUrl}`);
    try {
        const fileData = await fs.readFile(filePath);
        // Use a *direct* axios call for the actual data upload, not the instance pointing to the proxy
        const uploadConfig = {
             headers: {
                 // Headers for the *data upload* request
                 'Content-Length': numBytes.toString(),
                 // 'X-Goog-Upload-Offset': '0', // Offset is usually implicit for the first chunk
                 // 'X-Goog-Upload-Command': 'upload, finalize', // Command might be implicit or handled by PUT/POST method choice
                 'Content-Type': mimeType, // Content-Type of the *file data*
             },
             maxBodyLength: Infinity,
             maxContentLength: Infinity,
             timeout: TWENTY_FOUR_HOURS_MS, // Set upload timeout to 24 hours
        };
        // Use PUT for resumable upload data transfer as per Google Cloud Storage docs (often used by File API)
        // Alternatively, POST might work depending on the specific API implementation Google uses here. Let's try PUT first.
        // Remove type argument from axios.put and use type assertion later
        const uploadResponse = await axios.put(uploadUrl, fileData, uploadConfig);

        // Assert the type of the response data
        const responseData = uploadResponse.data as FileApiResponse;

        // Google File API might return 200 OK on successful finalization
        if (uploadResponse.status !== 200 || !responseData?.file?.uri || !responseData?.file?.name) {
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Direct file upload to Google failed or URI/Name missing:', uploadResponse.status, responseData);
            throw new Error(`Direct file upload to Google failed with status ${uploadResponse.status}. Response: ${JSON.stringify(responseData)}`);
         }

         const { name, uri } = responseData.file; // Use asserted responseData
         console.log(`[uploadLargeMedia:uploadFileToGoogleApi] Direct file upload successful. Name: ${name}, URI: ${uri}`);
         return { name, uri };

    } catch (error: unknown) {
          const err = error as any;
          let message = 'Failed to upload file data directly to Google.';
          if (err.response && err.message) {
              message += ` Axios Error: ${err.message} - Status: ${err.response?.status} - Data: ${JSON.stringify(err.response?.data)}`;
             console.error('[uploadLargeMedia:uploadFileToGoogleApi] Axios error uploading file data directly to Google:', err.response?.status, err.response?.data || err.message);
         } else if (err.message) {
              message += ` Error: ${err.message}`;
             console.error('[uploadLargeMedia:uploadFileToGoogleApi] Error uploading file data directly to Google:', err.message);
         } else {
             console.error('[uploadLargeMedia:uploadFileToGoogleApi] Unknown error uploading file data directly to Google:', error);
         }
         throw new Error(message);
    }
}


/**
 * Polls the Google File API (via the proxy) for the status of a file until it's ACTIVE or failed/timed out.
 * Sends notifications upon successful activation or failure if configured.
 */
async function pollFileStatusAndNotify(
    fileName: string,
    fullUri: string,
    mimeType: string,
    originalSource: string,
    axiosInstance: any // Revert to 'any' type to resolve TS error
): Promise<void> {
    console.log(`[uploadLargeMedia:pollFileStatus] Starting polling for file: ${fileName} (URI: ${fullUri}, Original: ${originalSource})`);
    // Construct the polling URL relative to the proxy's base URL
    const getFileUrl = `/v1beta/${fileName}?key=${GEMINI_API_KEY}`; // Relative path for axiosInstance
    console.log(`[uploadLargeMedia:pollFileStatus] Using polling URL via proxy: ${axiosInstance.defaults.baseURL}${getFileUrl}`);
    let attempts = 0;
    let apiUpdateTime: string | undefined;

    while (attempts < MAX_FILE_POLLING_ATTEMPTS) {
        attempts++;
        console.log(`[uploadLargeMedia:pollFileStatus] Polling status for ${fileName} via proxy (Attempt ${attempts}/${MAX_FILE_POLLING_ATTEMPTS})...`);

        try {
            // Use the passed axiosInstance for polling, remove type argument from .get()
            const response = await axiosInstance.get(getFileUrl, { timeout: REQUEST_TIMEOUT });
            // Assert the type of response.data after the call
            const responseData = response.data as GetFileApiResponse;
            const fileState = responseData?.state;
            apiUpdateTime = responseData.updateTime; // Capture update time regardless of state

            console.log(`[uploadLargeMedia:pollFileStatus] File ${fileName} state from proxy: ${fileState}`);
            if (fileState === 'ACTIVE') {
                console.log(`[uploadLargeMedia:pollFileStatus] File ${fileName} is ACTIVE via proxy. Update Time: ${apiUpdateTime}`);
                const successTime = apiUpdateTime ? new Date(apiUpdateTime).toLocaleString() : 'N/A';
                const notificationMessage = `✅ Large file ready:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\`\nReady At: \`${successTime}\``;
                 await sendOneBotNotification(notificationMessage);
                 await sendTelegramNotification(notificationMessage);
                 return; // Success
            } else if (fileState === 'FAILED') {
                 console.error(`[uploadLargeMedia:pollFileStatus] File ${fileName} processing failed via proxy. Response:`, responseData); // Use responseData here
                 const failureTime = apiUpdateTime ? new Date(apiUpdateTime).toLocaleString() : 'N/A';
                 const failureMessage = `❌ Large file processing failed:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\`\nFailed At: \`${failureTime}\``;
                 await sendOneBotNotification(failureMessage);
                 await sendTelegramNotification(failureMessage);
                 throw new Error(`Processing failed for file ${fileName}.`);
            } else if (fileState === 'PROCESSING' || fileState === 'STATE_UNSPECIFIED') {
                  console.log(`[uploadLargeMedia:pollFileStatus] File ${fileName} is still ${fileState || 'in unspecified state'} via proxy.`);
            } else {
                  console.warn(`[uploadLargeMedia:pollFileStatus] File ${fileName} has unexpected state via proxy: ${fileState}. Continuing polling.`);
            }

        } catch (pollError: unknown) {
              const err = pollError as any;
              console.error(`[uploadLargeMedia:pollFileStatus] Error polling status for ${fileName} via proxy (Attempt ${attempts}):`, err.response?.data || err.message || pollError);
              // Don't throw immediately, let the loop continue until timeout
        }

        if (attempts >= MAX_FILE_POLLING_ATTEMPTS) {
             console.error(`[uploadLargeMedia:pollFileStatus] Polling timed out for file ${fileName} via proxy after ${MAX_FILE_POLLING_ATTEMPTS} attempts.`);
             const timeoutMessage = `⏳ Polling timed out for large file:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\``;
             await sendOneBotNotification(timeoutMessage);
             await sendTelegramNotification(timeoutMessage);
             throw new Error(`Polling timed out for file ${fileName}. It did not become ACTIVE.`);
        }

        await delay(FILE_POLLING_INTERVAL_MS);
    }
}


// Set of supported MIME types (copied from original understandMedia)
const SUPPORTED_MIME_TYPES = new Set([ // Keep this consistent
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
    'audio/wav', 'audio/mp3', 'audio/mpeg', // Keep audio/mpeg for lookup fallback
    'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
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
    'application/json',
    'application/javascript', // Redundant but safe
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


/**
 * Handles the large media upload tool request.
 * Returns an immediate success message and performs upload/polling in the background.
 */
export async function handleUploadLargeMedia(
    params: UploadLargeMediaParams,
    axiosInstance: any // Revert to 'any' type to resolve TS error
): Promise<{ content: Array<TextContent> }> {
    const { url, path: localInputPath } = params;
    const originalSource = url || localInputPath || 'unknown_source';
    const tempSubDir = 'tmp'; // Use 'tmp' subfolder within DEFAULT_OUTPUT_DIR
    let cleanupPath: string | null = null; // Single path to clean up if downloaded

    // --- 1. Check Notification Configuration ---
    if (!isNotificationConfigured()) {
         console.error('[uploadLargeMedia] Notification system (OneBot/Telegram) is not configured. This tool requires notifications.');
         return { content: [{ type: 'text', text: "Error: Notification system (OneBot/Telegram) must be configured in the MCP server's environment variables to use this tool." }] };
    }
    const configuredNotifiers = getConfiguredNotifiers();
    console.log(`[uploadLargeMedia] Notifications configured via: ${configuredNotifiers}`);

    // --- 2. Return Immediate Success Response ---
    const initialResponse = `Initiating background upload for large media: ${originalSource}. You will receive a notification via ${configuredNotifiers} upon completion or failure.`;
    console.log(`[uploadLargeMedia] Returning initial response: "${initialResponse}"`);

    // --- 3. Start Background Processing ---
    setImmediate(async () => {
        console.log(`[uploadLargeMedia:background] Starting background processing for ${originalSource}`);
        try {
            let filePathToUpload: string;
            let mimeType: string | undefined;
            let fileSize: number;
            let isTemp = false;

            // --- A. Handle URL Input ---
            if (url) {
                console.log(`[uploadLargeMedia:background] Downloading from URL: ${url}`);
                // Pass 24-hour timeout to downloadFile
                const downloadResult = await downloadFile(url, DEFAULT_OUTPUT_DIR, tempSubDir, `large_download`, TWENTY_FOUR_HOURS_MS);
                filePathToUpload = downloadResult.filePath;
                cleanupPath = filePathToUpload; // Mark for cleanup
                isTemp = true;
                console.log(`[uploadLargeMedia:background] Downloaded to: ${filePathToUpload}`);

                // Notify download success
                const downloadSuccessMsg = `ℹ️ Download complete for large file:\nOriginal URL: \`${url}\`\nSaved to: \`${filePathToUpload}\``;
                await sendOneBotNotification(downloadSuccessMsg);
                await sendTelegramNotification(downloadSuccessMsg);

                // Determine MIME type
                const downloadedContentType = downloadResult.contentType;
                if (downloadedContentType) {
                    mimeType = downloadedContentType;
                } else {
                    const lookupResult = mime.lookup(filePathToUpload);
                    mimeType = lookupResult === false ? undefined : lookupResult;
                }
                if (!mimeType) throw new Error(`Could not determine MIME type for downloaded file: ${filePathToUpload}`);
                 // Correct MP3 MIME type if necessary
                const fileExt = path.extname(filePathToUpload).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg') mimeType = 'audio/mp3';

                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for source URL: ${url}.`);
                }

                // Get file size
                const stats = await fs.stat(filePathToUpload);
                fileSize = stats.size;
                if (fileSize === 0) throw new Error(`Downloaded file is empty: ${filePathToUpload}`);

            }
            // --- B. Handle Path Input ---
            else if (localInputPath) {
                filePathToUpload = path.resolve(localInputPath);
                await fs.access(filePathToUpload); // Check existence
                console.log(`[uploadLargeMedia:background] Using local file: ${filePathToUpload}`);

                // Determine MIME type
                const lookupResult = mime.lookup(filePathToUpload);
                mimeType = lookupResult === false ? undefined : lookupResult;
                if (!mimeType) throw new Error(`Could not determine MIME type for local file: ${filePathToUpload}`);
                 // Correct MP3 MIME type if necessary
                const fileExt = path.extname(filePathToUpload).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg') mimeType = 'audio/mp3';

                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for source path: ${localInputPath}.`);
                }

                // Get file size
                const stats = await fs.stat(filePathToUpload);
                fileSize = stats.size;
                if (fileSize === 0) throw new Error(`File is empty: ${filePathToUpload}`);

            } else {
                // This case should not happen due to schema validation, but handle defensively
                throw new Error("Internal error: No URL or path provided in background task.");
            }

            // --- C. Upload and Poll ---
            console.log(`[uploadLargeMedia:background] Proceeding to upload: ${filePathToUpload}, MIME: ${mimeType}, Size: ${fileSize}`);
            const displayName = path.basename(filePathToUpload);
            // Pass axiosInstance to uploadFileToGoogleApi
            const uploadResult = await uploadFileToGoogleApi(filePathToUpload, mimeType, displayName, fileSize, axiosInstance);

            // Upload succeeded, now poll (pollFileStatusAndNotify handles notifications)
            // Pass axiosInstance to pollFileStatusAndNotify
            await pollFileStatusAndNotify(uploadResult.name, uploadResult.uri, mimeType, originalSource, axiosInstance);

            console.log(`[uploadLargeMedia:background] Successfully processed and notified for: ${originalSource}`);

        } catch (error: unknown) {
            console.error(`[uploadLargeMedia:background] Error during background processing for ${originalSource}:`, error);
            const err = error as any;
            const errorMessage = err.message || String(error);
            // Send error notification
            const errorNotification = `❌ Error processing large file:\nOriginal: \`${originalSource}\`\nError: \`${errorMessage}\``;
            await sendOneBotNotification(errorNotification);
            await sendTelegramNotification(errorNotification);
        } finally {
            // --- D. Cleanup Downloaded File ---
            if (cleanupPath) {
                console.log(`[uploadLargeMedia:background] Cleaning up temporary file: ${cleanupPath}`);
                try {
                    await deleteFile(cleanupPath);
                    console.log(`[uploadLargeMedia:background] Successfully cleaned up ${cleanupPath}`);
                } catch (cleanupError) {
                    console.error(`[uploadLargeMedia:background] Failed to clean up temporary file ${cleanupPath}:`, cleanupError);
                    // Optionally send another notification about cleanup failure?
                }
            }
        }
    }); // End setImmediate

    // Return the initial response immediately
    return { content: [{ type: 'text', text: initialResponse }] };
}
