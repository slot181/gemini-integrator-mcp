import { z } from 'zod';
import axios from 'axios'; // Default import
import * as path from 'path';
import * as fs from 'fs/promises';
import * as mime from 'mime-types';
import { GEMINI_API_KEY, GEMINI_API_URL, GEMINI_UNDERSTANDING_MODEL, REQUEST_TIMEOUT, DEFAULT_OUTPUT_DIR } from '../config.js';
import { deleteFile, downloadFile } from '../utils/fileUtils.js';
// --- Helper function to delay execution ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// --- Polling Configuration ---
const FILE_POLLING_INTERVAL_MS = 2000; // Check every 2 seconds
const MAX_FILE_POLLING_ATTEMPTS = 24; // Max attempts (e.g., 36 * 5s = 3 minutes timeout)
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
// Set of supported MIME types based on user feedback and Gemini docs
const SUPPORTED_MIME_TYPES = new Set([
    // Video
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
    'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
    // Audio (Removed audio/mpeg, keeping audio/mp3)
    'audio/wav', 'audio/mp3',
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
    'text/rtf', 'application/rtf'
]);
/**
 * Uploads a file to the Google File API using the global axios instance.
 * Returns the file name and URI upon successful upload.
 */
async function uploadFileToGoogleApi(filePath, mimeType, displayName) {
    console.log(`[uploadFileToGoogleApi] Starting upload for: ${filePath}, MIME: ${mimeType}`);
    const stats = await fs.stat(filePath);
    const numBytes = stats.size;
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
            timeout: REQUEST_TIMEOUT * 5,
        };
        const uploadResponse = await axios.post(uploadUrl, fileData, uploadConfig);
        if (uploadResponse.status !== 200 || !uploadResponse.data?.file?.uri || !uploadResponse.data?.file?.name) {
            console.error('[uploadFileToGoogleApi] File upload failed or URI/Name missing:', uploadResponse.data);
            throw new Error(`File upload failed with status ${uploadResponse.status}. Response: ${JSON.stringify(uploadResponse.data)}`);
        }
        const { name, uri } = uploadResponse.data.file;
        console.log(`[uploadFileToGoogleApi] File uploaded successfully. Name: ${name}, URI: ${uri}`);
        return { name, uri }; // Return both name and uri
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
 */
async function pollFileStatus(fileName) {
    console.log(`[pollFileStatus] Starting polling for file: ${fileName}`);
    const getFileUrl = `${GEMINI_API_URL}/v1beta/${fileName}?key=${GEMINI_API_KEY}`; // Use GEMINI_API_URL base
    let attempts = 0;
    while (attempts < MAX_FILE_POLLING_ATTEMPTS) {
        attempts++;
        console.log(`[pollFileStatus] Polling status for ${fileName} (Attempt ${attempts}/${MAX_FILE_POLLING_ATTEMPTS})...`);
        try {
            const response = await axios.get(getFileUrl, { timeout: REQUEST_TIMEOUT });
            const fileState = response.data?.state;
            console.log(`[pollFileStatus] File ${fileName} state: ${fileState}`);
            if (fileState === 'ACTIVE') {
                console.log(`[pollFileStatus] File ${fileName} is ACTIVE.`);
                return; // Success
            }
            else if (fileState === 'FAILED') {
                console.error(`[pollFileStatus] File ${fileName} processing failed. Response:`, response.data);
                throw new Error(`Processing failed for file ${fileName}.`);
            }
            // Continue polling if state is PROCESSING or unspecified/null
        }
        catch (pollError) {
            const err = pollError;
            // Log polling error but continue polling unless max attempts reached
            console.error(`[pollFileStatus] Error polling status for ${fileName}:`, err.response?.data || err.message || pollError);
            // Optional: Implement backoff strategy here if needed
        }
        if (attempts >= MAX_FILE_POLLING_ATTEMPTS) {
            console.error(`[pollFileStatus] Polling timed out for file ${fileName} after ${MAX_FILE_POLLING_ATTEMPTS} attempts.`);
            throw new Error(`Polling timed out for file ${fileName}. It did not become ACTIVE.`);
        }
        await delay(FILE_POLLING_INTERVAL_MS); // Wait before next poll
    }
}
/**
 * Handles the media understanding tool request for multiple files.
 */
