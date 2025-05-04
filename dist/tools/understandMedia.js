import { z } from 'zod';
import axios from 'axios'; // Default import
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import TelegramBot from 'node-telegram-bot-api'; // Import Telegram Bot library
import { GEMINI_API_KEY, GEMINI_API_URL, GEMINI_UNDERSTANDING_MODEL, REQUEST_TIMEOUT, DEFAULT_OUTPUT_DIR, ONEBOT_HTTP_URL, // Import OneBot config
ONEBOT_ACCESS_TOKEN, // Import OneBot config
TELEGRAM_BOT_TOKEN, // Import Telegram config
TELEGRAM_CHAT_ID, // Import Telegram config
ONEBOT_MESSAGE_TYPE, // Import OneBot message type
ONEBOT_TARGET_ID // Import OneBot target ID
 } from '../config.js';
import { deleteFile, downloadFile } from '../utils/fileUtils.js';
// --- Constants ---
const MAX_INLINE_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB limit for inline data
// --- Helper function to delay execution ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// --- Polling Configuration ---
const FILE_POLLING_INTERVAL_MS = 2000; // Check every 2 seconds
const MAX_FILE_POLLING_ATTEMPTS = 90; // Max attempts (e.g., 90 * 2s = 180 seconds timeout)
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
    if (sources !== 1)
        return false; // Exactly one source must be provided
    if (data.file_uri && !data.mime_type)
        return false; // mime_type is required if file_uri is used
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
// --- Notification Functions ---
/**
 * Sends a notification message using OneBot v11 HTTP API based on configuration.
 */
async function sendOneBotNotification(message) {
    // Check if essential OneBot config is present
    if (!ONEBOT_HTTP_URL || !ONEBOT_MESSAGE_TYPE || !ONEBOT_TARGET_ID) {
        // console.log('[OneBot Notification] URL, Message Type, or Target ID not configured, skipping.');
        return;
    }
    // Validate message type
    if (ONEBOT_MESSAGE_TYPE !== 'private' && ONEBOT_MESSAGE_TYPE !== 'group') {
        console.error(`[OneBot Notification] Invalid ONEBOT_MESSAGE_TYPE configured: '${ONEBOT_MESSAGE_TYPE}'. Must be 'private' or 'group'. Skipping.`);
        return;
    }
    console.log(`[OneBot Notification] Sending ${ONEBOT_MESSAGE_TYPE} notification to target ${ONEBOT_TARGET_ID} via ${ONEBOT_HTTP_URL}...`);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (ONEBOT_ACCESS_TOKEN) {
            headers['Authorization'] = `Bearer ${ONEBOT_ACCESS_TOKEN}`;
        }
        let action;
        let params;
        if (ONEBOT_MESSAGE_TYPE === 'private') {
            action = 'send_private_msg';
            params = {
                user_id: parseInt(ONEBOT_TARGET_ID, 10), // Convert ID to number
                message: message
            };
        }
        else { // ONEBOT_MESSAGE_TYPE === 'group'
            action = 'send_group_msg';
            params = {
                group_id: parseInt(ONEBOT_TARGET_ID, 10), // Convert ID to number
                message: message
            };
        }
        // Construct URL with action as path, removing potential trailing slash from base URL
        const requestUrl = `${ONEBOT_HTTP_URL.replace(/\/$/, '')}/${action}`;
        console.log(`[OneBot Notification] Sending POST to ${requestUrl}`);
        // Send params directly as the request body
        await axios.post(requestUrl, params, {
            headers,
            timeout: REQUEST_TIMEOUT / 2 // Use a shorter timeout for notifications
        });
        console.log('[OneBot Notification] Notification sent successfully.');
    }
    catch (error) {
        console.error(`[OneBot Notification] Failed to send notification:`, error.response?.data || error.message || error);
    }
}
/**
 * Sends a notification message using Telegram Bot API.
 */
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        // console.log('[Telegram Notification] Token or Chat ID not configured, skipping.');
        return;
    }
    console.log(`[Telegram Notification] Sending notification to Chat ID ${TELEGRAM_CHAT_ID}...`);
    try {
        const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' }); // Use Markdown for potential formatting
        console.log('[Telegram Notification] Notification sent successfully.');
    }
    catch (error) {
        console.error(`[Telegram Notification] Failed to send notification:`, error.response?.body || error.message || error);
    }
}
/**
 * Uploads a file to the Google File API.
 * Returns the file name (relative path) and full URI upon successful upload.
 */
