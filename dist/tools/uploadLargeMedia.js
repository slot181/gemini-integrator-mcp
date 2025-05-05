import { z } from 'zod';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import { GEMINI_API_KEY, GEMINI_API_URL, // Needed for polling URL
REQUEST_TIMEOUT, DEFAULT_OUTPUT_DIR, } from '../config.js';
import { deleteFile, downloadFile } from '../utils/fileUtils.js';
import { sendOneBotNotification, sendTelegramNotification, isNotificationConfigured, getConfiguredNotifiers } from '../utils/notificationUtils.js';
import { getEffectiveMediaSizeLimit } from '../utils/mediaLimitUtils.js'; // Import the new utility function
// --- Constants ---
// Calculate effective limits using the utility function
const { limitMB: USER_LIMIT_MB, limitBytes: USER_LIMIT_BYTES } = getEffectiveMediaSizeLimit('uploadLargeMedia');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
// --- Helper function to delay execution ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// --- Polling Configuration ---
const FILE_POLLING_INTERVAL_MS = 2000; // Check every 2 seconds
const MAX_FILE_POLLING_ATTEMPTS = 90; // Max attempts (e.g., 90 * 2s = 180 seconds timeout)
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
// --- File Upload and Polling Functions (Copied/Adapted from original understandMedia) ---
/**
 * Uploads a file to the Google File API.
 * Returns the file name (relative path) and full URI upon successful upload.
 */
async function uploadFileToGoogleApi(filePath, mimeType, displayName, fileSize) {
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
    // 1. Start Resumable Upload
    console.log('[uploadLargeMedia:uploadFileToGoogleApi] Initiating resumable upload...');
    let uploadUrl = '';
    try {
        const startResponse = await axios.post(startUploadUrl, { file: { display_name: displayName } }, {
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': numBytes.toString(),
                'X-Goog-Upload-Header-Content-Type': mimeType,
                'Content-Type': 'application/json',
            },
            timeout: REQUEST_TIMEOUT,
        });
        uploadUrl = startResponse.headers?.['x-goog-upload-url'] ?? '';
        if (!uploadUrl) {
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Failed to get upload URL from headers:', startResponse.headers);
            throw new Error('Failed to initiate resumable upload: No upload URL received.');
        }
        console.log('[uploadLargeMedia:uploadFileToGoogleApi] Got upload URL.');
    }
    catch (error) {
        const err = error;
        let message = 'Failed to initiate resumable upload.';
        if (err.response && err.message) {
            message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Axios error initiating resumable upload:', err.response?.data || err.message);
        }
        else if (err.message) {
            message += ` Error: ${err.message}`;
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Error initiating resumable upload:', err.message);
        }
        else {
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Unknown error initiating resumable upload:', error);
        }
        throw new Error(message);
    }
    // 2. Upload File Data
    console.log('[uploadLargeMedia:uploadFileToGoogleApi] Uploading file data...');
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
            timeout: TWENTY_FOUR_HOURS_MS, // Set upload timeout to 24 hours
        };
        const uploadResponse = await axios.post(uploadUrl, fileData, uploadConfig);
        if (uploadResponse.status !== 200 || !uploadResponse.data?.file?.uri || !uploadResponse.data?.file?.name) {
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] File upload failed or URI/Name missing:', uploadResponse.data);
            throw new Error(`File upload failed with status ${uploadResponse.status}. Response: ${JSON.stringify(uploadResponse.data)}`);
        }
        const { name, uri } = uploadResponse.data.file;
        console.log(`[uploadLargeMedia:uploadFileToGoogleApi] File uploaded successfully. Name: ${name}, URI: ${uri}`);
        return { name, uri };
    }
    catch (error) {
        const err = error;
        let message = 'Failed to upload file data.';
        if (err.response && err.message) {
            message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Axios error uploading file data:', err.response?.data || err.message);
        }
        else if (err.message) {
            message += ` Error: ${err.message}`;
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Error uploading file data:', err.message);
        }
        else {
            console.error('[uploadLargeMedia:uploadFileToGoogleApi] Unknown error uploading file data:', error);
        }
        throw new Error(message);
    }
}
/**
 * Polls the Google File API for the status of a file until it's ACTIVE or failed/timed out.
 * Sends notifications upon successful activation or failure if configured.
 */