export async function handleUnderstandMedia(params, axiosInstance // Use 'any' type like other tools
) {
    const { text, files } = params;
    const tempSubDir = 'tmp';
    const processedFiles = [];
    const cleanupPaths = [];
    try {
        console.log(`[understandMedia] Received request with text: "${text}" and ${files.length} file(s).`);
        // --- 1. Process and Upload each file input ---
        const uploadPromises = files.map(async (fileSource) => {
            let localFilePath = null;
            let isTemp = false;
            const originalSource = fileSource.url || fileSource.path || 'unknown';
            try {
                if (fileSource.url) {
                    console.log(`[understandMedia] Downloading media from URL: ${fileSource.url}`);
                    localFilePath = await downloadFile(fileSource.url, DEFAULT_OUTPUT_DIR, tempSubDir, 'downloaded_media');
                    isTemp = true;
                    cleanupPaths.push(localFilePath);
                    console.log(`[understandMedia] Media downloaded to: ${localFilePath}`);
                }
                else if (fileSource.path) {
                    await fs.access(fileSource.path);
                    localFilePath = path.resolve(fileSource.path);
                    console.log(`[understandMedia] Using local file: ${localFilePath}`);
                }
                if (!localFilePath)
                    throw new Error(`Invalid file source object: ${JSON.stringify(fileSource)}`);
                let mimeType = mime.lookup(localFilePath);
                if (!mimeType)
                    throw new Error(`Could not determine MIME type for file: ${localFilePath}`);
                const fileExt = path.extname(localFilePath).toLowerCase();
                if (fileExt === '.mp3' && mimeType === 'audio/mpeg') {
                    console.log(`[understandMedia] Correcting MIME type for .mp3 file from 'audio/mpeg' to 'audio/mp3'.`);
                    mimeType = 'audio/mp3';
                }
                if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
                    throw new Error(`Unsupported file type '${mimeType}' for file: ${localFilePath}.`);
                }
                console.log(`[understandMedia] Validated MIME type: ${mimeType} for ${localFilePath}`);
                const displayName = path.basename(localFilePath);
                const { name, uri } = await uploadFileToGoogleApi(localFilePath, mimeType, displayName); // Get name and uri
                return { name, uri, mimeType, originalSource }; // Return ProcessedFileInfo structure
            }
            catch (error) {
                // Clean up temp file if download/processing failed for this specific file
                if (isTemp && localFilePath) {
                    await deleteFile(localFilePath).catch(e => console.error(`[understandMedia] Error cleaning up temp file ${localFilePath} after error:`, e));
                    // Remove from cleanupPaths if we delete it here
                    const index = cleanupPaths.indexOf(localFilePath);
                    if (index > -1)
                        cleanupPaths.splice(index, 1);
                }
                console.error(`[understandMedia] Failed to process file source ${originalSource}:`, error);
                // Re-throw to stop processing if one file fails? Or collect errors? Let's re-throw for now.
                throw new Error(`Failed to process file ${originalSource}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        // Wait for all uploads to complete
        const uploadResults = await Promise.all(uploadPromises);
        processedFiles.push(...uploadResults); // Add successful results
        if (processedFiles.length !== files.length) {
            // This case might not be reached if Promise.all rejects on first error
            throw new Error("Some files failed during processing or upload.");
        }
        if (processedFiles.length === 0) {
            throw new Error("No files were successfully processed for upload.");
        }
        // --- 2. Poll for ACTIVE status for all uploaded files ---
        console.log(`[understandMedia] Polling status for ${processedFiles.length} uploaded file(s)...`);
        const pollingPromises = processedFiles.map(fileInfo => pollFileStatus(fileInfo.name));
        await Promise.all(pollingPromises); // Wait for all files to become ACTIVE
        console.log(`[understandMedia] All files are ACTIVE.`);
        // --- 3. Call Gemini Generate Content ---
        const generateContentUrl = `/v1beta/models/${GEMINI_UNDERSTANDING_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const requestParts = [
            { text: text },
            ...processedFiles.map(fileInfo => ({
                file_data: { mime_type: fileInfo.mimeType, file_uri: fileInfo.uri }
            }))
        ];
        const requestPayload = { contents: [{ parts: requestParts }] };
        console.log(`[understandMedia] Calling Gemini (${GEMINI_UNDERSTANDING_MODEL}) with ${processedFiles.length} file(s)... URL: ${axiosInstance.defaults.baseURL}${generateContentUrl}`);
        const response = await axiosInstance.post(generateContentUrl, requestPayload, { timeout: REQUEST_TIMEOUT });
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
            const results = await Promise.allSettled(cleanupPaths.map(tempPath => deleteFile(tempPath)));
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`[understandMedia] Failed to clean up downloaded file ${cleanupPaths[index]}:`, result.reason);
                }
            });
        }
    }
}
//# sourceMappingURL=understandMedia.js.map