async function uploadFileToGoogleApi(filePath, mimeType, displayName, fileSize) {
    console.log(`[uploadFileToGoogleApi] Starting upload for: ${filePath}, MIME: ${mimeType}, Size: ${fileSize} bytes`);
    // const stats = await fs.stat(filePath); // Size is already passed in
    const numBytes = fileSize;
    if (numBytes === 0) {
        throw new Error(`File is empty and cannot be uploaded: ${filePath}`);
    }
    const startUploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`;
    // 1. Start Resumable Upload
    console.log('[uploadFileToGoogleApi] Initiating resumable upload...');
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
            console.error('[uploadFileToGoogleApi] Failed to get upload URL from headers:', startResponse.headers);
            throw new Error('Failed to initiate resumable upload: No upload URL received.');
        }
        console.log('[uploadFileToGoogleApi] Got upload URL.');
    }
    catch (error) {
        const err = error;
        let message = 'Failed to initiate resumable upload.';
        if (err.response && err.message) {
            message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadFileToGoogleApi] Axios error initiating resumable upload:', err.response?.data || err.message);
        }
        else if (err.message) {
            message += ` Error: ${err.message}`;
            console.error('[uploadFileToGoogleApi] Error initiating resumable upload:', err.message);
        }
        else {
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
            timeout: REQUEST_TIMEOUT * 20,
        };
        const uploadResponse = await axios.post(uploadUrl, fileData, uploadConfig);
        if (uploadResponse.status !== 200 || !uploadResponse.data?.file?.uri || !uploadResponse.data?.file?.name) {
            console.error('[uploadFileToGoogleApi] File upload failed or URI/Name missing:', uploadResponse.data);
            throw new Error(`File upload failed with status ${uploadResponse.status}. Response: ${JSON.stringify(uploadResponse.data)}`);
        }
        // Return the relative name (files/xxx) and the full URI
        const { name, uri } = uploadResponse.data.file;
        console.log(`[uploadFileToGoogleApi] File uploaded successfully. Name: ${name}, URI: ${uri}`);
        return { name, uri };
    }
    catch (error) {
        const err = error;
        let message = 'Failed to upload file data.';
        if (err.response && err.message) {
            message += ` Axios Error: ${err.message} - ${JSON.stringify(err.response?.data)}`;
            console.error('[uploadFileToGoogleApi] Axios error uploading file data:', err.response?.data || err.message);
        }
        else if (err.message) {
            message += ` Error: ${err.message}`;
            console.error('[uploadFileToGoogleApi] Error uploading file data:', err.message);
        }
        else {
            console.error('[uploadFileToGoogleApi] Unknown error uploading file data:', error);
        }
        throw new Error(message);
    }
}
/**
 * Polls the Google File API for the status of a file until it's ACTIVE or failed/timed out.
 * Sends notifications upon successful activation if configured, including original source and timestamp.
 * Requires mimeType for the notification message.
 */
async function pollFileStatusAndNotify(fileName, fullUri, mimeType, originalSource) {
    console.log(`[pollFileStatus] Starting polling for file: ${fileName} (URI: ${fullUri}, Original: ${originalSource})`);
    const getFileUrl = `${GEMINI_API_URL}/v1beta/${fileName}?key=${GEMINI_API_KEY}`; // Use relative name for polling URL
    let attempts = 0;
    let apiUpdateTime; // To store the success timestamp from API
    while (attempts < MAX_FILE_POLLING_ATTEMPTS) {
        attempts++;
        console.log(`[pollFileStatus] Polling status for ${fileName} (Attempt ${attempts}/${MAX_FILE_POLLING_ATTEMPTS})...`);
        try {
            const response = await axios.get(getFileUrl, { timeout: REQUEST_TIMEOUT });
            const fileState = response.data?.state;
            console.log(`[pollFileStatus] File ${fileName} state: ${fileState}`);
            if (fileState === 'ACTIVE') {
                apiUpdateTime = response.data.updateTime; // Capture the update time
                console.log(`[pollFileStatus] File ${fileName} is ACTIVE. Update Time: ${apiUpdateTime}`);
                // Send notifications now that the file is ready, re-adding emojis
                const successTime = apiUpdateTime ? new Date(apiUpdateTime).toLocaleString() : 'N/A';
                const notificationMessage = `✅ File ready for Gemini:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\`\nReady At: \`${successTime}\``;
                await sendOneBotNotification(notificationMessage);
                await sendTelegramNotification(notificationMessage);
                return; // Success
            }
            else if (fileState === 'FAILED') {
                apiUpdateTime = response.data.updateTime; // Capture update time even on failure
                console.error(`[pollFileStatus] File ${fileName} processing failed. Response:`, response.data);
                const failureTime = apiUpdateTime ? new Date(apiUpdateTime).toLocaleString() : 'N/A';
                const failureMessage = `❌ File processing failed:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\`\nFailed At: \`${failureTime}\``;
                await sendOneBotNotification(failureMessage);
                await sendTelegramNotification(failureMessage);
                throw new Error(`Processing failed for file ${fileName}.`);
            }
            else if (fileState === 'PROCESSING') {
                // Continue polling
                console.log(`[pollFileStatus] File ${fileName} is still PROCESSING.`);
            }
            else {
                console.warn(`[pollFileStatus] File ${fileName} has unexpected state: ${fileState}. Continuing polling.`);
            }
        }
        catch (pollError) {
            const err = pollError;
            // Don't throw immediately on poll error, just log and retry
            console.error(`[pollFileStatus] Error polling status for ${fileName} (Attempt ${attempts}):`, err.response?.data || err.message || pollError);
        }
        // Check timeout condition *after* potential error logging
        // Check timeout condition *after* potential error logging
        if (attempts >= MAX_FILE_POLLING_ATTEMPTS) {
            console.error(`[pollFileStatus] Polling timed out for file ${fileName} after ${MAX_FILE_POLLING_ATTEMPTS} attempts.`);
            const timeoutMessage = `⏳ Polling timed out for file:\nOriginal: \`${originalSource}\`\nURI: \`${fullUri}\`\nMIME Type: \`${mimeType}\``; // Re-add emoji
            await sendOneBotNotification(timeoutMessage);
            await sendTelegramNotification(timeoutMessage);
            throw new Error(`Polling timed out for file ${fileName}. It did not become ACTIVE.`);
        }
        await delay(FILE_POLLING_INTERVAL_MS);
    }
}
/**
 * Handles the media understanding tool request for multiple files.
 */