async function pollFileStatusAndNotify(fileName, fullUri, mimeType, originalSource) {
    console.log(`[uploadLargeMedia:pollFileStatus] Starting polling for file: ${fileName} (URI: ${fullUri}, Original: ${originalSource})`);
    // Construct the polling URL using the configured base URL
    const getFileUrl = `${GEMINI_API_URL}/v1beta/${fileName}?key=${GEMINI_API_KEY}`; // GEMINI_API_URL already includes /v1beta usually, but this handles cases where it might not. Ensure fileName starts correctly (e.g., files/...)
    console.log(`[uploadLargeMedia:pollFileStatus] Using polling URL: ${getFileUrl}`);
    let attempts = 0;
    let apiUpdateTime;
    while (attempts < MAX_FILE_POLLING_ATTEMPTS) {
        attempts++;
        console.log(`[uploadLargeMedia:pollFileStatus] Polling status for ${fileName} (Attempt ${attempts}/${MAX_FILE_POLLING_ATTEMPTS})...`);
        try {
            const response = await axios.get(getFileUrl, { timeout: REQUEST_TIMEOUT });
            const fileState = response.data?.state;
            apiUpdateTime = response.data.updateTime; // Capture update time regardless of state
            console.log(`[uploadLargeMedia:pollFileStatus] File ${fileName} state: ${fileState}`);
            if (fileState === 'ACTIVE') {
                console.log(`[uploadLargeMedia:pollFileStatus] File ${fileName} is ACTIVE. Update Time: ${apiUpdateTime}`);
                const successTime = apiUpdateTime ? new Date(apiUpdateTime).toLocaleString() : 'N/A';
                const notificationMessage = `✅ Large file ready:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\`\nReady At: \`${successTime}\``;
                await sendOneBotNotification(notificationMessage);
                await sendTelegramNotification(notificationMessage);
                return; // Success
            }
            else if (fileState === 'FAILED') {
                console.error(`[uploadLargeMedia:pollFileStatus] File ${fileName} processing failed. Response:`, response.data);
                const failureTime = apiUpdateTime ? new Date(apiUpdateTime).toLocaleString() : 'N/A';
                const failureMessage = `❌ Large file processing failed:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\`\nFailed At: \`${failureTime}\``;
                await sendOneBotNotification(failureMessage);
                await sendTelegramNotification(failureMessage);
                throw new Error(`Processing failed for file ${fileName}.`);
            }
            else if (fileState === 'PROCESSING' || fileState === 'STATE_UNSPECIFIED') {
                console.log(`[uploadLargeMedia:pollFileStatus] File ${fileName} is still ${fileState || 'in unspecified state'}.`);
            }
            else {
                console.warn(`[uploadLargeMedia:pollFileStatus] File ${fileName} has unexpected state: ${fileState}. Continuing polling.`);
            }
        }
        catch (pollError) {
            const err = pollError;
            console.error(`[uploadLargeMedia:pollFileStatus] Error polling status for ${fileName} (Attempt ${attempts}):`, err.response?.data || err.message || pollError);
            // Don't throw immediately, let the loop continue until timeout
        }
        if (attempts >= MAX_FILE_POLLING_ATTEMPTS) {
            console.error(`[uploadLargeMedia:pollFileStatus] Polling timed out for file ${fileName} after ${MAX_FILE_POLLING_ATTEMPTS} attempts.`);
            const timeoutMessage = `⏳ Polling timed out for large file:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\``;
            await sendOneBotNotification(timeoutMessage);
            await sendTelegramNotification(timeoutMessage);
            throw new Error(`Polling timed out for file ${fileName}. It did not become ACTIVE.`);
        }
        await delay(FILE_POLLING_INTERVAL_MS);
    }
}
// Set of supported MIME types (copied from original understandMedia)
const SUPPORTED_MIME_TYPES = new Set([
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
    'audio/wav', 'audio/mp3', 'audio/mpeg',
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
    'application/javascript',
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
export async function handleUploadLargeMedia(params) {
    const { url, path: localInputPath } = params;
    const originalSource = url || localInputPath || 'unknown_source';
    const tempSubDir = 'tmp'; // Use 'tmp' subfolder within DEFAULT_OUTPUT_DIR
    let cleanupPath = null; // Single path to clean up if downloaded
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
            let filePathToUpload;
            let mimeType;
            let fileSize;
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
                }
                else {
                    const lookupResult = mime.lookup(filePathToUpload);
                    mimeType = lookupResult === false ? undefined : lookupResult;
                }
                if (!mimeType)
                    throw new Error(`Could not determine MIME type for downloaded file: ${filePathToUpload}`);
                // Correct MP3 MIME type if necessary
                const fileExt = path.extname(filePathToUpload).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg')
                    mimeType = 'audio/mp3';
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for source URL: ${url}.`);
                }
                // Get file size
                const stats = await fs.stat(filePathToUpload);
                fileSize = stats.size;
                if (fileSize === 0)
                    throw new Error(`Downloaded file is empty: ${filePathToUpload}`);
            }
            // --- B. Handle Path Input ---
            else if (localInputPath) {
                filePathToUpload = path.resolve(localInputPath);
                await fs.access(filePathToUpload); // Check existence
                console.log(`[uploadLargeMedia:background] Using local file: ${filePathToUpload}`);
                // Determine MIME type
                const lookupResult = mime.lookup(filePathToUpload);
                mimeType = lookupResult === false ? undefined : lookupResult;
                if (!mimeType)
                    throw new Error(`Could not determine MIME type for local file: ${filePathToUpload}`);
                // Correct MP3 MIME type if necessary
                const fileExt = path.extname(filePathToUpload).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg')
                    mimeType = 'audio/mp3';
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for source path: ${localInputPath}.`);
                }
                // Get file size
                const stats = await fs.stat(filePathToUpload);
                fileSize = stats.size;
                if (fileSize === 0)
                    throw new Error(`File is empty: ${filePathToUpload}`);
            }
            else {
                // This case should not happen due to schema validation, but handle defensively
                throw new Error("Internal error: No URL or path provided in background task.");
            }
            // --- C. Upload and Poll ---
            console.log(`[uploadLargeMedia:background] Proceeding to upload: ${filePathToUpload}, MIME: ${mimeType}, Size: ${fileSize}`);
            const displayName = path.basename(filePathToUpload);
            const uploadResult = await uploadFileToGoogleApi(filePathToUpload, mimeType, displayName, fileSize);
            // Upload succeeded, now poll (pollFileStatusAndNotify handles notifications)
            await pollFileStatusAndNotify(uploadResult.name, uploadResult.uri, mimeType, originalSource);
            console.log(`[uploadLargeMedia:background] Successfully processed and notified for: ${originalSource}`);
        }
        catch (error) {
            console.error(`[uploadLargeMedia:background] Error during background processing for ${originalSource}:`, error);
            const err = error;
            const errorMessage = err.message || String(error);
            // Send error notification
            const errorNotification = `❌ Error processing large file:\nOriginal: \`${originalSource}\`\nError: \`${errorMessage}\``;
            await sendOneBotNotification(errorNotification);
            await sendTelegramNotification(errorNotification);
        }
        finally {
            // --- D. Cleanup Downloaded File ---
            if (cleanupPath) {
                console.log(`[uploadLargeMedia:background] Cleaning up temporary file: ${cleanupPath}`);
                try {
                    await deleteFile(cleanupPath);
                    console.log(`[uploadLargeMedia:background] Successfully cleaned up ${cleanupPath}`);
                }
                catch (cleanupError) {
                    console.error(`[uploadLargeMedia:background] Failed to clean up temporary file ${cleanupPath}:`, cleanupError);
                    // Optionally send another notification about cleanup failure?
                }
            }
        }
    }); // End setImmediate
    // Return the initial response immediately
    return { content: [{ type: 'text', text: initialResponse }] };
}
//# sourceMappingURL=uploadLargeMedia.js.map