export async function handleUnderstandMedia(params, axiosInstance) {
    const { text, files } = params;
    const tempSubDir = 'tmp';
    const processedFiles = []; // Store info for final Gemini call
    const cleanupPaths = []; // Local paths to delete after use
    // Store more info for polling/notification
    const filesToPollAndNotify = [];
    try {
        console.log(`[understandMedia] Received request with text: "${text}" and ${files.length} file(s).`);
        // --- 1. Process each file input ---
        const processingPromises = files.map(async (fileSource, index) => {
            const originalSource = fileSource.url || fileSource.path || fileSource.file_uri || `unknown_file_${index}`;
            let mimeType = fileSource.mime_type;
            let localFilePath = null;
            let isTemp = false;
            let fileSize = 0;
            console.log(`[understandMedia] Processing file ${index + 1}: ${originalSource}`);
            // --- A. Handle pre-uploaded file_uri ---
            if (fileSource.file_uri && mimeType) {
                console.log(`[understandMedia] Using pre-uploaded file URI: ${fileSource.file_uri}`);
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported MIME type '${mimeType}' for pre-uploaded file: ${originalSource}.`);
                }
                // Pre-uploaded files always use the File API approach in the final request
                processedFiles.push({
                    type: 'file_api',
                    mimeType: mimeType,
                    originalSource: originalSource,
                    fullUri: fileSource.file_uri, // The input is the full URI
                    // Extract relative name if possible, for consistency (though not strictly needed for polling here)
                    name: fileSource.file_uri.split('/').pop() ? `files/${fileSource.file_uri.split('/').pop()}` : undefined
                });
                // No polling needed here as it's assumed to be ACTIVE if provided.
                // No size check needed.
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
                }
                else {
                    // It's a regular URL, proceed with download and processing
                    console.log(`[understandMedia] Downloading media from URL: ${url}`);
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
                    }
                    else {
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
                    // Get file size
                    const stats = await fs.stat(localFilePath);
                    fileSize = stats.size;
                    if (fileSize === 0) {
                        throw new Error(`Downloaded file is empty: ${localFilePath}`);
                    }
                    console.log(`[understandMedia] File size: ${fileSize} bytes for ${localFilePath}`);
                    // --- Decide: Inline vs. File API for downloaded file ---
                    if (fileSize <= MAX_INLINE_FILE_SIZE_BYTES) {
                        console.log(`[understandMedia] File size (${fileSize} bytes) is within limit. Using inline data.`);
                        const fileData = await fs.readFile(localFilePath);
                        const base64Data = fileData.toString('base64');
                        processedFiles.push({
                            type: 'inline',
                            mimeType: mimeType,
                            originalSource: originalSource,
                            base64Data: base64Data
                        });
                    }
                    else {
                        console.log(`[understandMedia] File size (${fileSize} bytes) exceeds limit. Uploading via File API.`);
                        const displayName = path.basename(localFilePath);
                        const uploadResult = await uploadFileToGoogleApi(localFilePath, mimeType, displayName, fileSize);
                        processedFiles.push({
                            type: 'file_api',
                            mimeType: mimeType,
                            originalSource: originalSource,
                            name: uploadResult.name,
                            fullUri: uploadResult.uri
                        });
                        filesToPollAndNotify.push({
                            name: uploadResult.name,
                            fullUri: uploadResult.uri,
                            mimeType: mimeType,
                            originalSource: originalSource
                        });
                    }
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
                // Get file size
                const stats = await fs.stat(localFilePath);
                fileSize = stats.size;
                if (fileSize === 0) {
                    throw new Error(`File is empty: ${localFilePath}`);
                }
                console.log(`[understandMedia] File size: ${fileSize} bytes for ${localFilePath}`);
                // --- Decide: Inline vs. File API ---
                if (fileSize <= MAX_INLINE_FILE_SIZE_BYTES) {
                    // Use Inline Data
                    console.log(`[understandMedia] File size (${fileSize} bytes) is within limit (${MAX_INLINE_FILE_SIZE_BYTES} bytes). Using inline data.`);
                    const fileData = await fs.readFile(localFilePath);
                    const base64Data = fileData.toString('base64');
                    processedFiles.push({
                        type: 'inline',
                        mimeType: mimeType,
                        originalSource: originalSource,
                        base64Data: base64Data
                    });
                    // No polling needed for inline data
                }
                else {
                    // Use File API (Upload)
                    console.log(`[understandMedia] File size (${fileSize} bytes) exceeds limit (${MAX_INLINE_FILE_SIZE_BYTES} bytes). Uploading via File API.`);
                    const displayName = path.basename(localFilePath);
                    const uploadResult = await uploadFileToGoogleApi(localFilePath, mimeType, displayName, fileSize);
                    processedFiles.push({
                        type: 'file_api',
                        mimeType: mimeType,
                        originalSource: originalSource,
                        name: uploadResult.name, // Relative name
                        fullUri: uploadResult.uri // Full URI
                    });
                    // Mark this file for polling *after* upload completes, including original source
                    filesToPollAndNotify.push({
                        name: uploadResult.name,
                        fullUri: uploadResult.uri,
                        mimeType: mimeType,
                        originalSource: originalSource // Pass original source for notification
                    });
                }
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
        // --- 2. Poll for ACTIVE status and Notify for files uploaded via API ---
        if (filesToPollAndNotify.length > 0) {
            console.log(`[understandMedia] Polling status for ${filesToPollAndNotify.length} newly uploaded file(s)...`);
            const pollingPromises = filesToPollAndNotify.map(fileInfo => 
            // Pass originalSource to the polling function
            pollFileStatusAndNotify(fileInfo.name, fileInfo.fullUri, fileInfo.mimeType, fileInfo.originalSource));
            await Promise.all(pollingPromises); // Wait for all polling and notifications to complete or fail
            console.log(`[understandMedia] Polling and notification process completed for all uploaded files.`);
        }
        else {
            console.log(`[understandMedia] No new files were uploaded via File API, skipping polling and notifications.`);
        }
        // --- 3. Call Gemini Generate Content ---
        const generateContentUrl = `/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        // Construct the parts array, mixing inline_data and file_data as needed
        const requestParts = [
            { text: text }, // Always include the text prompt first
            ...processedFiles.map(fileInfo => {
                if (fileInfo.type === 'inline') {
                    // Ensure mimeType and base64Data are present for inline type
                    if (!fileInfo.mimeType || !fileInfo.base64Data) {
                        throw new Error(`Internal error: Missing mimeType or base64Data for inline file: ${fileInfo.originalSource}`);
                    }
                    return { inline_data: { mime_type: fileInfo.mimeType, data: fileInfo.base64Data } };
                }
                else if (fileInfo.type === 'file_api') {
                    // Ensure mimeType and fullUri are present for file_api type
                    if (!fileInfo.mimeType || !fileInfo.fullUri) {
                        throw new Error(`Internal error: Missing mimeType or fullUri for file_api file: ${fileInfo.originalSource}`);
                    }
                    return { file_data: { mime_type: fileInfo.mimeType, file_uri: fileInfo.fullUri } };
                }
                else { // type === 'youtube'
                    // Ensure youtubeUrl is present for youtube type
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
        const responseData = response.data;
        if (responseData.error) {
            console.error(`[understandMedia] Gemini API returned an error:`, responseData.error);
            throw new Error(`Gemini API error: ${responseData.error.message} (Status: ${responseData.error.status})`);
        }
        const generatedText = responseData.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n') || '';
        if (!generatedText && !responseData.candidates) {
            console.error('[understandMedia] Gemini response is missing candidates or text parts:', responseData);
            throw new Error('Invalid response structure from Gemini API.');
        }
        else if (!generatedText) {
            console.warn('[understandMedia] Gemini response did not contain text parts, but candidates exist.', responseData);
            return { content: [{ type: 'text', text: '(Model returned empty text content)' }] };
        }
        console.log('[understandMedia] Tool execution successful.');
        return { content: [{ type: 'text', text: generatedText }] };
    }
    catch (error) {
        console.error('[understandMedia] Error during media understanding:', error);
        let errorMessage = 'An unknown error occurred during media understanding.';
        const err = error;
        if (err.response && err.message) {
            const responseInfo = err.response ? ` Status: ${err.response.status}. Data: ${JSON.stringify(err.response.data)}` : 'No response data.';
            errorMessage = `API request failed: ${err.message}.${responseInfo}`;
        }
        else if (error instanceof Error) {
            errorMessage = error.message;
        }
        else if (err.message) {
            errorMessage = err.message;
        }
        else {
            errorMessage = `Caught non-standard error: ${String(error)}`;
        }
        return { content: [{ type: 'text', text: `Error understanding media: ${errorMessage}` }] };
    }
    finally {
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
                }
                else {
                    console.log(`[understandMedia] Successfully cleaned up ${cleanupPaths[index]}`);
                }
            });
        }
    }
}
//# sourceMappingURL=understandMedia.js.map